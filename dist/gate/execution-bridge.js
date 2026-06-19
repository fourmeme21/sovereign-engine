/**
 * Sovereign Engine OS — Execution Gate Köprüsü
 * @module src/gate/execution-bridge
 *
 * TypeScript → Rust binary (sovereign-core execute modu) iletişim katmanı.
 * ARCHITECTURE.md §3.4 — Execution Gate protokolü.
 *
 * SAP-09: Bu dosya eksikti. kernel-bridge.ts (policy modu) ile aynı
 * pattern'da yazıldı — sadece "execute" modu ve ExecutionGateInput/Result
 * tipleri kullanılır.
 *
 * Fail-closed garantisi:
 *   - Timeout      → success: false + rolled_back: true
 *   - Binary crash → success: false + rolled_back: true
 *   - JSON parse   → success: false + rolled_back: true
 *   - Boş stdout   → success: false + rolled_back: true
 *   Herhangi bir hata → DENY + LOG — asla PERMIT değil.
 *
 * Execution Gate Doğrulama Zinciri (ARCHITECTURE.md §2.2):
 *   1. execution_token imzası geçerli mi?
 *   2. expires_at geçmedi mi?         (TOCTOU koruması — 30s)
 *   3. decision_id eşleşiyor mu?
 *   4. policy_hash eşleşiyor mu?
 *   Herhangi biri başarısız → DENY + LOG + NO_SIDE_EFFECT
 */
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------
/** Execution Gate timeout — aşılırsa fail-closed */
const GATE_TIMEOUT_MS = 10_000; // 10 saniye — execution policy'den uzun sürebilir
/** Rust binary yolu — kernel-bridge.ts ile aynı binary */
const KERNEL_BINARY = process.env["SOVEREIGN_KERNEL_PATH"]
    ?? join(__dirname, "../../sovereign-core/sovereign-policy-kernel");
// ---------------------------------------------------------------------------
// Ana Köprü Fonksiyonu
// ---------------------------------------------------------------------------
/**
 * Decision + execution_token'ı Rust Execution Gate'e gönderir.
 *
 * Fail-closed garantisi:
 *   - Timeout      → GateBridgeStatus "ERROR" + success: false
 *   - Binary crash → GateBridgeStatus "ERROR" + success: false
 *   - JSON parse   → GateBridgeStatus "ERROR" + success: false
 *
 * TOCTOU: execution_token 30 saniyede expire olur.
 * Rust Execution Gate token expiry'yi kendi doğrular.
 * TypeScript TOCTOU için isTokenExpired() ile ön kontrol yapabilir.
 *
 * @param input - Decision + execution_token çifti
 */
export async function callExecutionGate(input) {
    const startTime = Date.now();
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        const fail = (reason) => {
            if (settled)
                return;
            settled = true;
            resolve({
                status: "ERROR",
                error: reason,
                duration_ms: Date.now() - startTime,
                execution_result: {
                    bundle_id: "error-" + Date.now(),
                    decision_id: input.decision.id,
                    success: false,
                    rolled_back: true,
                    audit_hash: "error",
                    timestamp: new Date().toISOString(),
                    error: `Execution Gate hatası: ${reason}`,
                },
            });
        };
        // Binary'yi "execute" moduyla spawn et
        let gate;
        try {
            gate = spawn(KERNEL_BINARY, ["execute"], {
                env: {
                    ...process.env,
                    JWT_SECRET: process.env["JWT_SECRET"] ?? "",
                    SOVEREIGN_ACTOR_ID: process.env["SOVEREIGN_ACTOR_ID"] ?? "operator-1",
                },
                stdio: ["pipe", "pipe", "pipe"],
            });
        }
        catch (e) {
            return fail(`Binary başlatılamadı: ${KERNEL_BINARY} — ${String(e)}`);
        }
        // Timeout — fail-closed
        const timer = setTimeout(() => {
            timedOut = true;
            gate.kill("SIGTERM");
            fail(`Execution Gate timeout (${GATE_TIMEOUT_MS}ms) — fail-closed`);
        }, GATE_TIMEOUT_MS);
        // stdout topla
        gate.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        // stderr topla (log amaçlı)
        gate.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        // stdin'e ExecutionGateInput JSON gönder
        try {
            gate.stdin?.write(JSON.stringify(input) + "\n");
            gate.stdin?.end();
        }
        catch (e) {
            clearTimeout(timer);
            return fail(`stdin yazma hatası: ${String(e)}`);
        }
        // Process kapandı
        gate.on("close", (code) => {
            clearTimeout(timer);
            if (settled || timedOut)
                return;
            settled = true;
            const duration_ms = Date.now() - startTime;
            // stderr logla
            if (stderr.trim()) {
                process.stderr.write(`[ExecutionGate] ${stderr.trim()}\n`);
            }
            // Binary crash — exit 99 veya null
            if (code === null || (code !== 0 && code !== 1)) {
                resolve({
                    status: "ERROR",
                    error: `Binary exit code: ${code}`,
                    duration_ms,
                    execution_result: {
                        bundle_id: "crash-" + Date.now(),
                        decision_id: input.decision.id,
                        success: false,
                        rolled_back: true,
                        audit_hash: "crash",
                        timestamp: new Date().toISOString(),
                        error: `BINARY_CRASH: exit code ${code}`,
                    },
                });
                return;
            }
            // JSON parse
            const raw = stdout.trim();
            if (!raw) {
                resolve({
                    status: "ERROR",
                    error: "Boş stdout",
                    duration_ms,
                    execution_result: {
                        bundle_id: "empty-" + Date.now(),
                        decision_id: input.decision.id,
                        success: false,
                        rolled_back: true,
                        audit_hash: "empty",
                        timestamp: new Date().toISOString(),
                        error: "Execution Gate boş yanıt döndürdü",
                    },
                });
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch (e) {
                resolve({
                    status: "ERROR",
                    error: `JSON parse hatası: ${String(e)}`,
                    duration_ms,
                });
                return;
            }
            // Exit kodu → status
            // exit 0 = success, exit 1 = failed/denied
            const status = parsed.success
                ? "SUCCESS"
                : parsed.rolled_back
                    ? "FAILED"
                    : "DENIED";
            resolve({
                status,
                execution_result: parsed,
                duration_ms,
            });
        });
        gate.on("error", (err) => {
            clearTimeout(timer);
            fail(`Binary spawn hatası: ${err.message}`);
        });
    });
}
// ---------------------------------------------------------------------------
// Sağlık Kontrolü
// ---------------------------------------------------------------------------
/**
 * Execution Gate binary'nin erişilebilir olduğunu doğrular.
 * kernel-bridge.ts healthCheck() ile aynı binary kontrol edilir.
 * Ayrı çağrı — execution modunu test etmez, sadece binary varlığını kontrol eder.
 */
export async function executionGateHealthCheck() {
    return new Promise((resolve) => {
        let gate;
        try {
            gate = spawn(KERNEL_BINARY, ["healthcheck"], {
                stdio: ["ignore", "pipe", "ignore"],
            });
        }
        catch {
            return resolve(false);
        }
        const timer = setTimeout(() => {
            gate.kill();
            resolve(false);
        }, 2000);
        gate.on("close", (code) => {
            clearTimeout(timer);
            resolve(code === 0);
        });
        gate.on("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}
//# sourceMappingURL=execution-bridge.js.map