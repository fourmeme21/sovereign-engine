/**
 * idempotency.ts — TypeScript tarafı idempotency koruma katmanı
 *
 * Rust execution_gate'teki moka cache ile çift katman koruma sağlar:
 *   - TS katmanı: Rust binary'ye gereksiz IPC engellemek için erken kontrol
 *   - Rust katmanı: Nihai garanti (crash sonrası yeniden başlamada geçerli)
 *
 * TTL: 5 dakika (Rust tarafıyla senkron — ARCHITECTURE.md §5)
 * Max entry: 1_000 (solo operator ölçeği)
 * Depolama: in-process Map — dağıtık sistem için Redis gerekir (ARCHITECTURE.md §8)
 */

import { createHash } from 'node:crypto';
import { toCanonicalJson } from '../utils/sort-keys.js';

// ─── TİPLER ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  expiresAt: number;
}

// ─── STORE ───────────────────────────────────────────────────────────────────

const TTL_MS = 5 * 60 * 1_000; // 5 dakika
const MAX_ENTRIES = 1_000;

const store = new Map<string, CacheEntry>();

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

/**
 * decision + policyHash'ten deterministik idempotency key üretir.
 *
 * SHA-256(canonical({ id, schema_version, intent, category, payload, policyHash }))
 *
 * Rust tarafındaki decision.id tabanlı key ile uyumlu:
 *   - id farklıysa farklı key → doğru davranış
 *   - Aynı payload, farklı policy_hash → farklı key (replay koruması)
 */
export function buildIdempotencyKey(
  decision: {
    id: string;
    schema_version: string;
    intent: string;
    category: string;
    payload: unknown;
  },
  policyHash: string,
): string {
  const canonical = toCanonicalJson({
    id: decision.id,
    schema_version: decision.schema_version,
    intent: decision.intent,
    category: decision.category,
    payload: decision.payload,
    policyHash,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Key daha önce başarıyla işlendiyse true döner.
 * TTL süresi dolmuşsa false döner (ve cache'den siler).
 */
export function checkIdempotency(key: string): boolean {
  const entry = store.get(key);
  if (!entry) return false;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return false;
  }

  return true;
}

/**
 * Başarılı execution sonrasında key'i kaydet.
 *
 * Kapasiteye ulaşıldığında süresi dolmuş entryleri temizler.
 * Hepsi geçerliyse en eski eklenen silinir (FIFO fallback).
 */
export function markExecuted(key: string): void {
  if (store.size >= MAX_ENTRIES) {
    evictExpired();

    // Hâlâ doluysa en eski entry'yi çıkar (FIFO)
    if (store.size >= MAX_ENTRIES) {
      const firstKey = store.keys().next().value;
      if (firstKey !== undefined) store.delete(firstKey);
    }
  }

  store.set(key, { key, expiresAt: Date.now() + TTL_MS });
}

/**
 * Execution başarısız olduğunda (rolled_back) key'i temizle.
 * Yeniden deneme aynı key ile gelebilir.
 */
export function clearKey(key: string): void {
  store.delete(key);
}

/**
 * Test / rollback senaryolarında tüm store'u temizle.
 */
export function clearIdempotencyStore(): void {
  store.clear();
}

/**
 * Mevcut geçerli entry sayısını döner.
 * Test ve monitoring için.
 */
export function storeSize(): number {
  evictExpired();
  return store.size;
}

// ─── ÖZEL ────────────────────────────────────────────────────────────────────

function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
}
