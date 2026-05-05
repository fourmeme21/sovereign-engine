/**
 * Sovereign Engine OS — Validation Engine
 * @module src/validation/engine
 *
 * Katman 2 (Validation Engine) — Ana orkestratör.
 * ARCHITECTURE.md §3.2 ValidationEngine interface'ini implemente eder.
 *
 * Akış:
 *   validateSchema(raw)       → SchemaValidationResult
 *   validateBusinessRules(d)  → RuleValidationResult
 *   preFlightRead(d)          → Promise<PreFlightResult>
 *   validate(raw)             → Promise<ValidationResult>  ← tam akış
 */

import type { Decision }        from "../types/decision.js";
import type { PreFlightResult } from "../types/preflight.js";
import { validateSchema, castToDecision }  from "./schema.js";
import { validateBusinessRules }           from "./rules.js";
import { makeError, formatError }          from "./errors.js";
import type { ValidationError }            from "./errors.js";

// ---------------------------------------------------------------------------
// Kontrat Tipleri
// ---------------------------------------------------------------------------

export type ValidationStatus = "PASS" | "REJECTED" | "ASK_HUMAN";

export interface ValidationResult {
  status:  ValidationStatus;
  error?:  ValidationError;   // Standart hata — formatError() ile yazdırılabilir
  data?:   Decision;
}

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

  validateSchema(raw: unknown): ValidationResult {
    const result = validateSchema(raw);
    if (!result.valid) {
      const first  = result.errors[0];
      const error  = makeError(first?.code ?? "UNKNOWN", {
        field:   first?.field,
        message: result.errors.map(e => e.message).join("; "),
      });
      return { status: "REJECTED", error };
    }
    return { status: "PASS", data: castToDecision(raw) };
  }

  validateBusinessRules(d: Decision): ValidationResult {
    const result = validateBusinessRules(d);
    if (result.status === "PASS") return { status: "PASS", data: d };

    const error = makeError(result.error_code ?? "UNKNOWN", { rule: result.rule });
    return { status: result.status, error, data: result.status === "ASK_HUMAN" ? d : undefined };
  }

  async preFlightRead(d: Decision): Promise<PreFlightResult> {
    if (d.payload.assumed_state === undefined) return { clear: true };
    if (this.preFlightProvider === null)        return { clear: true };
    return this.preFlightProvider.preFlightRead(d);
  }

  async validate(raw: unknown): Promise<ValidationResult> {
    // Adım 1 — Şema
    const schemaResult = this.validateSchema(raw);
    if (schemaResult.status !== "PASS" || !schemaResult.data) return schemaResult;

    // Adım 2 — İş Kuralları
    const rulesResult = this.validateBusinessRules(schemaResult.data);
    if (rulesResult.status !== "PASS") return rulesResult;

    // Adım 3 — Pre-Flight
    const preflight = await this.preFlightRead(schemaResult.data);
    if (!preflight.clear) {
      if (preflight.reason === "RE_EVALUATE" &&
          typeof preflight.retry_count === "number" &&
          preflight.retry_count >= 3) {
        return {
          status: "ASK_HUMAN",
          error:  makeError("RE_EVALUATE_LIMIT_REACHED"),
          data:   schemaResult.data,
        };
      }
      const code = preflight.reason === "ENTITY_INACTIVE"
        ? "PRE_FLIGHT_ENTITY_INACTIVE"
        : "PRE_FLIGHT_STALE";
      return {
        status: "REJECTED",
        error:  makeError(code, {
          hint: preflight.stale_fields
            ? `Bayat alanlar: ${preflight.stale_fields.join(", ")}. Decision'ı güncelleyin.`
            : undefined,
        }),
      };
    }

    return { status: "PASS", data: { ...schemaResult.data, status: "VALIDATED" } };
  }
}

export function createValidationEngine(provider?: PreFlightProvider): ValidationEngine {
  return new ValidationEngine(provider);
}
