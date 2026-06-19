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
import { validateSchema, castToDecision } from "./schema.js";
import { validateBusinessRules } from "./rules.js";
import { makeError } from "./errors.js";
// ---------------------------------------------------------------------------
// Validation Engine
// ---------------------------------------------------------------------------
export class ValidationEngine {
    preFlightProvider;
    constructor(preFlightProvider) {
        this.preFlightProvider = preFlightProvider ?? null;
    }
    validateSchema(raw) {
        const result = validateSchema(raw);
        if (!result.valid) {
            const first = result.errors[0];
            const error = makeError(first?.code ?? "UNKNOWN", {
                field: first?.field,
                message: result.errors.map(e => e.message).join("; "),
            });
            return { status: "REJECTED", error };
        }
        return { status: "PASS", data: castToDecision(raw) };
    }
    validateBusinessRules(d) {
        const result = validateBusinessRules(d);
        if (result.status === "PASS")
            return { status: "PASS", data: d };
        const error = makeError(result.error_code ?? "UNKNOWN", { rule: result.rule });
        return { status: result.status, error, data: result.status === "ASK_HUMAN" ? d : undefined };
    }
    async preFlightRead(d) {
        if (d.payload.assumed_state === undefined)
            return { clear: true };
        if (this.preFlightProvider === null)
            return { clear: true };
        return this.preFlightProvider.preFlightRead(d);
    }
    async validate(raw) {
        // Adım 1 — Şema
        const schemaResult = this.validateSchema(raw);
        if (schemaResult.status !== "PASS" || !schemaResult.data)
            return schemaResult;
        // Adım 2 — İş Kuralları
        const rulesResult = this.validateBusinessRules(schemaResult.data);
        if (rulesResult.status !== "PASS")
            return rulesResult;
        // Adım 3 — Pre-Flight
        const preflight = await this.preFlightRead(schemaResult.data);
        if (!preflight.clear) {
            if (preflight.reason === "RE_EVALUATE" &&
                typeof preflight.retry_count === "number" &&
                preflight.retry_count >= 3) {
                return {
                    status: "ASK_HUMAN",
                    error: makeError("RE_EVALUATE_LIMIT_REACHED"),
                    data: schemaResult.data,
                };
            }
            const code = preflight.reason === "ENTITY_INACTIVE"
                ? "PRE_FLIGHT_ENTITY_INACTIVE"
                : "PRE_FLIGHT_STALE";
            return {
                status: "REJECTED",
                error: makeError(code, {
                    hint: preflight.stale_fields
                        ? `Bayat alanlar: ${preflight.stale_fields.join(", ")}. Decision'ı güncelleyin.`
                        : undefined,
                }),
            };
        }
        return { status: "PASS", data: { ...schemaResult.data, status: "VALIDATED" } };
    }
}
export function createValidationEngine(provider) {
    return new ValidationEngine(provider);
}
//# sourceMappingURL=engine.js.map