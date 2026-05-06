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

import { readFile }                        from "fs/promises";
import { createValidationEngine }          from "../validation/engine.js";
import { isPatch, isConfidenceValid,
         isOperationsValid }               from "../types/patch.js";
import { formatError }                     from "../validation/errors.js";
import { patchToDecision, getCliActor }    from "./patch-to-decision.js";

// ---------------------------------------------------------------------------
// ANSI renk sabitleri
// ---------------------------------------------------------------------------
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

// ---------------------------------------------------------------------------
// Validate Komutu
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  json?: boolean;   // --json flag: makine okunabilir çıktı
}

export async function runValidate(filePath: string, opts: ValidateOptions = {}): Promise<number> {
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
  if (!isPatch(raw)) {
    const msg = "Geçersiz patch.json — schema_version, intent, confidence, patch alanları zorunludur.";
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: "REJECTED", reason: msg }) + "\n");
    } else {
      process.stderr.write(`${RED}✗ ${msg}${RESET}\n`);
    }
    return 1;
  }

  if (!isConfidenceValid(raw.confidence)) {
    const msg = `confidence alanı 0.0-1.0 arasında olmalıdır — alınan: ${raw.confidence}`;
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: "REJECTED", reason: msg }) + "\n");
    } else {
      process.stderr.write(`${RED}✗ ${msg}${RESET}\n`);
    }
    return 1;
  }

  if (!isOperationsValid(raw)) {
    const msg = "operations dizisi boş olamaz ve her search alanı dolu olmalıdır.";
    if (opts.json) {
      process.stdout.write(JSON.stringify({ status: "REJECTED", reason: msg }) + "\n");
    } else {
      process.stderr.write(`${RED}✗ ${msg}${RESET}\n`);
    }
    return 1;
  }

  // ── Adım 2: Decision Object Oluştur ───────────────────────────────────
  const actor    = getCliActor();
  const decision = patchToDecision(raw, actor);

  // ── Adım 3: Validation Engine ─────────────────────────────────────────
  const engine = createValidationEngine();
  const result = await engine.validate(decision);

  // ── Çıktı ─────────────────────────────────────────────────────────────
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status:      result.status,
      decision_id: result.data?.id ?? null,
      error:       result.error ?? null,
    }) + "\n");
  } else {
    if (result.status === "PASS") {
      process.stdout.write(
        `${GREEN}${BOLD}✓ PASS${RESET} — ${CYAN}${filePath}${RESET}\n` +
        `  Decision ID : ${result.data?.id}\n` +
        `  Status      : ${result.data?.status}\n` +
        `  Risk        : ${result.data?.context.risk_level}\n`
      );
    } else if (result.status === "REJECTED") {
      process.stderr.write(
        `${RED}${BOLD}✗ REJECTED${RESET} — ${CYAN}${filePath}${RESET}\n\n` +
        (result.error ? formatError(result.error) : "Bilinmeyen hata") + "\n"
      );
    } else {
      // ASK_HUMAN
      process.stdout.write(
        `${YELLOW}${BOLD}⚠ ASK_HUMAN${RESET} — ${CYAN}${filePath}${RESET}\n\n` +
        (result.error ? formatError(result.error) : "İnsan onayı gerekli") + "\n" +
        `\n  Decision ID : ${result.data?.id ?? "—"}\n`
      );
    }
  }

  return result.status === "PASS" ? 0 : result.status === "ASK_HUMAN" ? 2 : 1;
}
