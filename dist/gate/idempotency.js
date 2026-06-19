/**
 * idempotency.ts — TypeScript tarafı idempotency koruma katmanı
 *
 * Rust execution_gate'teki moka cache ile çift katman koruma sağlar:
 *   - TS katmanı: Rust binary'ye gereksiz IPC engellemek için erken kontrol
 *   - Rust katmanı: Nihai garanti (crash sonrası yeniden başlamada geçerli)
 *
 * SAP-05 Fix: TTL 300s → 30s (execution_token süresiyle senkron — ARCHITECTURE.md §5)
 * SAP-06 Fix: buildIdempotencyKey'e window alanı eklendi — TTL penceresi dolunca
 *             aynı karar yeni key üretir, replay koruması sağlanır
 *
 * Max entry: 1_000 (solo operator ölçeği)
 * Depolama: in-process Map — dağıtık sistem için Redis gerekir (ARCHITECTURE.md §8)
 */
import { createHash } from 'node:crypto';
import { toCanonicalJson } from '../utils/sort-keys.js';
// ─── STORE ───────────────────────────────────────────────────────────────────
/**
 * SAP-05: TTL 30 saniye — execution_token süresiyle senkron.
 * CORE.md §9: "Token süresi (30s) dolarsa Execution Gate DENY döner"
 * Önceki değer 300s (5 dakika) idi — ARCHITECTURE.md §5 ile çelişiyordu.
 */
const TTL_MS = 30 * 1_000; // 30 saniye
const MAX_ENTRIES = 1_000;
const store = new Map();
// ─── PUBLIC API ──────────────────────────────────────────────────────────────
/**
 * SAP-06: decision + policyHash + window'dan deterministik idempotency key üretir.
 *
 * SHA-256(canonical({ id, schema_version, intent, category, payload, policyHash, window }))
 *
 * window alanı:
 *   Math.floor(Date.now() / TTL_MS) — her 30 saniyede bir yeni pencere.
 *   TTL dolunca aynı decision farklı key üretir → yeniden deneme mümkün.
 *   Pencere içindeyken aynı key → idempotency koruması aktif.
 *
 * Rust tarafındaki decision.id tabanlı key ile uyumlu:
 *   - id farklıysa farklı key → doğru davranış
 *   - Aynı payload, farklı policy_hash → farklı key (replay koruması)
 *   - Aynı her şey, farklı window → farklı key (TTL sonrası yeniden deneme)
 */
export function buildIdempotencyKey(decision, policyHash) {
    // SAP-06: Zaman penceresi — her TTL_MS'de bir yeni slot
    const windowSlot = Math.floor(Date.now() / TTL_MS);
    const canonical = toCanonicalJson({
        id: decision.id,
        schema_version: decision.schema_version,
        intent: decision.intent,
        category: decision.category,
        payload: decision.payload,
        policyHash,
        window: windowSlot, // SAP-06: eklendi — pencere bazlı replay koruması
    });
    return createHash('sha256').update(canonical).digest('hex');
}
/**
 * Key daha önce başarıyla işlendiyse true döner.
 * TTL süresi dolmuşsa false döner (ve cache'den siler).
 */
export function checkIdempotency(key) {
    const entry = store.get(key);
    if (!entry)
        return false;
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
export function markExecuted(key) {
    if (store.size >= MAX_ENTRIES) {
        evictExpired();
        // Hâlâ doluysa en eski entry'yi çıkar (FIFO)
        if (store.size >= MAX_ENTRIES) {
            const firstKey = store.keys().next().value;
            if (firstKey !== undefined)
                store.delete(firstKey);
        }
    }
    store.set(key, { key, expiresAt: Date.now() + TTL_MS });
}
/**
 * Execution başarısız olduğunda (rolled_back) key'i temizle.
 * Yeniden deneme aynı key ile gelebilir.
 */
export function clearKey(key) {
    store.delete(key);
}
/**
 * Test / rollback senaryolarında tüm store'u temizle.
 */
export function clearIdempotencyStore() {
    store.clear();
}
/**
 * Mevcut geçerli entry sayısını döner.
 * Test ve monitoring için.
 */
export function storeSize() {
    evictExpired();
    return store.size;
}
// ─── ÖZEL ────────────────────────────────────────────────────────────────────
function evictExpired() {
    const now = Date.now();
    for (const [k, v] of store) {
        if (now > v.expiresAt)
            store.delete(k);
    }
}
//# sourceMappingURL=idempotency.js.map