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
// ---------------------------------------------------------------------------
// Regex Sabitleri
// ---------------------------------------------------------------------------
/** category alanı için regex — sadece büyük harf ve alt çizgi */
export const CATEGORY_REGEX = /^[A-Z_]+$/;
/** action_name alanı için regex — sadece küçük harf ve alt çizgi */
export const ACTION_NAME_REGEX = /^[a-z_]+$/;
/** ISO 8601 tarih formatı (basit kontrol) */
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
// ---------------------------------------------------------------------------
// Yardımcı Fonksiyonlar
// ---------------------------------------------------------------------------
function err(field, code, message) {
    return { field, code, message };
}
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
// ---------------------------------------------------------------------------
// Schema Validator
// ---------------------------------------------------------------------------
/**
 * Ham JSON değerinin Decision şemasına uygun olup olmadığını doğrular.
 *
 * @param raw - Doğrulanacak ham değer
 * @returns SchemaValidationResult — tüm hatalar listelenir, ilk hatada durulmaz
 */
export function validateSchema(raw) {
    const errors = [];
    // Nesne kontrolü
    if (!isObject(raw)) {
        return {
            valid: false,
            errors: [err("root", "INVALID_TYPE", "Decision bir nesne olmalıdır")],
        };
    }
    const d = raw;
    // ── schema_version ──────────────────────────────────────────────────────
    if (d["schema_version"] === undefined || d["schema_version"] === null) {
        errors.push(err("schema_version", "MISSING_FIELD", "schema_version zorunludur"));
    }
    else if (d["schema_version"] !== "1.0") {
        errors.push(err("schema_version", "INVALID_VERSION", `Desteklenmeyen schema_version: "${String(d["schema_version"])}" — beklenen "1.0"`));
    }
    // ── id ──────────────────────────────────────────────────────────────────
    if (typeof d["id"] !== "string" || d["id"].length === 0) {
        errors.push(err("id", "MISSING_FIELD", "id zorunlu bir string olmalıdır"));
    }
    // ── created_at ──────────────────────────────────────────────────────────
    if (typeof d["created_at"] !== "string") {
        errors.push(err("created_at", "MISSING_FIELD", "created_at zorunlu bir string olmalıdır"));
    }
    else if (!ISO_8601_REGEX.test(d["created_at"])) {
        errors.push(err("created_at", "INVALID_FORMAT", "created_at ISO 8601 formatında olmalıdır"));
    }
    // ── intent ──────────────────────────────────────────────────────────────
    const validIntents = ["READ_DATA", "WRITE_DATA", "EXECUTE_ACTION", "TRIGGER_EVENT", "MODIFY_STATE"];
    if (typeof d["intent"] !== "string") {
        errors.push(err("intent", "MISSING_FIELD", "intent zorunludur"));
    }
    else if (!validIntents.includes(d["intent"])) {
        errors.push(err("intent", "INVALID_FORMAT", `Geçersiz intent: "${d["intent"]}"`));
    }
    // ── category ────────────────────────────────────────────────────────────
    if (typeof d["category"] !== "string" || d["category"].length === 0) {
        errors.push(err("category", "MISSING_FIELD", "category zorunludur"));
    }
    else if (!CATEGORY_REGEX.test(d["category"])) {
        errors.push(err("category", "INVALID_FORMAT", `category yalnızca büyük harf ve alt çizgi içerebilir: "${d["category"]}"`));
    }
    // ── payload ─────────────────────────────────────────────────────────────
    if (!isObject(d["payload"])) {
        errors.push(err("payload", "MISSING_FIELD", "payload zorunlu bir nesne olmalıdır"));
    }
    else {
        const payload = d["payload"];
        if (typeof payload["action_name"] !== "string" || payload["action_name"].length === 0) {
            errors.push(err("payload.action_name", "MISSING_FIELD", "payload.action_name zorunludur"));
        }
        else if (!ACTION_NAME_REGEX.test(payload["action_name"])) {
            errors.push(err("payload.action_name", "INVALID_FORMAT", `action_name yalnızca küçük harf ve alt çizgi içerebilir: "${payload["action_name"]}"`));
        }
        if (!isObject(payload["params"])) {
            errors.push(err("payload.params", "MISSING_FIELD", "payload.params zorunlu bir nesne olmalıdır"));
        }
        // assumed_state varsa nesne olmalı
        if (payload["assumed_state"] !== undefined && !isObject(payload["assumed_state"])) {
            errors.push(err("payload.assumed_state", "INVALID_TYPE", "assumed_state bir nesne olmalıdır"));
        }
    }
    // ── context ─────────────────────────────────────────────────────────────
    if (!isObject(d["context"])) {
        errors.push(err("context", "MISSING_FIELD", "context zorunlu bir nesne olmalıdır"));
    }
    else {
        const ctx = d["context"];
        const validRiskLevels = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
        if (typeof ctx["actor_id"] !== "string" || ctx["actor_id"].length === 0) {
            errors.push(err("context.actor_id", "MISSING_FIELD", "context.actor_id zorunludur"));
        }
        if (typeof ctx["actor_role"] !== "string" || ctx["actor_role"].length === 0) {
            errors.push(err("context.actor_role", "MISSING_FIELD", "context.actor_role zorunludur"));
        }
        if (typeof ctx["session_id"] !== "string" || ctx["session_id"].length === 0) {
            errors.push(err("context.session_id", "MISSING_FIELD", "context.session_id zorunludur"));
        }
        if (typeof ctx["risk_level"] !== "string") {
            errors.push(err("context.risk_level", "MISSING_FIELD", "context.risk_level zorunludur"));
        }
        else if (!validRiskLevels.includes(ctx["risk_level"])) {
            errors.push(err("context.risk_level", "INVALID_FORMAT", `Geçersiz risk_level: "${ctx["risk_level"]}"`));
        }
    }
    // ── metadata ────────────────────────────────────────────────────────────
    if (!isObject(d["metadata"])) {
        errors.push(err("metadata", "MISSING_FIELD", "metadata zorunlu bir nesne olmalıdır"));
    }
    else {
        const meta = d["metadata"];
        const validConfidence = ["HIGH", "MEDIUM", "LOW"];
        if (typeof meta["model"] !== "string" || meta["model"].length === 0) {
            errors.push(err("metadata.model", "MISSING_FIELD", "metadata.model zorunludur"));
        }
        if (typeof meta["session_number"] !== "number") {
            errors.push(err("metadata.session_number", "MISSING_FIELD", "metadata.session_number zorunlu bir sayı olmalıdır"));
        }
        else if (meta["session_number"] <= 0) {
            errors.push(err("metadata.session_number", "NON_POSITIVE_VALUE", `session_number 0 veya negatif olamaz: ${meta["session_number"]}`));
        }
        if (typeof meta["confidence"] !== "string") {
            errors.push(err("metadata.confidence", "MISSING_FIELD", "metadata.confidence zorunludur"));
        }
        else if (!validConfidence.includes(meta["confidence"])) {
            errors.push(err("metadata.confidence", "INVALID_FORMAT", `Geçersiz confidence: "${meta["confidence"]}"`));
        }
        if (typeof meta["self_check_passed"] !== "boolean") {
            errors.push(err("metadata.self_check_passed", "MISSING_FIELD", "metadata.self_check_passed zorunlu bir boolean olmalıdır"));
        }
    }
    // ── status ──────────────────────────────────────────────────────────────
    const validStatuses = ["PENDING", "VALIDATED", "POLICY_APPROVED", "EXECUTING", "COMPLETED", "REJECTED", "BLOCKED"];
    if (typeof d["status"] !== "string") {
        errors.push(err("status", "MISSING_FIELD", "status zorunludur"));
    }
    else if (!validStatuses.includes(d["status"])) {
        errors.push(err("status", "INVALID_FORMAT", `Geçersiz status: "${d["status"]}"`));
    }
    return { valid: errors.length === 0, errors };
}
/**
 * SchemaValidationResult'tan Decision tipine dönüştürür.
 * Sadece valid=true durumunda çağrılmalıdır.
 */
export function castToDecision(raw) {
    return raw;
}
//# sourceMappingURL=schema.js.map