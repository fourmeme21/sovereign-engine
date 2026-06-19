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
/** Patch tipini doğrular (runtime şema kontrolü). */
export declare function isPatch(value: unknown): value is Patch;
/** Confidence değeri geçerli aralıkta mı? */
export declare function isConfidenceValid(confidence: number): boolean;
/** Operations dizisi geçerli mi? */
export declare function isOperationsValid(patch: Patch): boolean;
//# sourceMappingURL=patch.d.ts.map