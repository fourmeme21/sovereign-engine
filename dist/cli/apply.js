/**
 * Sovereign Engine OS — CLI apply komutu (STUB)
 * @module src/cli/apply
 *
 * ⚠️ Bu komut Faz 4'e kadar aktif değildir.
 * ARCHITECTURE.md §4: apply komutu Faz 4 tamamlanmadan aktif edilemez.
 *
 * Faz 4'te eklenecekler:
 *   - Policy Kernel çağrısı (Rust binary)
 *   - execution_token doğrulama
 *   - Atomik dosya yazma + rollback
 *   - AuditLog hash chain kaydı
 *   - Idempotency kontrolü
 *
 * Exit kodu: 99 = Not implemented
 */
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
export async function runApply(_filePath) {
    process.stdout.write(`\n${YELLOW}${BOLD}⚠ sovereign apply — henüz aktif değil${RESET}\n\n` +
        `  Bu komut ${CYAN}Faz 4${RESET} tamamlandığında aktif olacak.\n\n` +
        `  Faz 4'te eklenecekler:\n` +
        `    • Policy Kernel (Rust binary) entegrasyonu\n` +
        `    • execution_token üretimi + doğrulama\n` +
        `    • Atomik dosya yazma + rollback\n` +
        `    • AuditLog hash chain kaydı\n` +
        `    • Idempotency kontrolü\n\n` +
        `  Şu an kullanabileceğin komutlar:\n` +
        `    ${CYAN}sovereign validate <patch.json>${RESET}  — şema + iş kuralı kontrolü\n` +
        `    ${CYAN}sovereign dry-run <patch.json>${RESET}   — diff üret, dosyaya dokunma\n\n`);
    return 99;
}
//# sourceMappingURL=apply.js.map