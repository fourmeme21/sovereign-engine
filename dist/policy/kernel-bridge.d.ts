/**
 * Sovereign Engine OS — Policy Kernel Köprüsü
 * @module src/policy/kernel-bridge
 *
 * TypeScript CLI → Rust binary (sovereign-policy-kernel) iletişim katmanı.
 * ARCHITECTURE.md §3.3 — Timeout: 5000ms → fail-closed
 *
 * Hiçbir AI raporunda yoktu — SE OS'a özgün tasarım.
 */
import type { Decision } from "../types/decision.js";
import type { PolicyResult } from "../types/policy.js";
export type KernelBridgeStatus = "PERMIT" | "DENY" | "BLOCK" | "ASK_HUMAN" | "ERROR";
export interface KernelBridgeResult {
    status: KernelBridgeStatus;
    policy_result?: PolicyResult;
    error?: string;
    duration_ms: number;
}
/**
 * Decision'ı Rust binary'e gönderir, PolicyResult alır.
 *
 * Fail-closed garantisi:
 *   - Timeout → DENY
 *   - Binary crash → DENY
 *   - JSON parse hatası → DENY
 *   - Boş çıktı → DENY
 *
 * @param decision - VALIDATED durumundaki Decision
 */
export declare function callPolicyKernel(decision: Decision): Promise<KernelBridgeResult>;
/**
 * Policy Kernel'den ASK_HUMAN döndüğünde çağrılır.
 * Decision.status → "PENDING_HUMAN", retry_count başlatılır (yoksa 0).
 *
 * ARCHITECTURE.md §3.3:
 *   ASK_HUMAN çıktısında TypeScript orchestration:
 *     → Decision.status = "PENDING_HUMAN"
 *     → Decision.retry_count = (mevcut değer veya 0)
 *     → execution_token üretilmez — insan onayı beklenir
 *
 * @param decision - VALIDATED durumundaki Decision
 * @returns Güncellenmiş Decision (status: PENDING_HUMAN)
 */
export declare function applyAskHuman(decision: Decision): Decision;
/**
 * Execution Gate EXPIRED_TOKEN döndürdüğünde çağrılır.
 * retry_count++ — sınıra ulaşılırsa otomatik REJECTED.
 *
 * ARCHITECTURE.md §3.4:
 *   EXPIRED_TOKEN alınca TypeScript orchestration:
 *     → Decision.status değişmez ("PENDING_HUMAN" kalır)
 *     → Decision.retry_count++
 *     → retry_count >= 3 → status = "REJECTED", error_code: TOKEN_RETRY_LIMIT
 *     → retry_count < 3  → insan yeniden onaylayabilir
 *
 * @param decision - PENDING_HUMAN durumundaki Decision
 * @returns { decision: Decision, limitReached: boolean }
 *          limitReached=true → status "REJECTED" olarak ayarlandı (TOKEN_RETRY_LIMIT)
 */
export declare function handleExpiredToken(decision: Decision): {
    decision: Decision;
    limitReached: boolean;
};
/**
 * Policy Kernel binary'nin mevcut ve çalışır olduğunu doğrular.
 * Startup fail-closed: binary yoksa sistem başlamaz.
 *
 * SAP-02 FIX:
 *   - "healthcheck" modu kullanılıyor — main.rs bu modu tanıyor
 *   - resolve(code === 0) — ARCH §7: "exit 0 değilse sistem başlamaz"
 */
export declare function healthCheck(): Promise<boolean>;
//# sourceMappingURL=kernel-bridge.d.ts.map