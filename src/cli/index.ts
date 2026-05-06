#!/usr/bin/env node
/**
 * Sovereign Engine OS — CLI Giriş Noktası
 * @module src/cli/index
 *
 * Komutlar (ARCHITECTURE.md §4 CLI Komutları):
 *   sovereign validate <patch.json>   → Faz 2 ✅
 *   sovereign dry-run <patch.json>    → Faz 2 ✅
 *   sovereign apply <patch.json>      → Faz 4 (stub — Not implemented)
 *   sovereign status                  → Faz 3 (stub)
 *   sovereign log [n]                 → Faz 4 (stub)
 *
 * Exit kodları:
 *   0  = PASS
 *   1  = REJECTED
 *   2  = ASK_HUMAN
 *   3  = Dosya okuma hatası
 *   4  = Hedef dosya bulunamadı
 *   99 = Not implemented
 */

import { runValidate } from "./validate.js";
import { runDryRun }   from "./dry-run.js";
import { runApply }    from "./apply.js";

const VERSION = "3.0.0";
const CYAN    = "\x1b[36m";
const GRAY    = "\x1b[90m";
const YELLOW  = "\x1b[33m";
const RESET   = "\x1b[0m";
const BOLD    = "\x1b[1m";

// ---------------------------------------------------------------------------
// Yardım Metni
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    `\n${BOLD}Sovereign Engine OS${RESET} v${VERSION}\n\n` +
    `${BOLD}Kullanım:${RESET}\n` +
    `  sovereign <komut> [dosya] [seçenekler]\n\n` +
    `${BOLD}Komutlar:${RESET}\n` +
    `  ${CYAN}validate${RESET} <patch.json>    Şema + iş kuralı kontrolü\n` +
    `  ${CYAN}dry-run${RESET}  <patch.json>    Diff üret — dosyaya dokunma\n` +
    `  ${YELLOW}apply${RESET}    <patch.json>    ${GRAY}Faz 4'te aktif olacak${RESET}\n` +
    `  ${YELLOW}status${RESET}                   ${GRAY}Faz 3'te aktif olacak${RESET}\n` +
    `  ${YELLOW}log${RESET}      [n]             ${GRAY}Faz 4'te aktif olacak${RESET}\n\n` +
    `${BOLD}Seçenekler:${RESET}\n` +
    `  --json    Makine okunabilir JSON çıktısı\n` +
    `  --help    Bu yardım metnini göster\n` +
    `  --version Versiyon numarasını göster\n\n` +
    `${BOLD}Örnekler:${RESET}\n` +
    `  sovereign validate my-patch.json\n` +
    `  sovereign dry-run my-patch.json\n` +
    `  sovereign validate my-patch.json --json\n\n`
  );
}

// ---------------------------------------------------------------------------
// CLI Ana Akışı
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Bayrakları ayıkla
  const jsonFlag = args.includes("--json");
  const filtered = args.filter(a => !a.startsWith("--"));
  const [command, filePath] = filtered;

  // --version
  if (args.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  // --help veya komut yok
  if (!command || args.includes("--help")) {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  let exitCode: number;

  switch (command) {
    case "validate": {
      if (!filePath) {
        process.stderr.write(`Hata: validate komutu bir dosya yolu gerektirir.\nKullanım: sovereign validate <patch.json>\n`);
        process.exit(1);
      }
      exitCode = await runValidate(filePath, { json: jsonFlag });
      break;
    }

    case "dry-run": {
      if (!filePath) {
        process.stderr.write(`Hata: dry-run komutu bir dosya yolu gerektirir.\nKullanım: sovereign dry-run <patch.json>\n`);
        process.exit(1);
      }
      exitCode = await runDryRun(filePath, { json: jsonFlag });
      break;
    }

    case "apply": {
      if (!filePath) {
        process.stderr.write(`Hata: apply komutu bir dosya yolu gerektirir.\nKullanım: sovereign apply <patch.json>\n`);
        process.exit(1);
      }
      exitCode = await runApply(filePath);
      break;
    }

    case "status": {
      process.stdout.write(`${YELLOW}⚠ sovereign status — Faz 3'te aktif olacak${RESET}\n`);
      exitCode = 99;
      break;
    }

    case "log": {
      process.stdout.write(`${YELLOW}⚠ sovereign log — Faz 4'te aktif olacak${RESET}\n`);
      exitCode = 99;
      break;
    }

    default: {
      process.stderr.write(`Bilinmeyen komut: "${command}"\n\n`);
      printHelp();
      exitCode = 1;
    }
  }

  process.exit(exitCode);
}

main().catch(err => {
  process.stderr.write(`Beklenmeyen hata: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
