/**
 * Sovereign Engine OS — CLI dry-run komutu
 * @module src/cli/dry-run
 *
 * `sovereign dry-run <patch.json>`
 *
 * Akış (ARCHITECTURE.md §4 — Adım 1-5):
 *   1-3. validate ile aynı (Patch + Decision + ValidationEngine)
 *   4.   Policy Kernel — evaluatePolicy() (SAP-07 Fix)
 *   5.   Diff üret — dosyaya DOKUNMA
 *
 * SAP-07 Fix: Policy Kernel stub kaldırıldı.
 *   evaluatePolicy() çağrısı eklendi:
 *     - TypeScript domain kuralları önce çalışır
 *     - DENY/BLOCK → dry-run reddedilir, Rust'a gitmez
 *     - PERMIT → Rust hard lock'ları devreye girer
 *
 * ⚠️ dry-run hiçbir dosyayı değiştirmez — sadece gösterir.
 *
 * Exit kodları:
 *   0 = PASS + diff gösterildi
 *   1 = REJECTED
 *   2 = ASK_HUMAN
 *   3 = Dosya okuma hatası
 *   4 = Hedef dosya bulunamadı (diff için)
 */
export interface DiffResult {
    file: string;
    found: boolean;
    operations: OperationDiff[];
    total_ops: number;
    applied_ops: number;
}
export interface OperationDiff {
    index: number;
    search: string;
    replace: string;
    found: boolean;
    preview?: string;
}
export interface DryRunOptions {
    json?: boolean;
}
export declare function runDryRun(filePath: string, opts?: DryRunOptions): Promise<number>;
//# sourceMappingURL=dry-run.d.ts.map