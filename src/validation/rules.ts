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
import { isImmutableStatus } from "../types/decision.js";
import { MAX_RE_EVALUATE_COUNT } from "../types/preflight.js";

// ---------------------------------------------------------------------------
// Sonuç Tipleri
// ---------------------------------------------------------------------------

export type RuleStatus = "PASS" | "REJECTED" | "ASK_HUMAN";

export interface RuleValidationResult {
  status:    RuleStatus;
  rule?:     string;    // Hangi kural ihlal edildi
  reason?:   string;    // İnsan okunabilir açıklama
  error_code?: BusinessRuleErrorCode;
}

export type BusinessRuleErrorCode =
  | "CONFIDENCE_SELF_CHECK_CONFLICT"  // R1
  | "CRITICAL_HIGH_CONFIDENCE"        // R2
  | "MODIFY_STATE_NOT_CRITICAL"       // R3
  | "ASSUMED_STATE_INVALID_INTENT"    // R4
  | "RE_EVALUATE_LIMIT_REACHED"       // R5
  | "IMMUTABLE_STATE"                 // R6
  | "INVALID_ENTRY_STATUS"            // R7
  | "EMPTY_ACTOR_ID"                  // R8
  | "INVALID_HIERARCHY_PATH";         // R9

// ---------------------------------------------------------------------------
// Tek Kural Kontrol Tipi
// ---------------------------------------------------------------------------

type RuleCheck = (d: Decision) => RuleValidationResult | null;

// ---------------------------------------------------------------------------
// Kural Fonksiyonları
// ---------------------------------------------------------------------------

/**
 * R1: confidence=HIGH + self_check_passed=false → REJECT
 * Çelişki — AI yüksek güven iddiasında bulunurken self-check'i geçiremiyor.
 */
function checkR1(d: Decision): RuleValidationResult | null {
  if (d.metadata.confidence === "HIGH" && d.metadata.self_check_passed === false) {
    return {
      status:     "REJECTED",
      rule:       "R1",
      reason:     "confidence=HIGH iken self_check_passed=false olamaz — çelişki",
      error_code: "CONFIDENCE_SELF_CHECK_CONFLICT",
    };
  }
  return null;
}

/**
 * R2: risk_level=CRITICAL + confidence=HIGH → REJECT
 * CRITICAL risk seviyesinde AI yüksek güven iddiasında bulunamaz.
 */
function checkR2(d: Decision): RuleValidationResult | null {
  if (d.context.risk_level === "CRITICAL" && d.metadata.confidence === "HIGH") {
    return {
      status:     "REJECTED",
      rule:       "R2",
      reason:     "risk_level=CRITICAL durumunda confidence=HIGH olamaz",
      error_code: "CRITICAL_HIGH_CONFIDENCE",
    };
  }
  return null;
}

/**
 * R3: intent=MODIFY_STATE + risk_level≠CRITICAL → REJECT
 * Durum değiştiren kararlar her zaman CRITICAL risk taşımalıdır.
 */
function checkR3(d: Decision): RuleValidationResult | null {
  if (d.intent === "MODIFY_STATE" && d.context.risk_level !== "CRITICAL") {
    return {
      status:     "REJECTED",
      rule:       "R3",
      reason:     `intent=MODIFY_STATE iken risk_level CRITICAL olmalıdır — mevcut: ${d.context.risk_level}`,
      error_code: "MODIFY_STATE_NOT_CRITICAL",
    };
  }
  return null;
}

/**
 * R4: assumed_state + intent∉{EXECUTE_ACTION, MODIFY_STATE} → REJECT
 * assumed_state yalnızca gerçek eylem yürüten intent'lerde kullanılabilir.
 */
function checkR4(d: Decision): RuleValidationResult | null {
  if (
    d.payload.assumed_state !== undefined &&
    d.intent !== "EXECUTE_ACTION" &&
    d.intent !== "MODIFY_STATE"
  ) {
    return {
      status:     "REJECTED",
      rule:       "R4",
      reason:     `assumed_state yalnızca EXECUTE_ACTION veya MODIFY_STATE ile kullanılabilir — mevcut intent: ${d.intent}`,
      error_code: "ASSUMED_STATE_INVALID_INTENT",
    };
  }
  return null;
}

/**
 * R5: assumed_state RE_EVALUATE max 3 kez → 4. denemede ASK_HUMAN
 * Sonsuz döngü koruması. retry_count PreFlight tarafından yönetilir;
 * bu kural, Decision payload'una gömülü retry_count varsa kontrol eder.
 *
 * Not: Gerçek RE_EVALUATE sayacı preFlightRead() içinde yönetilir.
 * Bu kural doğrudan assumed_state üzerindeki retry_count alanını okur
 * (eğer domain adapter onu payload'a yerleştirdiyse).
 */
