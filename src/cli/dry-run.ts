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

import { readFile }                     from "fs/promises";
import { createValidationEngine }       from "../validation/engine.js";
import { isPatch, isConfidenceValid,
         isOperationsValid }            from "../types/patch.js";
import type { Patch, PatchOperation }   from "../types/patch.js";
import { formatError }                  from "../validation/errors.js";
import { patchToDecision, getCliActor } from "./patch-to-decision.js";
import { evaluatePolicy }               from "../policy/domain-rules.js";

// ---------------------------------------------------------------------------
// ANSI renk sabitleri
// ---------------------------------------------------------------------------
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const GRAY   = "\x1b[90m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

// ---------------------------------------------------------------------------
// Diff Üretimi
// ---------------------------------------------------------------------------

export interface DiffResult {
  file:         string;
  found:        boolean;
  operations:   OperationDiff[];
  total_ops:    number;
  applied_ops:  number;
}

export interface OperationDiff {
  index:    number;
  search:   string;
  replace:  string;
  found:    boolean;
  preview?: string;
}

/**
 * Hedef dosyayı okuyup patch operasyonlarının uygulanabilirliğini kontrol eder.
 * Dosyayı değiştirmez — sadece diff üretir.
 */
async function generateDiff(patch: Patch): Promise<DiffResult> {
  let content: string;
  let found = true;

  try {
    content = await readFile(patch.patch.file, "utf-8");
  } catch {
    return {
      file:        patch.patch.file,
      found:       false,
      operations:  [],
      total_ops:   patch.patch.operations.length,
      applied_ops: 0,
    };
  }

  const operations: OperationDiff[] = patch.patch.operations.map((op: PatchOperation, i: number) => {
    const searchFound = content.includes(op.search);
    let preview: string | undefined;

    if (searchFound) {
      const simulated = content.replace(op.search, op.replace);
      const idx       = simulated.indexOf(op.replace);
      const start     = Math.max(0, idx - 20);
      preview         = "..." + simulated.slice(start, start + 80) + "...";
    }

    return {
      index:   i + 1,
      search:  op.search,
      replace: op.replace,
      found:   searchFound,
      preview,
    };
  });

  return {
    file:        patch.patch.file,
    found,
    operations,
    total_ops:   operations.length,
    applied_ops: operations.filter(o => o.found).length,
  };
}

// ---------------------------------------------------------------------------
// Diff Yazdırma
// ---------------------------------------------------------------------------

