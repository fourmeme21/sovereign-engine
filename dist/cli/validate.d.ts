/**
 * Sovereign Engine OS — CLI validate komutu
 * @module src/cli/validate
 *
 * `sovereign validate <patch.json>`
 *
 * Akış (ARCHITECTURE.md §4 — Adım 1-3):
 *   1. patch.json yükle + Patch şema kontrolü
 *   2. Decision Object oluştur (status: PENDING)
 *   3. Validation Engine → PASS | REJECTED | ASK_HUMAN
 *
 * Exit kodları:
 *   0 = PASS
 *   1 = REJECTED
 *   2 = ASK_HUMAN
 *   3 = Dosya okuma hatası
 */
export interface ValidateOptions {
    json?: boolean;
}
export declare function runValidate(filePath: string, opts?: ValidateOptions): Promise<number>;
//# sourceMappingURL=validate.d.ts.map