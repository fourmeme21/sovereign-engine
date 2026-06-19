/**
 * Sovereign Engine OS — Decision Object
 * @module core/types/decision
 *
 * ROOT TYPE — tüm sistem tipleri bu tipe bağımlıdır.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.1 okunmalıdır.
 *
 * Şema Kısıtları (ARCHITECTURE.md §2.1):
 *   - schema_version eksik veya uyumsuz       → REJECT
 *   - category regex /^[A-Z_]+$/ uyumsuz      → REJECT
 *   - payload.action_name /^[a-z_]+$/ uyumsuz → REJECT
 *   - metadata.session_number ≤ 0             → REJECT
 *   - confidence=HIGH + self_check_passed=false → REJECT
 *   - risk_level=CRITICAL + confidence=HIGH   → REJECT
 *   - intent=MODIFY_STATE + risk_level≠CRITICAL → REJECT
 *   - assumed_state + intent∉{EXECUTE_ACTION,MODIFY_STATE} → REJECT
 */
// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------
/** Decision tipini doğrular (runtime şema kontrolü için). */
export function isDecision(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const d = value;
    return (d["schema_version"] === "1.0" &&
        typeof d["id"] === "string" &&
        typeof d["created_at"] === "string" &&
        typeof d["intent"] === "string" &&
        typeof d["category"] === "string" &&
        typeof d["payload"] === "object" &&
        typeof d["context"] === "object" &&
        typeof d["metadata"] === "object" &&
        typeof d["status"] === "string");
}
/** Kilitli (immutable) durumda olup olmadığını kontrol eder. */
export function isImmutableStatus(status) {
    return status === "COMPLETED" || status === "REJECTED" || status === "BLOCKED";
}
/** MODIFY_STATE intent'i için risk seviyesi CRITICAL mi? */
export function isModifyStateValid(decision) {
    if (decision.intent === "MODIFY_STATE") {
        return decision.context.risk_level === "CRITICAL";
    }
    return true;
}
/** assumed_state kullanımı geçerli mi? */
export function isAssumedStateValid(decision) {
    if (decision.payload.assumed_state !== undefined) {
        return (decision.intent === "EXECUTE_ACTION" ||
            decision.intent === "MODIFY_STATE");
    }
    return true;
}
//# sourceMappingURL=decision.js.map