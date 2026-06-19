/**
 * Sovereign Engine OS — Business Rules Validator
 * @module src/validation/rules
 *
 * Katman 2 (Validation Engine) — Adım 2: İş kuralı doğrulama.
 * Şema geçtikten SONRA çalışır — Decision tipi garanti edilmiştir.
 *
 * 9 İş Kuralı (ARCHITECTURE.md §2.1 Şema Kısıtları):
 *   R1: confidence=HIGH + self_check_passed=false → REJECT
 *   R2: risk_level=CRITICAL + confidence=HIGH    → REJECT
 *   R3: intent=MODIFY_STATE + risk_level≠CRITICAL → REJECT
 *   R4: assumed_state + intent∉{EXECUTE_ACTION,MODIFY_STATE} → REJECT
 *   R5: assumed_state RE_EVALUATE max 3 → ASK_HUMAN
 *   R6: COMPLETED/REJECTED/BLOCKED durumuna yazma → REJECT (IMMUTABLE_STATE)
 *   R7: status=PENDING dışındaki giriş → REJECT (yalnızca PENDING kabul edilir)
 *   R8: actor_id boş string → REJECT
 *   R9: hierarchy_path varsa string[] olmalı → REJECT
 */
import type { Decision } from "../types/decision.js";
export type RuleStatus = "PASS" | "REJECTED" | "ASK_HUMAN";
export interface RuleValidationResult {
    status: RuleStatus;
    rule?: string;
    reason?: string;
    error_code?: BusinessRuleErrorCode;
}
export type BusinessRuleErrorCode = "CONFIDENCE_SELF_CHECK_CONFLICT" | "CRITICAL_HIGH_CONFIDENCE" | "MODIFY_STATE_NOT_CRITICAL" | "ASSUMED_STATE_INVALID_INTENT" | "RE_EVALUATE_LIMIT_REACHED" | "IMMUTABLE_STATE" | "INVALID_ENTRY_STATUS" | "EMPTY_ACTOR_ID" | "INVALID_HIERARCHY_PATH";
/**
 * Decision üzerinde tüm iş kurallarını çalıştırır.
 * İlk ihlalde durur — zincirleme kontrol yoktur.
 *
 * @param d - Şema doğrulamasından geçmiş Decision
 * @returns RuleValidationResult — PASS, REJECTED veya ASK_HUMAN
 */
export declare function validateBusinessRules(d: Decision): RuleValidationResult;
/**
 * Belirli bir kuralı ismiyle çalıştırır — test amaçlı.
 * Örn: runRule("R3", decision)
 */
export declare function runRule(ruleName: string, d: Decision): RuleValidationResult | null;
//# sourceMappingURL=rules.d.ts.map