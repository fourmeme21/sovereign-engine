/**
 * Sovereign Engine OS — Execution Token (JWT Payload)
 * @module core/types/execution-token
 *
 * Policy Kernel PERMIT verdiğinde üretilen JWT'nin payload tipi.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.2 okunmalıdır.
 *
 * Token Özellikleri:
 *   - Algoritma : JWT HS256
 *   - Expiry    : issued_at + 30 saniye (TOCTOU koruması)
 *   - İmzalayan : sovereign-core binary içindeki secret
 *
 * Execution Gate Doğrulama Kuralları (ARCHITECTURE.md §2.2):
 *   1. İmza geçerli mi?              → Geçersizse DENY + LOG
 *   2. expires_at geçmedi mi?        → Geçmişse DENY + LOG (TOCTOU)
 *   3. decision_id eşleşiyor mu?     → Eşleşmiyorsa DENY + LOG
 *   4. policy_hash eşleşiyor mu?     → Eşleşmiyorsa DENY + LOG
 *   Herhangi biri başarısız → DENY + LOG + NO_SIDE_EFFECT
 */
/** JWT token expiry süresi (saniye). */
export const EXECUTION_TOKEN_EXPIRY_SECONDS = 30;
// ---------------------------------------------------------------------------
// Type Guards & Yardımcılar
// ---------------------------------------------------------------------------
/** ExecutionTokenPayload tipini doğrular. */
export function isExecutionTokenPayload(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const p = value;
    return (typeof p["decision_id"] === "string" &&
        typeof p["policy_hash"] === "string" &&
        typeof p["actor_id"] === "string" &&
        typeof p["action_name"] === "string" &&
        typeof p["issued_at"] === "number" &&
        typeof p["expires_at"] === "number" &&
        typeof p["scope"] === "string");
}
/**
 * Token süresi dolmuş mu?
 * true → EXPIRED_TOKEN → DENY + LOG (TOCTOU koruması)
 */
export function isTokenExpired(payload, nowSeconds) {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    return now >= payload.expires_at;
}
/**
 * Token scope'u Decision ile eşleşiyor mu?
 * Format kontrolü: "{category}:{action_name}"
 */
export function isScopeValid(payload, category, actionName) {
    return payload.scope === `${category}:${actionName}`;
}
/**
 * expires_at tutarlılığını kontrol eder.
 * expires_at === issued_at + 30 olmalı.
 */
export function isExpiryConsistent(payload) {
    return payload.expires_at === payload.issued_at + EXECUTION_TOKEN_EXPIRY_SECONDS;
}
//# sourceMappingURL=execution-token.js.map