/**
 * Sovereign Engine OS — Patch Object
 * @module core/types/patch
 *
 * CLI katmanının giriş tipi — patch.json dosyasının şeması.
 * Değişiklik yapmadan önce ARCHITECTURE.md §2.3 okunmalıdır.
 *
 * Şema Kısıtları (ARCHITECTURE.md §2.3):
 *   - schema_version eksik       → REJECT
 *   - Herhangi bir alan eksik    → REJECT
 *   - operations boş dizi        → REJECT
 *   - search metni bulunamazsa   → REJECT
 *   - confidence < 0 veya > 1    → REJECT
 */

// ---------------------------------------------------------------------------
// Alt Tipler
// ---------------------------------------------------------------------------

/**
 * Tek bir metin değiştirme operasyonu.
 * search bulunamazsa işlem iptal edilir — SEARCH_NOT_FOUND hatası.
 */
export interface PatchOperation {
  /** Aranacak metin — bulunamazsa REJECT. */
  readonly search: string;

  /** Yerleştirilecek metin. */
  readonly replace: string;
}

/** Patch risk seviyesi — küçük harf, Decision'daki RiskLevel'den ayrıdır. */
export type PatchRiskLevel = "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Ana Tip
// ---------------------------------------------------------------------------

/**
 * Patch Object — CLI `sovereign apply` komutunun giriş dosyası.
 *
 * @example
 * ```json
 * {
 *   "schema_version": "1.0",
 *   "intent": "Kullanıcı rolünü güncelle",
 *   "risk_level": "medium",
 *   "confidence": 0.95,
 *   "patch": {
 *     "file": "domain/project/config.ts",
 *     "operations": [
 *       { "search": "role: \"viewer\"", "replace": "role: \"editor\"" }
 *     ]
 *   }
 * }
 * ```
 */
export interface Patch {
  /** Şema versiyonu — eksikse REJECT. */
  readonly schema_version: "1.0";

  /** Değişikliğin insan okunabilir amacı. */
  readonly intent: string;

  /** İşlem risk seviyesi. */
  readonly risk_level: PatchRiskLevel;

  /**
   * AI güven skoru — 0.0 ile 1.0 arasında olmalı.
   * < 0 veya > 1 → REJECT
   */
  readonly confidence: number;

  /** Uygulanacak dosya ve operasyonlar. */
  readonly patch: {
    /** Değiştirilecek dosyanın yolu. */
    readonly file: string;

    /**
     * Değiştirme operasyonları — sırayla uygulanır.
     * Boş dizi → REJECT.
     */
    readonly operations: readonly PatchOperation[];
  };
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/** Patch tipini doğrular (runtime şema kontrolü). */
export function isPatch(value: unknown): value is Patch {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;

  if (p["schema_version"] !== "1.0") return false;
  if (typeof p["intent"] !== "string") return false;
  if (typeof p["risk_level"] !== "string") return false;
  if (typeof p["confidence"] !== "number") return false;
  if (typeof p["patch"] !== "object" || p["patch"] === null) return false;

  const patch = p["patch"] as Record<string, unknown>;
  if (typeof patch["file"] !== "string") return false;
  if (!Array.isArray(patch["operations"])) return false;

  return true;
}

/** Confidence değeri geçerli aralıkta mı? */
export function isConfidenceValid(confidence: number): boolean {
  return confidence >= 0 && confidence <= 1;
}

/** Operations dizisi geçerli mi? */
export function isOperationsValid(patch: Patch): boolean {
  return (
    patch.patch.operations.length > 0 &&
    patch.patch.operations.every(
      (op) =>
        typeof op.search === "string" &&
        op.search.length > 0 &&
        typeof op.replace === "string"
    )
  );
}
