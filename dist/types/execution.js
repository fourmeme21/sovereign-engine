/**
 * Sovereign Engine OS — Execution Result
 * @module core/types/execution
 *
 * Katman 4 (Execution Gate / Rust) çıktı tipi.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.5 okunmalıdır.
 *
 * Kurallar:
 *   - success=false → rolled_back=true olmalı (atomik rollback zorunlu)
 *   - audit_hash her zaman bulunur — hash chain
 *   - AuditLog her zaman yazılır — başarı veya hata fark etmez
 */
// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------
/** ExecutionResult tipini doğrular. */
export function isExecutionResult(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const r = value;
    return (typeof r["bundle_id"] === "string" &&
        typeof r["decision_id"] === "string" &&
        typeof r["success"] === "boolean" &&
        typeof r["audit_hash"] === "string" &&
        typeof r["timestamp"] === "string");
}
/**
 * Başarısız execution rollback tutarlılığını kontrol eder.
 * success=false iken rolled_back=true olmalı.
 */
export function isRollbackConsistent(result) {
    if (!result.success) {
        return result.rolled_back === true;
    }
    return true;
}
//# sourceMappingURL=execution.js.map