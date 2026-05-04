/**
 * Sovereign Engine OS — PreFlight Result
 * @module core/types/preflight
 *
 * Katman 2 (Validation Engine) pre-flight read çıktısı.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.6 okunmalıdır.
 *
 * Amaç: assumed_state'in hâlâ geçerli olup olmadığını doğrular.
 * Bayatlamışsa RE_EVALUATE tetiklenir — max 3 kez, sonra ASK_HUMAN.
 */

// ---------------------------------------------------------------------------
// Temel Tipler
// ---------------------------------------------------------------------------

/**
 * Pre-flight başarısız olduğunda neden başarısız olduğu.
 *
 * | Değer          | Anlamı                                      |
 * |----------------|---------------------------------------------|
 * | RE_EVALUATE    | assumed_state bayatlamış — yeniden değerlendir |
 * | ENTITY_INACTIVE | Kayıt artık aktif değil                    |
 * | STATE_CHANGED  | Durum değişmiş — assumed_state geçersiz     |
 */
export type PreFlightReason =
  | "RE_EVALUATE"      // assumed_state bayatlamış — max 3 kez, sonra ASK_HUMAN
  | "ENTITY_INACTIVE"  // Kayıt artık geçerli değil
  | "STATE_CHANGED";   // Durum değişmiş, assumed_state geçersiz

/** Maximum RE_EVALUATE tekrar sayısı — aşılırsa ASK_HUMAN'a düşer. */
export const MAX_RE_EVALUATE_COUNT = 3;

// ---------------------------------------------------------------------------
// Ana Tip
// ---------------------------------------------------------------------------

/**
 * PreFlight Result — Validation Engine'in bayat veri koruması çıktısı.
 *
 * EXECUTE_ACTION veya MODIFY_STATE içeren her işlemde uygulanır.
 * assumed_state doğrulanmadan bu intent'lere geçilemez.
 *
 * @example Temiz
 * ```typescript
 * const result: PreFlightResult = {
 *   clear: true,
 * };
 * ```
 *
 * @example Bayat veri
 * ```typescript
 * const result: PreFlightResult = {
 *   clear:            false,
 *   reason:           "STATE_CHANGED",
 *   stale_fields:     ["status", "updated_at"],
 *   current_snapshot: { status: "INACTIVE", updated_at: "2026-05-04T09:00:00Z" },
 *   retry_count:      1,
 * };
 * ```
 */
export interface PreFlightResult {
  /**
   * Pre-flight geçti mi?
   * true  → assumed_state geçerli, devam edilebilir
   * false → assumed_state bayat veya kayıt geçersiz
   */
  readonly clear: boolean;

  /**
   * Başarısızlık sebebi — clear=false olduğunda bulunur.
   * RE_EVALUATE → retry_count kontrol edilmeli.
   */
  readonly reason?: PreFlightReason;

  /**
   * Bayatlamış alan listesi — hangi alanların değiştiği.
   * clear=false ve reason=STATE_CHANGED/RE_EVALUATE'te bulunur.
   */
  readonly stale_fields?: string[];

  /**
   * Sistemdeki gerçek anlık görüntü — assumed_state ile karşılaştırma için.
   * Validation Engine bu veriyi Domain Adapter'dan okur.
   */
  readonly current_snapshot?: Record<string, unknown>;

  /**
   * Kaç kez RE_EVALUATE yapıldı.
   * MAX_RE_EVALUATE_COUNT (3) aşılırsa → ASK_HUMAN'a düşer.
   */
  readonly retry_count?: number;
}

// ---------------------------------------------------------------------------
// Type Guards & Yardımcılar
// ---------------------------------------------------------------------------

/** PreFlightResult tipini doğrular. */
export function isPreFlightResult(value: unknown): value is PreFlightResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r["clear"] === "boolean";
}

/**
 * RE_EVALUATE sayısı maksimuma ulaştı mı?
 * true → ASK_HUMAN'a düşmeli.
 */
export function shouldEscalateToHuman(result: PreFlightResult): boolean {
  return (
    result.reason === "RE_EVALUATE" &&
    typeof result.retry_count === "number" &&
    result.retry_count >= MAX_RE_EVALUATE_COUNT
  );
}

/** Pre-flight geçti mi ve devam edilebilir mi? */
export function isPreFlightClear(result: PreFlightResult): boolean {
  return result.clear === true;
}
