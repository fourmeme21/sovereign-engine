/**
 * Sovereign Engine OS — Schema Validator
 * @module src/validation/schema
 *
 * Katman 2 (Validation Engine) — Adım 1: Şema doğrulama.
 * Ham JSON'un Decision tipine uygunluğunu kontrol eder.
 * İş kuralı kontrolü bu modülde yapılmaz — rules.ts'e aittir.
 *
 * Kontrol edilen kısıtlar (ARCHITECTURE.md §2.1):
 *   - Zorunlu alanların varlığı
 *   - schema_version = "1.0"
 *   - category regex /^[A-Z_]+$/
 *   - payload.action_name regex /^[a-z_]+$/
 *   - metadata.session_number > 0
 *   - id, created_at string olmalı
 */
import type { Decision } from "../types/decision.js";
export interface SchemaValidationResult {
    valid: boolean;
    errors: SchemaError[];
}
export interface SchemaError {
    field: string;
    code: SchemaErrorCode;
    message: string;
}
export type SchemaErrorCode = "MISSING_FIELD" | "INVALID_VERSION" | "INVALID_FORMAT" | "INVALID_TYPE" | "NON_POSITIVE_VALUE";
/** category alanı için regex — sadece büyük harf ve alt çizgi */
export declare const CATEGORY_REGEX: RegExp;
/** action_name alanı için regex — sadece küçük harf ve alt çizgi */
export declare const ACTION_NAME_REGEX: RegExp;
/**
 * Ham JSON değerinin Decision şemasına uygun olup olmadığını doğrular.
 *
 * @param raw - Doğrulanacak ham değer
 * @returns SchemaValidationResult — tüm hatalar listelenir, ilk hatada durulmaz
 */
export declare function validateSchema(raw: unknown): SchemaValidationResult;
/**
 * SchemaValidationResult'tan Decision tipine dönüştürür.
 * Sadece valid=true durumunda çağrılmalıdır.
 */
export declare function castToDecision(raw: unknown): Decision;
//# sourceMappingURL=schema.d.ts.map