function checkR5(d: Decision): RuleValidationResult | null {
  const retryCount = (d.payload.params as Record<string, unknown>)["_re_evaluate_count"];
  if (typeof retryCount === "number" && retryCount >= MAX_RE_EVALUATE_COUNT) {
    return {
      status:     "ASK_HUMAN",
      rule:       "R5",
      reason:     `RE_EVALUATE limiti aşıldı (${retryCount}/${MAX_RE_EVALUATE_COUNT}) — insan onayı gerekli`,
      error_code: "RE_EVALUATE_LIMIT_REACHED",
    };
  }
  return null;
}

/**
 * R6: Kilitli (IMMUTABLE) duruma sahip Decision → REJECT
 * COMPLETED, REJECTED, BLOCKED durumları değiştirilemez.
 */
function checkR6(d: Decision): RuleValidationResult | null {
  if (isImmutableStatus(d.status)) {
    return {
      status:     "REJECTED",
      rule:       "R6",
      reason:     `Decision kilitli durumda (${d.status}) — değiştirilemez (IMMUTABLE_STATE)`,
      error_code: "IMMUTABLE_STATE",
    };
  }
  return null;
}

/**
 * R7: Validation Engine giriş status kontrolü
 * Validation Engine yalnızca PENDING durumundaki Decision'ları kabul eder.
 * VALIDATED+ durumlar yeniden doğrulanamaz.
 */
function checkR7(d: Decision): RuleValidationResult | null {
  if (d.status !== "PENDING") {
    return {
      status:     "REJECTED",
      rule:       "R7",
      reason:     `Validation Engine yalnızca PENDING durumundaki Decision'ları kabul eder — mevcut: ${d.status}`,
      error_code: "INVALID_ENTRY_STATUS",
    };
  }
  return null;
}

/**
 * R8: actor_id boş string kontrolü
 * Şema kontrolü string olduğunu garanti eder; bu kural boş olmadığını kontrol eder.
 */
function checkR8(d: Decision): RuleValidationResult | null {
  if (d.context.actor_id.trim().length === 0) {
    return {
      status:     "REJECTED",
      rule:       "R8",
      reason:     "context.actor_id boş olamaz",
      error_code: "EMPTY_ACTOR_ID",
    };
  }
  return null;
}

/**
 * R9: hierarchy_path varsa geçerli string[] olmalı
 * Her eleman boş olmayan bir string olmalıdır.
 */
function checkR9(d: Decision): RuleValidationResult | null {
  const hp = d.context.hierarchy_path;
  if (hp !== undefined) {
    if (!Array.isArray(hp) || hp.some((e) => typeof e !== "string" || e.trim().length === 0)) {
      return {
        status:     "REJECTED",
        rule:       "R9",
        reason:     "context.hierarchy_path her elemanı boş olmayan bir string olmalıdır",
        error_code: "INVALID_HIERARCHY_PATH",
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Kural Zinciri
// ---------------------------------------------------------------------------

/**
 * Uygulama sırası önemlidir:
 *   - R6/R7 önce gelir — kilitli/geçersiz durumda diğer kurallar çalışmaz
 *   - R1/R2/R3 güvenlik kuralları — erken çık
 *   - R4/R5 payload kuralları
 *   - R8/R9 bağlam kuralları
 */
const RULE_CHAIN: RuleCheck[] = [
  checkR6,
  checkR7,
  checkR1,
  checkR2,
  checkR3,
  checkR4,
  checkR5,
  checkR8,
  checkR9,
];

// ---------------------------------------------------------------------------
// Ana Fonksiyon
// ---------------------------------------------------------------------------

/**
 * Decision üzerinde tüm iş kurallarını çalıştırır.
 * İlk ihlalde durur — zincirleme kontrol yoktur.
 *
 * @param d - Şema doğrulamasından geçmiş Decision
 * @returns RuleValidationResult — PASS, REJECTED veya ASK_HUMAN
 */
export function validateBusinessRules(d: Decision): RuleValidationResult {
  for (const check of RULE_CHAIN) {
    const result = check(d);
    if (result !== null) return result;
  }
  return { status: "PASS" };
}

/**
 * Belirli bir kuralı ismiyle çalıştırır — test amaçlı.
 * Örn: runRule("R3", decision)
 */
export function runRule(ruleName: string, d: Decision): RuleValidationResult | null {
  const ruleMap: Record<string, RuleCheck> = {
    R1: checkR1, R2: checkR2, R3: checkR3,
    R4: checkR4, R5: checkR5, R6: checkR6,
    R7: checkR7, R8: checkR8, R9: checkR9,
  };
  const fn = ruleMap[ruleName];
  return fn ? fn(d) : null;
}
