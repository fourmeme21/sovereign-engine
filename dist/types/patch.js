/**
 * Sovereign Engine OS — Patch Object
 * @module core/types/patch
 *
 * CLI katmanının giriş tipi — patch.json dosyasının şeması.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.3 okunmalıdır.
 *
 * Şema Kısıtları (ARCHITECTURE.md §2.3):
 *   - schema_version eksik       → REJECT
 *   - Herhangi bir alan eksik    → REJECT
 *   - operations boş dizi        → REJECT
 *   - search metni bulunamazsa   → REJECT
 *   - confidence < 0 veya > 1    → REJECT
 */
// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------
/** Patch tipini doğrular (runtime şema kontrolü). */
export function isPatch(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const p = value;
    if (p["schema_version"] !== "1.0")
        return false;
    if (typeof p["intent"] !== "string")
        return false;
    if (typeof p["risk_level"] !== "string")
        return false;
    if (typeof p["confidence"] !== "number")
        return false;
    if (typeof p["patch"] !== "object" || p["patch"] === null)
        return false;
    const patch = p["patch"];
    if (typeof patch["file"] !== "string")
        return false;
    if (!Array.isArray(patch["operations"]))
        return false;
    return true;
}
/** Confidence değeri geçerli aralıkta mı? */
export function isConfidenceValid(confidence) {
    return confidence >= 0 && confidence <= 1;
}
/** Operations dizisi geçerli mi? */
export function isOperationsValid(patch) {
    return (patch.patch.operations.length > 0 &&
        patch.patch.operations.every((op) => typeof op.search === "string" &&
            op.search.length > 0 &&
            typeof op.replace === "string"));
}
//# sourceMappingURL=patch.js.map