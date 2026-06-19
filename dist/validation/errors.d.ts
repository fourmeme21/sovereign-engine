/**
 * Sovereign Engine OS — Validation Hata Formatı
 * @module src/validation/errors
 *
 * Tüm REJECTED ve ASK_HUMAN yanıtları bu modülden geçer.
 * CLI çıktısı, log kaydı ve kullanıcı mesajı aynı formatı kullanır.
 *
 * Format hedefleri:
 *   - Makine okunabilir (error_code)
 *   - İnsan okunabilir (message + hint)
 *   - Log dostu (JSON serileştirilebilir)
 *   - Soft steer uyumlu (redirect zorunlu — ARCHITECTURE.md §9)
 */
import type { SchemaErrorCode } from "./schema.js";
import type { BusinessRuleErrorCode } from "./rules.js";
export type ValidationErrorCode = SchemaErrorCode | BusinessRuleErrorCode | "PRE_FLIGHT_STALE" | "PRE_FLIGHT_ENTITY_INACTIVE" | "UNKNOWN";
/** Hata şiddet seviyesi */
export type ErrorSeverity = "ERROR" | "WARNING" | "INFO";
/**
 * Standart ValidationError — tüm katmanlar bu tipi kullanır.
 *
 * @example
 * ```json
 * {
 *   "code":     "MODIFY_STATE_NOT_CRITICAL",
 *   "field":    "context.risk_level",
 *   "message":  "MODIFY_STATE intent'i CRITICAL risk gerektirir.",
 *   "hint":     "context.risk_level alanını 'CRITICAL' olarak güncelleyin.",
 *   "redirect": "ARCHITECTURE.md §2.1 — intent=MODIFY_STATE kısıtlarına bakın.",
 *   "severity": "ERROR",
 *   "rule":     "R3"
 * }
 * ```
 */
export interface ValidationError {
    /** Makine okunabilir hata kodu */
    readonly code: ValidationErrorCode;
    /** Hangi alanda hata var — opsiyonel */
    readonly field?: string;
    /** İnsan okunabilir açıklama */
    readonly message: string;
    /**
     * Düzeltme önerisi — soft steer.
     * ARCHITECTURE.md §9: Her DENY bir redirect içermeli — boş olamaz.
     */
    readonly hint: string;
    /**
     * Referans yönlendirmesi — ilgili belge veya kural.
     * DENY soft steer mesajı olarak kullanılır.
     */
    readonly redirect: string;
    /** Hata şiddeti */
    readonly severity: ErrorSeverity;
    /** İhlal edilen kural (R1–R9) — iş kuralı hatalarında */
    readonly rule?: string;
}
/**
 * Hata kodu + opsiyonel override'larla ValidationError üretir.
 */
export declare function makeError(code: ValidationErrorCode, overrides?: Partial<Pick<ValidationError, "field" | "rule" | "message" | "hint">>): ValidationError;
/**
 * ValidationError'ı CLI çıktısı için formatlar.
 *
 * @example
 * ```
 * ✗ [R3] MODIFY_STATE_NOT_CRITICAL — MODIFY_STATE intent'i CRITICAL risk gerektirir.
 *   Alan    : context.risk_level
 *   Öneri   : context.risk_level alanını 'CRITICAL' olarak güncelleyin.
 *   Referans: ARCHITECTURE.md §2.1 — R3: MODIFY_STATE her zaman CRITICAL.
 * ```
 */
export declare function formatError(error: ValidationError): string;
/**
 * Birden fazla hatayı CLI çıktısı için formatlar.
 */
export declare function formatErrors(errors: ValidationError[]): string;
/**
 * ValidationError'ı JSON log formatına dönüştürür.
 */
export declare function toLogEntry(error: ValidationError, decisionId?: string): Record<string, unknown>;
//# sourceMappingURL=errors.d.ts.map