function printDiff(diff: DiffResult): void {
  process.stdout.write(`\n${BOLD}📄 Hedef Dosya:${RESET} ${CYAN}${diff.file}${RESET}\n`);

  if (!diff.found) {
    process.stdout.write(`${RED}  ✗ Dosya bulunamadı${RESET}\n`);
    return;
  }

  process.stdout.write(`  Operasyon: ${diff.applied_ops}/${diff.total_ops} uygulanabilir\n\n`);

  diff.operations.forEach(op => {
    if (op.found) {
      process.stdout.write(
        `  ${GREEN}✓${RESET} Operasyon #${op.index}\n` +
        `    ${RED}- ${truncate(op.search, 60)}${RESET}\n` +
        `    ${GREEN}+ ${truncate(op.replace, 60)}${RESET}\n` +
        (op.preview ? `    ${GRAY}  ↳ ${op.preview}${RESET}\n` : "") +
        "\n"
      );
    } else {
      process.stdout.write(
        `  ${RED}✗${RESET} Operasyon #${op.index} — ${YELLOW}search metni bulunamadı${RESET}\n` +
        `    ${GRAY}Aranan: "${truncate(op.search, 60)}"${RESET}\n\n`
      );
    }
  });
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ---------------------------------------------------------------------------
// Dry-Run Komutu
// ---------------------------------------------------------------------------

export interface DryRunOptions {
  json?: boolean;
}

export async function runDryRun(filePath: string, opts: DryRunOptions = {}): Promise<number> {
  // ── Adım 1: Dosya Yükleme ──────────────────────────────────────────────
  let raw: unknown;
  try {
    const content = await readFile(filePath, "utf-8");
    raw = JSON.parse(content);
  } catch (e) {
    const msg = `Dosya okunamadı: ${filePath}\n${e instanceof Error ? e.message : String(e)}`;
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: "ERROR", reason: msg }) + "\n");
    } else {
      process.stderr.write(`${RED}✗ ${msg}${RESET}\n`);
    }
    return 3;
  }

  // ── Adım 1b: Patch Şema Kontrolü ──────────────────────────────────────
  if (!isPatch(raw) || !isConfidenceValid(raw.confidence) || !isOperationsValid(raw)) {
    const msg = "Geçersiz patch.json — önce `sovereign validate` çalıştırın.";
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: "REJECTED", reason: msg }) + "\n");
    } else {
      process.stderr.write(`${RED}✗ ${msg}${RESET}\n`);
    }
    return 1;
  }

  // ── Adım 2: Decision Object ────────────────────────────────────────────
  const actor    = getCliActor();
  const decision = patchToDecision(raw, actor);

  // ── Adım 3: Validation Engine ─────────────────────────────────────────
  const engine = createValidationEngine();
  const result = await engine.validate(decision);

  if (result.status !== "PASS") {
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        status: result.status,
        error:  result.error ?? null,
      }) + "\n");
    } else {
      const prefix = result.status === "ASK_HUMAN"
        ? `${YELLOW}${BOLD}⚠ ASK_HUMAN${RESET}`
        : `${RED}${BOLD}✗ REJECTED${RESET}`;
      process.stderr.write(
        `${prefix} — ${CYAN}${filePath}${RESET}\n\n` +
        (result.error ? formatError(result.error) : "") + "\n"
      );
    }
    return result.status === "ASK_HUMAN" ? 2 : 1;
  }

  // ── Adım 4: Policy Kernel — SAP-07 Fix ────────────────────────────────
  // Stub kaldırıldı. evaluatePolicy() çağrısı:
  //   - TypeScript domain kuralları önce (globalPolicyRegistry)
  //   - DENY/BLOCK → dry-run reddedilir
  //   - ASK_HUMAN → insan onayı beklenir
  //   - PERMIT → Rust hard lock'ları devreye girer
  const validatedDecision = result.data!;
  const policyResult = await evaluatePolicy(validatedDecision);

  if (policyResult.status === "DENY" || policyResult.status === "BLOCK") {
    const redirect = policyResult.redirect ?? "Policy reddetti — DENY.";
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        status:   policyResult.status,
        source:   policyResult.source,
        redirect,
      }) + "\n");
    } else {
      process.stderr.write(
        `${RED}${BOLD}✗ ${policyResult.status}${RESET} — ${CYAN}${filePath}${RESET}\n\n` +
        `  Kaynak  : ${policyResult.source}\n` +
        `  Sebep   : ${redirect}\n\n`
      );
    }
    return 1;
  }

  if (policyResult.status === "ASK_HUMAN") {
    const redirect = policyResult.redirect ?? "İnsan onayı gerekli.";
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        status:   "ASK_HUMAN",
        source:   policyResult.source,
        redirect,
      }) + "\n");
    } else {
      process.stdout.write(
        `${YELLOW}${BOLD}⚠ ASK_HUMAN${RESET} — ${CYAN}${filePath}${RESET}\n\n` +
        `  Kaynak  : ${policyResult.source}\n` +
        `  Sebep   : ${redirect}\n\n`
      );
    }
    return 2;
  }

  // ── Adım 5: Diff Üret ─────────────────────────────────────────────────
  const diff = await generateDiff(raw);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status:      "PASS",
      decision_id: validatedDecision.id,
      policy: {
        source:   policyResult.source,
        status:   policyResult.status,
        duration: policyResult.duration_ms,
      },
      diff,
    }) + "\n");
    return diff.found && diff.applied_ops === diff.total_ops ? 0 : 1;
  }

  // ── İnsan Okunabilir Çıktı ─────────────────────────────────────────────
  process.stdout.write(
    `\n${GREEN}${BOLD}✓ PASS${RESET} — ${CYAN}${filePath}${RESET}\n` +
    `  Decision ID : ${validatedDecision.id}\n` +
    `  Intent      : ${raw.intent}\n` +
    `  Risk        : ${validatedDecision.context.risk_level}\n` +
    `  Confidence  : ${raw.confidence}\n` +
    `  Policy      : ${policyResult.status} (${policyResult.source}, ${policyResult.duration_ms}ms)\n\n`
  );

  printDiff(diff);

  const allApplied = diff.found && diff.applied_ops === diff.total_ops;
  if (allApplied) {
    process.stdout.write(
      `\n${GREEN}${BOLD}✓ Dry-run tamamlandı${RESET} — tüm operasyonlar uygulanabilir.\n` +
      `  Uygulamak için: ${CYAN}sovereign apply ${filePath}${RESET}` +
      ` ${YELLOW}(Faz 4'te aktif olacak)${RESET}\n\n`
    );
  } else {
    process.stdout.write(
      `\n${RED}${BOLD}✗ Dry-run başarısız${RESET} — ${diff.total_ops - diff.applied_ops} operasyon uygulanamaz.\n` +
      `  Patch dosyasını güncelleyin ve tekrar deneyin.\n\n`
    );
  }

  return allApplied ? 0 : 1;
}
