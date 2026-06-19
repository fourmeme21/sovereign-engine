/**
 * Sovereign Engine OS — Decision Object
 * @module core/types/decision
 *
 * ROOT TYPE — tüm sistem tipleri bu tipe bağımlıdır.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.1 okunmalıdır.
 *
 * Şema Kısıtları (ARCHITECTURE.md §2.1):
 *   - schema_version eksik veya uyumsuz       → REJECT
 *   - category regex /^[A-Z_]+$/ uyumsuz      → REJECT
 *   - payload.action_name /^[a-z_]+$/ uyumsuz → REJECT
 *   - metadata.session_number ≤ 0             → REJECT
 *   - confidence=HIGH + self_check_passed=false → REJECT
 *   - risk_level=CRITICAL + confidence=HIGH   → REJECT
 *   - intent=MODIFY_STATE + risk_level≠CRITICAL → REJECT
 *   - assumed_state + intent∉{EXECUTE_ACTION,MODIFY_STATE} → REJECT
 */
/**
 * Kararın niyeti — risk seviyesini belirler.
 * MODIFY_STATE her zaman CRITICAL risk gerektirir.
 */
export type Intent = "READ_DATA" | "WRITE_DATA" | "EXECUTE_ACTION" | "TRIGGER_EVENT" | "MODIFY_STATE";
/** İşlem risk seviyesi. */
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
/**
 * AI'ın bu karar için güven seviyesi.
 * HIGH confidence + self_check_passed=false → REJECT (çelişki)
 * CRITICAL risk + confidence=HIGH → REJECT
 */
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
/**
 * Decision'ın katman bazlı durum geçiş zinciri.
 * COMPLETED | REJECTED | BLOCKED → IMMUTABLE_STATE (yazılamaz)
 *
 * Geçiş tablosu (ARCHITECTURE.md §2.1):
 *   → PENDING                    : Katman 1 — parse edildi
 *   PENDING → VALIDATED          : Katman 2 — validasyon geçti
 *   PENDING → REJECTED           : Katman 1/2 — validasyon başarısız
 *   VALIDATED → POLICY_APPROVED  : Katman 3 — PERMIT
 *   VALIDATED → PENDING_HUMAN    : Katman 3 — ASK_HUMAN; insan onayı bekleniyor
 *   VALIDATED → BLOCKED          : Katman 3 — BLOCK
 *   PENDING_HUMAN → POLICY_APPROVED : Katman 3 — insan onayladı, yeni token üretildi
 *   PENDING_HUMAN → REJECTED     : TypeScript orchestration — retry_count >= 3 (TOKEN_RETRY_LIMIT)
 *   POLICY_APPROVED → EXECUTING  : Katman 4 — token doğrulandı
 *   EXECUTING → COMPLETED        : Katman 4 — başarılı
 *   EXECUTING → REJECTED         : Katman 4 — başarısız + rollback
 */
export type DecisionStatus = "PENDING" | "VALIDATED" | "POLICY_APPROVED" | "PENDING_HUMAN" | "EXECUTING" | "COMPLETED" | "REJECTED" | "BLOCKED";
/** Kilitli (IMMUTABLE) durumlar — bu durumlarda READ_DATA dışında işlem yapılamaz. */
export type ImmutableDecisionStatus = "COMPLETED" | "REJECTED" | "BLOCKED";
/**
 * Kararın içeriği — ne yapılacağı ve parametreler.
 * assumed_state sadece EXECUTE_ACTION veya MODIFY_STATE ile kullanılabilir.
 */
