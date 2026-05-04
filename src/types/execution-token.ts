/**
 * Sovereign Engine OS — Execution Token (JWT Payload)
 * @module core/types/execution-token
 *
 * Policy Kernel PERMIT verdiğinde üretilen JWT'nin payload tipi.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.2 okunmalıdır.
 *
 * Token Özellikleri:
 *   - Algoritma : JWT HS256
 *   - Expiry    : issued_at + 30 saniye (TOCTOU koruması)
 *   - İmzalayan : sovereign-core binary içindeki secret
 *
 * Execution Gate Doğrulama Kuralları (ARCHITECTURE.md §2.2):
 *   1. İmza geçerli mi?              → Geçersizse DENY + LOG
 *   2. expires_at geçmedi mi?        → Geçmişse DENY + LOG (TOCTOU)
 *   3. decision_id eşleşiyor mu?     → Eşleşmiyorsa DENY + LOG
 *   4. policy_hash eşleşiyor mu?     → Eşleşmiyorsa DENY + LOG
 *   Herhangi biri başarısız → DENY + LOG + NO_SIDE_EFFECT
 */

/** JWT token expiry süresi (saniye). */
export const EXECUTION_TOKEN_EXPIRY_SECONDS = 30;

// ---------------------------------------------------------------------------
// Ana Tip
// ---------------------------------------------------------------------------

/**
 * Execution Token JWT Payload.
 *
 * Policy Kernel bu payload'u HS256 ile imzalar.
 * Execution Gate imzayı doğrular, sonra alanları tek tek kontrol eder.
 *
 * @example
 * ```typescript
 * const payload: ExecutionTokenPayload = {
 *   decision_id: "01952f3e-7b2a-7000-8000-000000000001",
 *   policy_hash: "sha256:abc123def456...",
 *   actor_id:    "operator-1",
 *   action_name: "create_user",
 *   issued_at:   1746345600,
 *   expires_at:  1746345630,   // issued_at + 30
 *   scope:       "USER_MANAGEMENT:create_user",
 * };
 * ```
 */
export interface ExecutionTokenPayload {
  /**
   * İlgili Decision'ın kimliği.
   * Execution Gate bu değeri Decision.id ile karşılaştırır.
   */
  readonly decision_id: string;

  /**
   * Canonical decision + policy_result'ın SHA-256 özeti.
   * Format: SHA-256(canonical(decision) + policy_result)
   * Canonical serializasyon: serde_jcs / RFC 8785
   * Eşleşmiyorsa → HASH_MISMATCH → DENY + LOG
   */
  readonly policy_hash: string;

  /** Kararı başlatan aktörün kimliği — Decision.context.actor_id ile aynı. */
  readonly actor_id: string;

  /** Çalıştırılacak aksiyon — Decision.payload.action_name ile aynı. */
  readonly action_name: string;

  /**
   * Token üretim zamanı — Unix timestamp (saniye).
   * expires_at = issued_at + EXECUTION_TOKEN_EXPIRY_SECONDS
   */
  readonly issued_at: number;

  /**
   * Token geçerlilik sonu — Unix timestamp (saniye).
   * Bu süre geçmişse → EXPIRED_TOKEN → DENY + LOG (TOCTOU koruması)
   */
  readonly expires_at: number;

  /**
   * Token kapsamı — hangi kategori ve aksiyona izin verildiği.
   * Format: "{category}:{action_name}"
   * Örn: "USER_MANAGEMENT:create_user"
   */
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// Type Guards & Yardımcılar
// ---------------------------------------------------------------------------

/** ExecutionTokenPayload tipini doğrular. */
export function isExecutionTokenPayload(value: unknown): value is ExecutionTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;

  return (
    typeof p["decision_id"] === "string" &&
    typeof p["policy_hash"] === "string" &&
    typeof p["actor_id"] === "string" &&
    typeof p["action_name"] === "string" &&
    typeof p["issued_at"] === "number" &&
    typeof p["expires_at"] === "number" &&
    typeof p["scope"] === "string"
  );
}

/**
 * Token süresi dolmuş mu?
 * true → EXPIRED_TOKEN → DENY + LOG (TOCTOU koruması)
 */
export function isTokenExpired(payload: ExecutionTokenPayload, nowSeconds?: number): boolean {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return now >= payload.expires_at;
}

/**
 * Token scope'u Decision ile eşleşiyor mu?
 * Format kontrolü: "{category}:{action_name}"
 */
export function isScopeValid(
  payload: ExecutionTokenPayload,
  category: string,
  actionName: string
): boolean {
  return payload.scope === `${category}:${actionName}`;
}

/**
 * expires_at tutarlılığını kontrol eder.
 * expires_at === issued_at + 30 olmalı.
 */
export function isExpiryConsistent(payload: ExecutionTokenPayload): boolean {
  return payload.expires_at === payload.issued_at + EXECUTION_TOKEN_EXPIRY_SECONDS;
}
