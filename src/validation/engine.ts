/**
 * Sovereign Engine OS — Validation Engine
 * @module src/validation/engine
 *
 * Katman 2 (Validation Engine) — Ana orkestratör.
 * ARCHITECTURE.md §3.2 ValidationEngine interface'ini implemente eder.
 *
 * Akış:
 *   validateSchema(raw)         → SchemaValidationResult
 *   validateBusinessRules(d)    → RuleValidationResult
 *   preFlightRead(d)            → Promise<PreFlightResult>
 *   validate(raw, adapter?)     → Promise<ValidationResult>  ← tam akış
 *
 * Katman Sınırı:
 *   - Policy Kernel'a bağımlı olamaz (ARCHITECTURE.md §9)
 *   - Domain Adapter'a doğrudan bağımlı olamaz — DomainAdapter interface üzerinden
 */

import type { Decision }        from "../types/decision.js";
import type { PreFlightResult } from "../types/preflight.js";
import { validateSchema, castToDecision }    from "./schema.js";
import { validateBusinessRules }             from "./rules.js";

// ---------------------------------------------------------------------------
// Kontrat Tipleri (ARCHITECTURE.md §3.2)
// ---------------------------------------------------------------------------

export type ValidationStatus = "PASS" | "REJECTED" | "ASK_HUMAN";

export interface ValidationResult {
  status:   ValidationStatus;
  reason?:  string;
  data?:    Decision;
}

/**
 * Domain Adapter'ın preFlightRead için sağladığı mini-interface.
 * Validation Engine Domain Adapter'ın tamamına bağımlı olamaz.
 */
export interface PreFlightProvider {
  preFlightRead(decision: Decision): Promise<PreFlightResult>;
}

// ---------------------------------------------------------------------------
// Validation Engine
// ---------------------------------------------------------------------------

export class ValidationEngine {
  private readonly preFlightProvider: PreFlightProvider | null;

  constructor(preFlightProvider?: PreFlightProvider) {
    this.preFlightProvider = preFlightProvider ?? null;
  }

  // ── Adım 1: Şema Doğrulama ───────────────────────────────────────────────

  /**
   * Ham JSON değerinin Decision şemasına uygunluğunu doğrular.
   * Başarısız olursa Decision nesnesi oluşturulmaz.
   *
   * @param raw - Ham JSON (unknown)
   * @returns ValidationResult
   */
  validateSchema(raw: unknown): ValidationResult {
    const result = validateSchema(raw);

    if (!result.valid) {
      const reasons = result.errors.map((e) => `[${e.field}] ${e.message}`).join("; ");
      return {
        status: "REJECTED",
        reason: `Şema hatası: ${reasons}`,
      };
    }

    return {
      status: "PASS",
      data:   castToDecision(raw),
    };
  }

  // ── Adım 2: İş Kuralları ─────────────────────────────────────────────────

  /**
   * Şemadan geçmiş Decision üzerinde 9 iş kuralını çalıştırır.
   *
   * @param d - validateSchema() geçmiş Decision
   * @returns ValidationResult
   */
  validateBusinessRules(d: Decision): ValidationResult {
    const result = validateBusinessRules(d);

    if (result.status === "PASS") {
      return { status: "PASS", data: d };
    }

    return {
      status: result.status,
      reason: result.reason,
      data:   result.status === "ASK_HUMAN" ? d : undefined,
    };
  }

  // ── Adım 3: Pre-Flight Read ───────────────────────────────────────────────

  /**
   * assumed_state'in hâlâ geçerli olup olmadığını kontrol eder.
   * preFlightProvider sağlanmadıysa veya assumed_state yoksa geçer.
   *
   * @param d - İş kurallarından geçmiş Decision
   * @returns Promise<PreFlightResult>
   */
  async preFlightRead(d: Decision): Promise<PreFlightResult> {
    // assumed_state yoksa pre-flight gerekmez
    if (d.payload.assumed_state === undefined) {
      return { clear: true };
    }

    // PreFlightProvider sağlanmadıysa geç (test / Faz 1 için)
    if (this.preFlightProvider === null) {
      return { clear: true };
    }

    return this.preFlightProvider.preFlightRead(d);
  }

  // ── Tam Akış ─────────────────────────────────────────────────────────────

  /**
   * Ham JSON'dan tam validation akışını çalıştırır.
   *
   * Adım sırası (ARCHITECTURE.md §4 CLI Akışı):
   *   1. validateSchema(raw)
   *   2. validateBusinessRules(decision)
   *   3. preFlightRead(decision) — assumed_state varsa
   *
   * Her adım başarısız olursa sonraki adım çalışmaz.
   *
   * @param raw            - Ham JSON
   * @returns Promise<ValidationResult>
   */
  async validate(raw: unknown): Promise<ValidationResult> {
    // Adım 1 — Şema
    const schemaResult = this.validateSchema(raw);
    if (schemaResult.status !== "PASS" || schemaResult.data === undefined) {
      return schemaResult;
    }
    const decision = schemaResult.data;

    // Adım 2 — İş Kuralları
    const rulesResult = this.validateBusinessRules(decision);
    if (rulesResult.status !== "PASS") {
      return rulesResult;
    }

    // Adım 3 — Pre-Flight (assumed_state varsa)
    const preflight = await this.preFlightRead(decision);

    if (!preflight.clear) {
      // RE_EVALUATE limitine ulaşıldıysa → ASK_HUMAN
      if (
        preflight.reason === "RE_EVALUATE" &&
        typeof preflight.retry_count === "number" &&
        preflight.retry_count >= 3
      ) {
        return {
          status: "ASK_HUMAN",
          reason: `assumed_state bayatlamış — RE_EVALUATE limiti aşıldı (${preflight.retry_count}/3)`,
          data:   decision,
        };
      }

      return {
        status: "REJECTED",
        reason: `Pre-flight başarısız: ${preflight.reason ?? "bilinmiyor"} — ${
          preflight.stale_fields ? `bayat alanlar: ${preflight.stale_fields.join(", ")}` : ""
        }`.trim(),
      };
    }

    // Tüm adımlar geçti — status VALIDATED olarak güncellenir
    const validated: Decision = { ...decision, status: "VALIDATED" };
    return { status: "PASS", data: validated };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * ValidationEngine oluşturur.
 * preFlightProvider olmadan kullanılırsa pre-flight adımı atlanır.
 */
export function createValidationEngine(provider?: PreFlightProvider): ValidationEngine {
  return new ValidationEngine(provider);
}
