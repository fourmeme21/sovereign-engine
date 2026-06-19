/**
 * Sovereign Engine OS — Execution Gate Köprüsü
 * @module src/gate/execution-bridge
 *
 * TypeScript → Rust binary (sovereign-core execute modu) iletişim katmanı.
 * ARCHITECTURE.md §3.4 — Execution Gate protokolü.
 *
 * SAP-09: Bu dosya eksikti. kernel-bridge.ts (policy modu) ile aynı
 * pattern'da yazıldı — sadece "execute" modu ve ExecutionGateInput/Result
 * tipleri kullanılır.
 *
 * Fail-closed garantisi:
 *   - Timeout      → success: false + rolled_back: true
 *   - Binary crash → success: false + rolled_back: true
 *   - JSON parse   → success: false + rolled_back: true
 *   - Boş stdout   → success: false + rolled_back: true
 *   Herhangi bir hata → DENY + LOG — asla PERMIT değil.
 *
 * Execution Gate Doğrulama Zinciri (ARCHITECTURE.md §2.2):
 *   1. execution_token imzası geçerli mi?
 *   2. expires_at geçmedi mi?         (TOCTOU koruması — 30s)
 *   3. decision_id eşleşiyor mu?
 *   4. policy_hash eşleşiyor mu?
 *   Herhangi biri başarısız → DENY + LOG + NO_SIDE_EFFECT
 */
import type { Decision } from "../types/decision.js";
import type { ExecutionResult } from "../types/execution.js";
export type GateBridgeStatus = "SUCCESS" | "FAILED" | "DENIED" | "ERROR";
export interface GateBridgeResult {
    status: GateBridgeStatus;
    execution_result?: ExecutionResult;
    error?: string;
    duration_ms: number;
}
export interface ExecutionGateInput {
    readonly decision: Decision;
    readonly execution_token: string;
}
/**
 * Decision + execution_token'ı Rust Execution Gate'e gönderir.
 *
 * Fail-closed garantisi:
 *   - Timeout      → GateBridgeStatus "ERROR" + success: false
 *   - Binary crash → GateBridgeStatus "ERROR" + success: false
 *   - JSON parse   → GateBridgeStatus "ERROR" + success: false
 *
 * TOCTOU: execution_token 30 saniyede expire olur.
 * Rust Execution Gate token expiry'yi kendi doğrular.
 * TypeScript TOCTOU için isTokenExpired() ile ön kontrol yapabilir.
 *
 * @param input - Decision + execution_token çifti
 */
export declare function callExecutionGate(input: ExecutionGateInput): Promise<GateBridgeResult>;
/**
 * Execution Gate binary'nin erişilebilir olduğunu doğrular.
 * kernel-bridge.ts healthCheck() ile aynı binary kontrol edilir.
 * Ayrı çağrı — execution modunu test etmez, sadece binary varlığını kontrol eder.
 */
export declare function executionGateHealthCheck(): Promise<boolean>;
//# sourceMappingURL=execution-bridge.d.ts.map