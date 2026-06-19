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
// ---------------------------------------------------------------------------
// Hata Kataloğu — Sabit Mesajlar
// ---------------------------------------------------------------------------
const ERROR_CATALOG = {
    // Schema hataları
    MISSING_FIELD: {
        message: "Zorunlu alan eksik.",
        hint: "Eksik alanı ekleyin ve tekrar deneyin.",
        redirect: "ARCHITECTURE.md §2.1 — Decision Object zorunlu alanları.",
        severity: "ERROR",
    },
    INVALID_VERSION: {
        message: "Desteklenmeyen schema_version.",
        hint: "schema_version alanını '1.0' olarak ayarlayın.",
        redirect: "ARCHITECTURE.md §2.1 — schema_version zorunlu olarak '1.0' olmalıdır.",
        severity: "ERROR",
    },
    INVALID_FORMAT: {
        message: "Alan formatı geçersiz.",
        hint: "Alan değerini beklenen formata uygun düzeltin.",
        redirect: "ARCHITECTURE.md §2.1 — category: /^[A-Z_]+$/, action_name: /^[a-z_]+$/",
        severity: "ERROR",
    },
    INVALID_TYPE: {
        message: "Alan tipi yanlış.",
        hint: "Alanın beklenen tipini kontrol edin.",
        redirect: "ARCHITECTURE.md §2.1 — Decision Object tip şeması.",
        severity: "ERROR",
    },
    NON_POSITIVE_VALUE: {
        message: "Sayısal alan sıfır veya negatif olamaz.",
        hint: "session_number ve priority alanları pozitif tam sayı olmalıdır.",
        redirect: "CORE.md §8 — NON-NEGATIVE alanlar.",
        severity: "ERROR",
    },
    // İş kuralı hataları
    CONFIDENCE_SELF_CHECK_CONFLICT: {
        message: "confidence=HIGH iken self_check_passed=false olamaz.",
        hint: "Ya confidence değerini 'MEDIUM' yapın ya da self_check_passed'ı true olarak işaretleyin.",
        redirect: "ARCHITECTURE.md §2.1 — R1: Güven çelişkisi.",
        severity: "ERROR",
    },
    CRITICAL_HIGH_CONFIDENCE: {
        message: "CRITICAL risk seviyesinde confidence=HIGH kullanılamaz.",
        hint: "CRITICAL işlemlerde confidence 'MEDIUM' veya 'LOW' olmalıdır.",
        redirect: "ARCHITECTURE.md §2.1 — R2: CRITICAL risk + HIGH confidence yasak.",
        severity: "ERROR",
    },
    MODIFY_STATE_NOT_CRITICAL: {
        message: "MODIFY_STATE intent'i CRITICAL risk seviyesi gerektirir.",
        hint: "context.risk_level alanını 'CRITICAL' olarak güncelleyin.",
        redirect: "ARCHITECTURE.md §2.1 — R3: MODIFY_STATE her zaman CRITICAL.",
        severity: "ERROR",
    },
    ASSUMED_STATE_INVALID_INTENT: {
        message: "assumed_state yalnızca EXECUTE_ACTION veya MODIFY_STATE ile kullanılabilir.",
        hint: "assumed_state alanını kaldırın ya da intent'i EXECUTE_ACTION / MODIFY_STATE yapın.",
        redirect: "ARCHITECTURE.md §2.1 — R4: assumed_state intent kısıtı.",
        severity: "ERROR",
    },
    RE_EVALUATE_LIMIT_REACHED: {
        message: "RE_EVALUATE limiti aşıldı — insan onayı gerekli.",
        hint: "Bu işlemi manuel olarak gözden geçirin ve onaylayın.",
        redirect: "AI_AGENT.md — RE_EVALUATE max 3 kez, sonra ASK_HUMAN.",
        severity: "WARNING",
    },
    IMMUTABLE_STATE: {
        message: "Bu Decision kilitli durumda — değiştirilemez.",
        hint: "COMPLETED, REJECTED veya BLOCKED durumundaki kayıtlar salt okunurdur.",
        redirect: "CORE.md §7 — KİLİTLİ DURUMLAR (IMMUTABLE_STATE).",
        severity: "ERROR",
    },
    INVALID_ENTRY_STATUS: {
        message: "Validation Engine yalnızca PENDING durumundaki Decision'ları kabul eder.",
        hint: "status alanını 'PENDING' olarak ayarlayın.",
        redirect: "ARCHITECTURE.md §2.1 — Durum geçiş tablosu.",
        severity: "ERROR",
    },
    EMPTY_ACTOR_ID: {
        message: "actor_id boş olamaz.",
        hint: "context.actor_id alanına geçerli bir kimlik değeri girin.",
        redirect: "ARCHITECTURE.md §2.1 — context.actor_id zorunludur.",
        severity: "ERROR",
    },
    INVALID_HIERARCHY_PATH: {
        message: "hierarchy_path geçersiz — her eleman boş olmayan bir string olmalıdır.",
        hint: "hierarchy_path dizisindeki boş veya geçersiz elemanları düzeltin.",
        redirect: "ARCHITECTURE.md §2.1 — context.hierarchy_path formatı.",
        severity: "ERROR",
    },
    // Pre-flight hataları
    PRE_FLIGHT_STALE: {
        message: "assumed_state bayatlamış — sistem durumu değişmiş.",
        hint: "Decision'ı güncel sistem durumuyla yeniden oluşturun.",
        redirect: "AI_AGENT.md — PRE-FLIGHT READ: bayat veri koruması.",
        severity: "WARNING",
    },
    PRE_FLIGHT_ENTITY_INACTIVE: {
        message: "İşlem hedefi artık aktif değil.",
        hint: "Kaydın durumunu kontrol edin — işlem geçersiz hedefe uygulanamaz.",
        redirect: "AI_AGENT.md — PRE-FLIGHT READ: ENTITY_INACTIVE.",
        severity: "ERROR",
    },
    UNKNOWN: {
        message: "Bilinmeyen doğrulama hatası.",
        hint: "Sistem yöneticisiyle iletişime geçin.",
        redirect: "failure_patterns.md — hata taksonomisineyakın en yakın kalıbı arayın.",
        severity: "ERROR",
    },
};
// ---------------------------------------------------------------------------
// Factory Fonksiyonlar
// ---------------------------------------------------------------------------
/**
 * Hata kodu + opsiyonel override'larla ValidationError üretir.
 */
