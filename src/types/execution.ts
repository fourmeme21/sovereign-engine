/**
 * Sovereign Engine OS — Execution Result
 * @module core/types/execution
 *
 * Katman 4 (Execution Gate / Rust) çıktı tipi.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.5 okunmalıdır.
 *
 * Kurallar:
 *   - success=false → rolled_back=true olmalı (atomik rollback zorunlu)
 *   - audit_hash her zaman bulunur — hash chain
 *   - AuditLog her zaman yazılır — başarı veya hata fark etmez
 */

import type { Decision } from "./decision.js";

// ---------------------------------------------------------------------------
// Ana Tip
// ---------------------------------------------------------------------------

/**
 * Execution Result — Katman 4 (Execution Gate) çıktısı.
 * Domain Adapter (Katman 5) bu tipi giriş olarak alır.
 *
 * @example Başarılı
 * ```typescript
 * const result: ExecutionResult = {
 *   bundle_id:   "01952f3e-7b2a-7000-8000-000000000099",
 *   decision_id: "01952f3e-7b2a-7000-8000-000000000001",
 *   success:     true,
 *   audit_hash:  "sha256:abc123...",
 *   timestamp:   "2026-05-04T08:30:00.000Z",
 * };
 * ```
 *
 * @example Başarısız + rollback
 * ```typescript
 * const result: ExecutionResult = {
 *   bundle_id:   "01952f3e-7b2a-7000-8000-000000000100",
 *   decision_id: "01952f3e-7b2a-7000-8000-000000000001",
 *   success:     false,
 *   rolled_back: true,
 *   audit_hash:  "sha256:def456...",
 *   timestamp:   "2026-05-04T08:30:05.000Z",
 *   error:       "WRITE_FAIL: dosya yazılamadı",
 * };
 * ```
 */
export interface ExecutionResult {
  /** Bu execution işleminin benzersiz kimliği. UUID v7. */
  readonly bundle_id: string;

  /** İlgili Decision'ın kimliği — Decision.id ile eşleşmeli. */
  readonly decision_id: string;

  /**
   * İşlem başarılı mı?
   * false ise rolled_back=true olmalı — atomik rollback zorunlu.
   */
  readonly success: boolean;

  /**
   * Rollback yapıldı mı?
   * success=false → bu alan true olmalı.
   * ROLLBACK_FAIL durumunda sistem durdurulur.
   */
  readonly rolled_back?: boolean;

  /**
   * Hash chain — bu kaydın AuditLog'daki SHA-256 özeti.
   * Her zaman bulunur — başarı veya hata fark etmez.
   */
  readonly audit_hash: string;

  /** İşlem zamanı — ISO 8601. */
  readonly timestamp: string;

  /**
   * Hata mesajı — success=false olduğunda bulunur.
   * ARCHITECTURE.md §6 hata taksonomisindendir.
   */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Execution Gate Giriş Tipi
// ---------------------------------------------------------------------------

/**
 * Execution Gate'e gönderilen paket.
 * Protokol: JSON over stdin/stdout (ARCHITECTURE.md §3.4)
 */
export interface ExecutionGateInput {
  readonly decision:        Decision;
  readonly execution_token: string;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/** ExecutionResult tipini doğrular. */
export function isExecutionResult(value: unknown): value is ExecutionResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;

  return (
    typeof r["bundle_id"] === "string" &&
    typeof r["decision_id"] === "string" &&
    typeof r["success"] === "boolean" &&
    typeof r["audit_hash"] === "string" &&
    typeof r["timestamp"] === "string"
  );
}

/**
 * Başarısız execution rollback tutarlılığını kontrol eder.
 * success=false iken rolled_back=true olmalı.
 */
export function isRollbackConsistent(result: ExecutionResult): boolean {
  if (!result.success) {
    return result.rolled_back === true;
  }
  return true;
}
