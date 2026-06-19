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
import type { Decision } from "../types/decision.js";
import type { PreFlightResult } from "../types/preflight.js";
import type { ValidationError } from "./errors.js";
export type ValidationStatus = "PASS" | "REJECTED" | "ASK_HUMAN";
export interface ValidationResult {
    status: ValidationStatus;
    error?: ValidationError;
    data?: Decision;
}
export interface PreFlightProvider {
    preFlightRead(decision: Decision): Promise<PreFlightResult>;
}
export declare class ValidationEngine {
    private readonly preFlightProvider;
    constructor(preFlightProvider?: PreFlightProvider);
    validateSchema(raw: unknown): ValidationResult;
    validateBusinessRules(d: Decision): ValidationResult;
    preFlightRead(d: Decision): Promise<PreFlightResult>;
    validate(raw: unknown): Promise<ValidationResult>;
}
export declare function createValidationEngine(provider?: PreFlightProvider): ValidationEngine;
//# sourceMappingURL=engine.d.ts.map