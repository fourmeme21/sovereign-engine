/**
 * Sovereign Engine OS — Policy Kernel Köprüsü
 * @module src/policy/kernel-bridge
 *
 * TypeScript CLI → Rust binary (sovereign-policy-kernel) iletişim katmanı.
 * ARCHITECTURE.md §3.3 — Timeout: 5000ms → fail-closed
 *
 * Hiçbir AI raporunda yoktu — SE OS'a özgün tasarım.
 */

import { spawn }               from "child_process";
import { join, dirname }       from "path";
import { fileURLToPath }       from "url";
import type { Decision }       from "../types/decision.js";
import type { PolicyResult }   from "../types/policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------

/** Policy Kernel timeout — aşılırsa fail-closed (DENY) */
const KERNEL_TIMEOUT_MS = 5000;

/** Rust binary yolu */
const KERNEL_BINARY = process.env["SOVEREIGN_KERNEL_PATH"]
  ?? join(__dirname, "../../sovereign-core/sovereign-policy-kernel");

// ---------------------------------------------------------------------------
// Köprü Sonuç Tipi
// ---------------------------------------------------------------------------

export type KernelBridgeStatus = "PERMIT" | "DENY" | "BLOCK" | "ASK_HUMAN" | "ERROR";

export interface KernelBridgeResult {
  status:           KernelBridgeStatus;
  policy_result?:   PolicyResult;
  error?:           string;
  duration_ms:      number;
}

// ---------------------------------------------------------------------------
// Ana Köprü Fonksiyonu
// ---------------------------------------------------------------------------

/**
 * Decision'ı Rust binary'e gönderir, PolicyResult alır.
 *
 * Fail-closed garantisi:
 *   - Timeout → DENY
 *   - Binary crash → DENY
 *   - JSON parse hatası → DENY
 *   - Boş çıktı → DENY
 *
 * @param decision - VALIDATED durumundaki Decision
 */
export async function callPolicyKernel(
  decision: Decision
): Promise<KernelBridgeResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdout     = "";
    let stderr     = "";
    let timedOut   = false;
    let settled    = false;

    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      resolve({
        status:      "ERROR",
        error:       reason,
        duration_ms: Date.now() - startTime,
        policy_result: {
          decision:   "DENY",
          priority:   0,
          error_code: "BINARY_CRASH",
          redirect:   `Policy Kernel hatası: ${reason}. Sistem güvenli tarafta — DENY.`,
        } as unknown as PolicyResult,
      });
    };

    // Binary'yi spawn et
    // SAP-01 FIX: "policy" modu argümanı eklendi — main.rs match "policy" bekliyor
    let kernel: ReturnType<typeof spawn>;
    try {
      kernel = spawn(KERNEL_BINARY, ["policy"], {
        env: {
          ...process.env,
          JWT_SECRET:          process.env["JWT_SECRET"] ?? "",
          SOVEREIGN_ACTOR_ID:  process.env["SOVEREIGN_ACTOR_ID"] ?? "operator-1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return fail(`Binary başlatılamadı: ${KERNEL_BINARY} — ${String(e)}`);
    }

    // Timeout — 5000ms aşılırsa fail-closed
    const timer = setTimeout(() => {
      timedOut = true;
      kernel.kill("SIGTERM");
      fail(`Policy Kernel timeout (${KERNEL_TIMEOUT_MS}ms) — fail-closed DENY`);
    }, KERNEL_TIMEOUT_MS);

    // stdout topla
    kernel.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // stderr topla (log amaçlı)
    kernel.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // stdin'e Decision JSON gönder
    try {
      kernel.stdin?.write(JSON.stringify(decision) + "\n");
      kernel.stdin?.end();
    } catch (e) {
      clearTimeout(timer);
      return fail(`stdin yazma hatası: ${String(e)}`);
    }

    // Process kapandı
    kernel.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (settled || timedOut) return;
      settled = true;

      const duration_ms = Date.now() - startTime;

      // stderr'i logla (kritik binary hatası)
      if (stderr.trim()) {
        process.stderr.write(`[PolicyKernel] ${stderr.trim()}\n`);
      }

      // Binary crash
      if (code === null || (code !== 0 && code !== 1 && code !== 2)) {
        resolve({
          status:      "ERROR",
          error:       `Binary exit code: ${code}`,
          duration_ms,
          policy_result: {
            decision:   "DENY",
            priority:   0,
            error_code: "BINARY_CRASH",
            redirect:   "Policy Kernel beklenmeyen çıkış kodu — DENY + LOG.",
          } as unknown as PolicyResult,
        });
        return;
      }

      // JSON parse
      const raw = stdout.trim();
      if (!raw) {
        resolve({
          status:      "ERROR",
          error:       "Boş stdout",
          duration_ms,
          policy_result: {
            decision:   "DENY",
            priority:   0,
            error_code: "BINARY_CRASH",
            redirect:   "Policy Kernel boş yanıt döndürdü — DENY.",
          } as unknown as PolicyResult,
        });
        return;
      }

      let parsed: PolicyResult;
      try {
        parsed = JSON.parse(raw) as PolicyResult;
      } catch (e) {
        resolve({
          status:      "ERROR",
          error:       `JSON parse hatası: ${String(e)}`,
          duration_ms,
        });
        return;
      }

      // Exit kodu → status
      const statusMap: Record<number, KernelBridgeStatus> = {
        0: "PERMIT",
        1: parsed.decision === "BLOCK" ? "BLOCK" : "DENY",
        2: "ASK_HUMAN",
      };

      resolve({
        status:       statusMap[code ?? 99] ?? "ERROR",
        policy_result: parsed,
        duration_ms,
      });
    });

    kernel.on("error", (err: Error) => {
      clearTimeout(timer);
      fail(`Binary spawn hatası: ${err.message}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Sağlık Kontrolü
// ---------------------------------------------------------------------------

/**
 * Policy Kernel binary'nin mevcut ve çalışır olduğunu doğrular.
 * Startup fail-closed: binary yoksa sistem başlamaz.
 *
 * SAP-02 FIX:
 *   - "healthcheck" modu kullanılıyor — main.rs bu modu tanıyor
 *   - resolve(code === 0) — ARCH §7: "exit 0 değilse sistem başlamaz"
 */
export async function healthCheck(): Promise<boolean> {
  return new Promise((resolve) => {
    const kernel = spawn(KERNEL_BINARY, ["healthcheck"], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      kernel.kill();
      resolve(false);
    }, 2000);

    kernel.on("close", (code: number | null) => {
      clearTimeout(timer);
      // ARCH §7: exit 0 = sağlıklı, diğer her kod = fail-closed
      resolve(code === 0);
    });

    kernel.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