export interface DecisionPayload {
    /** İş akışı adı. Regex: /^[a-z_]+$/ — uyumsuzsa REJECT. */
    readonly action_name: string;
    /** Aksiyonun parametreleri. */
    readonly params: Record<string, unknown>;
    /**
     * Mevcut sistem durumunun varsayılan anlık görüntüsü.
     * SADECE intent=EXECUTE_ACTION veya MODIFY_STATE ile kullanılabilir.
     * Bayatlarsa RE_EVALUATE tetiklenir (max 3 kez, sonra ASK_HUMAN).
     */
    readonly assumed_state?: Record<string, unknown>;
}
/** Kararı kimin, hangi bağlamda aldığı. */
export interface DecisionContext {
    /** Kararı başlatan kullanıcı/sistem kimliği. */
    readonly actor_id: string;
    /** Aktörün rolü (operator, system, vb.). */
    readonly actor_role: string;
    /** Mevcut oturum kimliği. */
    readonly session_id: string;
    /**
     * İşlemin risk seviyesi.
     * intent=MODIFY_STATE ise bu alan CRITICAL olmak zorundadır.
     * CRITICAL ise insan onayı (ASK_HUMAN) tetiklenir.
     */
    readonly risk_level: RiskLevel;
    /** Hiyerarşik yol — opsiyonel. Örn: ["org", "team", "project"] */
    readonly hierarchy_path?: string[];
}
/** AI meta verisi — hangi model, hangi session, güven seviyesi. */
export interface DecisionMetadata {
    /** Kararı üreten model adı. Örn: "claude-sonnet-4-6" */
    readonly model: string;
    /** Session numarası. 0 veya negatif olamaz — REJECT. */
    readonly session_number: number;
    /**
     * AI'ın güven seviyesi.
     * HIGH + self_check_passed=false → REJECT (çelişki)
     * CRITICAL risk + HIGH → REJECT
     */
    readonly confidence: Confidence;
    /**
     * AI self-check'in geçip geçmediği.
     * false + confidence=HIGH → REJECT
     */
    readonly self_check_passed: boolean;
    /** Harcanan token bütçesi — opsiyonel, izleme amaçlı. */
    readonly token_budget_spent?: number;
}
/**
 * Decision Object — Sovereign Engine OS'un merkezi veri tipi.
 *
 * Tüm katmanlar arası iletişim bu tip üzerinden gerçekleşir.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.1 okunmalıdır.
 *
 * @example
 * ```typescript
 * const decision: Decision = {
 *   schema_version: "1.0",
 *   id:             "01952f3e-7b2a-7000-8000-000000000001",
 *   created_at:     "2026-05-04T08:00:00.000Z",
 *   intent:         "WRITE_DATA",
 *   category:       "USER_MANAGEMENT",
 *   payload: {
 *     action_name: "create_user",
 *     params:      { username: "alice", role: "viewer" },
 *   },
 *   context: {
 *     actor_id:   "operator-1",
 *     actor_role: "operator",
 *     session_id: "session-42",
 *     risk_level: "MEDIUM",
 *   },
 *   metadata: {
 *     model:             "claude-sonnet-4-6",
 *     session_number:    5,
 *     confidence:        "HIGH",
 *     self_check_passed: true,
 *   },
 *   status: "PENDING",
 * };
 * ```
 */
export interface Decision {
    /**
     * Şema versiyonu — Rust binary ile uyumluluk kontrolü.
     * Eksik veya uyumsuzsa REJECT.
     */
    readonly schema_version: "1.0";
    /** UUID v7 — zaman sıralı, benzersiz. */
    readonly id: string;
    /** Oluşturulma zamanı — ISO 8601. */
    readonly created_at: string;
    /** Kararın niyeti — risk seviyesini doğrudan etkiler. */
    readonly intent: Intent;
    /**
     * Domain kategorisi — domain adapter tarafından tanımlanır.
     * Regex: /^[A-Z_]+$/ — uyumsuzsa REJECT.
     * Örn: "USER_MANAGEMENT", "FINANCIAL_TRANSACTION"
     */
    readonly category: string;
    /** Kararın içeriği. */
    readonly payload: DecisionPayload;
    /** Bağlam bilgisi. */
    readonly context: DecisionContext;
    /** AI meta verisi. */
    readonly metadata: DecisionMetadata;
    /** Mevcut katman durumu. */
    status: DecisionStatus;
    /**
     * PENDING_HUMAN → token expire döngüsü sayacı.
     * TypeScript orchestration katmanı yönetir — Rust binary'e gönderilmez.
     *
     * - default: 0
     * - max: 3 — 3'e ulaşınca otomatik REJECTED (TOKEN_RETRY_LIMIT)
     * - Execution Gate EXPIRED_TOKEN döndürünce TypeScript retry_count++ yapar
     * - retry_count < 3 → insan yeniden onaylayabilir, Policy yeni token üretir
     * - retry_count >= 3 → status = "REJECTED", error_code: TOKEN_RETRY_LIMIT
     *
     * ARCHITECTURE.md §2.1, §3.3, §3.4 ve §7 (Shutdown)
     */
    retry_count?: number;
    /**
     * Hash chain — önceki AuditLog kaydının SHA-256 özeti.
     * İlk kayıtta yoktur, sonraki her kayıtta zorunludur.
     */
    readonly audit_hash?: string;
}
/** Decision tipini doğrular (runtime şema kontrolü için). */
export declare function isDecision(value: unknown): value is Decision;
/** Kilitli (immutable) durumda olup olmadığını kontrol eder. */
export declare function isImmutableStatus(status: DecisionStatus): status is ImmutableDecisionStatus;
/** MODIFY_STATE intent'i için risk seviyesi CRITICAL mi? */
export declare function isModifyStateValid(decision: Decision): boolean;
/** assumed_state kullanımı geçerli mi? */
export declare function isAssumedStateValid(decision: Decision): boolean;
//# sourceMappingURL=decision.d.ts.map