export function makeError(code, overrides) {
    const base = ERROR_CATALOG[code] ?? ERROR_CATALOG["UNKNOWN"];
    return {
        code,
        field: overrides?.field,
        rule: overrides?.rule,
        message: overrides?.message ?? base.message,
        hint: overrides?.hint ?? base.hint,
        redirect: base.redirect,
        severity: base.severity,
    };
}
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
export function formatError(error) {
    const prefix = error.severity === "WARNING" ? "⚠" : "✗";
    const rule = error.rule ? `[${error.rule}] ` : "";
    const field = error.field ? `\n  Alan    : ${error.field}` : "";
    return [
        `${prefix} ${rule}${error.code} — ${error.message}`,
        field,
        `\n  Öneri   : ${error.hint}`,
        `\n  Referans: ${error.redirect}`,
    ].join("");
}
/**
 * Birden fazla hatayı CLI çıktısı için formatlar.
 */
export function formatErrors(errors) {
    return errors.map(formatError).join("\n\n");
}
/**
 * ValidationError'ı JSON log formatına dönüştürür.
 */
export function toLogEntry(error, decisionId) {
    return {
        timestamp: new Date().toISOString(),
        decision_id: decisionId ?? null,
        code: error.code,
        field: error.field ?? null,
        rule: error.rule ?? null,
        message: error.message,
        hint: error.hint,
        redirect: error.redirect,
        severity: error.severity,
    };
}
//# sourceMappingURL=errors.js.map