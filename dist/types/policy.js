/**
 * Sovereign Engine OS — Policy Result
 * @module core/types/policy
 *
 * Katman 3 (Policy Kernel / Rust) çıktı tipi.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.4 okunmalıdır.
 *
 * Kurallar:
 *   - DENY veya BLOCK → redirect alanı zorunlu, boş olamaz (soft steer)
 *   - execution_token → SADECE PERMIT'te bulunur
 *   - priority > 0 olmalı (NON_POSITIVE_VALUE)
 */
// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------
/** PolicyResult tipini doğrular. */
export function isPolicyResult(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const r = value;
    return (typeof r["decision"] === "string" &&
        typeof r["priority"] === "number");
}
/** PERMIT kararı mı? execution_token varlığını garanti eder. */
export function isPermit(result) {
    return result.decision === "PERMIT" && typeof result.execution_token === "string";
}
/** Bloklayan karar mı? (DENY veya BLOCK) */
export function isBlocking(result) {
    return ((result.decision === "DENY" || result.decision === "BLOCK") &&
        typeof result.redirect === "string" &&
        result.redirect.length > 0);
}
/** Priority değeri geçerli mi? */
export function isPriorityValid(priority) {
    return priority > 0;
}
//# sourceMappingURL=policy.js.map