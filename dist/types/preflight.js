/**
 * Sovereign Engine OS — PreFlight Result
 * @module core/types/preflight
 *
 * Katman 2 (Validation Engine) pre-flight read çıktısı.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.6 okunmalıdır.
 *
 * Amaç: assumed_state'in hâlâ geçerli olup olmadığını doğrular.
 * Bayatlamışsa RE_EVALUATE tetiklenir — max 3 kez, sonra ASK_HUMAN.
 */
/** Maximum RE_EVALUATE tekrar sayısı — aşılırsa ASK_HUMAN'a düşer. */
export const MAX_RE_EVALUATE_COUNT = 3;
// ---------------------------------------------------------------------------
// Type Guards & Yardımcılar
// ---------------------------------------------------------------------------
/** PreFlightResult tipini doğrular. */
export function isPreFlightResult(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const r = value;
    return typeof r["clear"] === "boolean";
}
/**
 * RE_EVALUATE sayısı maksimuma ulaştı mı?
 * true → ASK_HUMAN'a düşmeli.
 */
export function shouldEscalateToHuman(result) {
    return (result.reason === "RE_EVALUATE" &&
        typeof result.retry_count === "number" &&
        result.retry_count >= MAX_RE_EVALUATE_COUNT);
}
/** Pre-flight geçti mi ve devam edilebilir mi? */
export function isPreFlightClear(result) {
    return result.clear === true;
}
//# sourceMappingURL=preflight.js.map