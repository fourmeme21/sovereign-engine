/**
 * Sovereign Engine OS — Policy Result
 * @module core/types/policy
 *
 * Katman 3 (Policy Kernel / Rust) çıktı tipi.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.4 okunmalıdır.
 *
 * Kurallar:
 *   - DENY veya BLOCK → redirect alanı zorunlu, boş olamaz (soft steer)
 *   - execution_token → SADECE PERMIT'te bulunur
 *   - priority > 0 olmalı (NON_POSITIVE_VALUE)
 */
/**
 * Policy Kernel'ın karar tipi.
 *
 * | Değer     | Anlamı                                    | Exit Code |
 * |-----------|-------------------------------------------|-----------|
 * | PERMIT    | İşleme devam et — execution_token üretildi | 0       |
 * | BLOCK     | Hard lock tetiklendi — kesinlikle yasak   | 1         |
 * | ASK_HUMAN | İnsan onayı gerekli (CRITICAL risk, vb.)  | 2         |
 * | DENY      | Soft red — redirect mesajı zorunlu        | 1         |
 */
export type PolicyDecision = "PERMIT" | "BLOCK" | "ASK_HUMAN" | "DENY";
/**
 * DENY veya BLOCK sonuçları — redirect zorunlu.
 * Soft steer: kullanıcıya ne yapması gerektiği söylenir.
 */
export type BlockingPolicyDecision = "DENY" | "BLOCK";
/**
 * Policy Kernel hata kodları (ARCHITECTURE.md §3.3 Hard Lock Listesi).
 * Rust binary bu kodları üretir — TypeScript katmanı sadece okur.
 */
export type PolicyErrorCode = "IMMUTABLE_STATE" | "NON_POSITIVE_VALUE" | "HUMAN_APPROVAL_REQUIRED" | "NOT_RESOURCE_OWNER" | "POLICY_TIMEOUT" | "BINARY_CRASH";
/**
 * Policy Result — Katman 3 (Policy Kernel) çıktısı.
 *
 * @example PERMIT
 * ```typescript
 * const result: PolicyResult = {
 *   decision:        "PERMIT",
 *   priority:        10,
 *   execution_token: "eyJhbGciOiJIUzI1NiJ9...",
 * };
 * ```
 *
 * @example DENY (soft steer zorunlu)
 * ```typescript
 * const result: PolicyResult = {
 *   decision:   "DENY",
 *   priority:   1,
 *   error_code: "NOT_RESOURCE_OWNER",
 *   redirect:   "Bu kaynağı değiştirmek için kaynak sahibiyle iletişime geçin.",
 * };
 * ```
 */
export interface PolicyResult {
    /** Policy Kernel kararı. */
    readonly decision: PolicyDecision;
    /**
     * Kural önceliği — birden fazla kural eşleşirse yüksek priority kazanır.
     * 0 veya negatif olamaz — NON_POSITIVE_VALUE.
     */
    readonly priority: number;
    /**
     * Hata kodu — DENY veya BLOCK durumunda bulunur.
     * Rust binary tarafından üretilir.
     */
    readonly error_code?: PolicyErrorCode;
    /**
     * Yönlendirme mesajı — DENY veya BLOCK'ta zorunlu, boş olamaz.
     * Soft steer: kullanıcıya ne yapması gerektiğini açıklar.
     * PERMIT veya ASK_HUMAN'da bulunmaz.
     */
    readonly redirect?: string;
    /**
     * JWT execution token — SADECE decision=PERMIT'te bulunur.
     * Format: JWT HS256, 30 saniyelik expiry.
     * Execution Gate bu token'ı doğrulamadan çalışmaz.
     */
    readonly execution_token?: string;
}
/** PolicyResult tipini doğrular. */
export declare function isPolicyResult(value: unknown): value is PolicyResult;
/** PERMIT kararı mı? execution_token varlığını garanti eder. */
export declare function isPermit(result: PolicyResult): boolean;
/** Bloklayan karar mı? (DENY veya BLOCK) */
export declare function isBlocking(result: PolicyResult): result is PolicyResult & {
    redirect: string;
};
/** Priority değeri geçerli mi? */
export declare function isPriorityValid(priority: number): boolean;
//# sourceMappingURL=policy.d.ts.map