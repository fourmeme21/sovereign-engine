/**
 * sort-keys.ts — RFC 8785 JCS uyumlu derin anahtar sıralama
 *
 * Kullanım alanları:
 *   - idempotency key üretimi (src/gate/idempotency.ts)
 *   - policy_hash hesaplama (Rust serde_jcs ile tutarlı)
 *   - ExecutionRequest canonical serialization
 *
 * KARAR #8: serde_jcs (Rust) ↔ sortKeysDeep (TS) çifti
 *   Her iki taraf da RFC 8785 JCS uyumlu canonical JSON üretmeli.
 *   Anahtar sırası: lexicographic (Unicode code point sırası).
 *   Array sırası korunur — sadece object key'leri sıralanır.
 */
/**
 * Verilen değerin tüm object key'lerini özyinelemeli olarak sıralar.
 * Primitive ve array değerleri değişmeden geçer.
 */
export declare function sortKeysDeep(value: unknown): unknown;
/**
 * Canonical JSON string üretir.
 * Rust tarafındaki `serde_jcs::to_string()` ile eşdeğer çıktı verir.
 *
 * @example
 * toCanonicalJson({ b: 2, a: 1 }) === '{"a":1,"b":2}'
 */
export declare function toCanonicalJson(value: unknown): string;
//# sourceMappingURL=sort-keys.d.ts.map