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
export declare function buildIdempotencyKey(decision: {
    id: string;
    schema_version: string;
    intent: string;
    category: string;
    payload: unknown;
}, policyHash: string): string;
/**
 * Key daha önce başarıyla işlendiyse true döner.
 * TTL süresi dolmuşsa false döner (ve cache'den siler).
 */
export declare function checkIdempotency(key: string): boolean;
/**
 * Başarılı execution sonrasında key'i kaydet.
 *
 * Kapasiteye ulaşıldığında süresi dolmuş entryleri temizler.
 * Hepsi geçerliyse en eski eklenen silinir (FIFO fallback).
 */
export declare function markExecuted(key: string): void;
/**
 * Execution başarısız olduğunda (rolled_back) key'i temizle.
 * Yeniden deneme aynı key ile gelebilir.
 */
export declare function clearKey(key: string): void;
/**
 * Test / rollback senaryolarında tüm store'u temizle.
 */
export declare function clearIdempotencyStore(): void;
/**
 * Mevcut geçerli entry sayısını döner.
 * Test ve monitoring için.
 */
export declare function storeSize(): number;
//# sourceMappingURL=idempotency.d.ts.map