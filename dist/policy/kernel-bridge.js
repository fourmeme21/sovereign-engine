/**
 * Sovereign Engine OS — Policy Kernel Köprüsü
 * @module src/policy/kernel-bridge
 *
 * TypeScript CLI → Rust binary (sovereign-policy-kernel) iletişim katmanı.
 * ARCHITECTURE.md §3.3 — Timeout: 5000ms → fail-closed
 *
 * Hiçbir AI raporunda yoktu — SE OS'a özgün tasarım.
 */
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
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
export async function callPolicyKernel(decision) {
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
                policy_result: {
                    decision: "DENY",
                    priority: 0,
                    error_code: "BINARY_CRASH",
                    redirect: `Policy Kernel hatası: ${reason}. Sistem güvenli tarafta — DENY.`,
                },
            });
        };
        // Binary'yi spawn et
        // SAP-01 FIX: "policy" modu argümanı eklendi — main.rs match "policy" bekliyor
        let kernel;
        try {
            kernel = spawn(KERNEL_BINARY, ["policy"], {
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
        // Timeout — 5000ms aşılırsa fail-closed
        const timer = setTimeout(() => {
            timedOut = true;
            kernel.kill("SIGTERM");
            fail(`Policy Kernel timeout (${KERNEL_TIMEOUT_MS}ms) — fail-closed DENY`);
        }, KERNEL_TIMEOUT_MS);
        // stdout topla
        kernel.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        // stderr topla (log amaçlı)
        kernel.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        // stdin'e Decision JSON gönder
        try {
            kernel.stdin?.write(JSON.stringify(decision) + "\n");
            kernel.stdin?.end();
        }
        catch (e) {
            clearTimeout(timer);
            return fail(`stdin yazma hatası: ${String(e)}`);
        }
        // Process kapandı
        kernel.on("close", (code) => {
            clearTimeout(timer);
            if (settled || timedOut)
                return;
            settled = true;
            const duration_ms = Date.now() - startTime;
            // stderr'i logla (kritik binary hatası)
            if (stderr.trim()) {
                process.stderr.write(`[PolicyKernel] ${stderr.trim()}\n`);
            }
            // Binary crash
            if (code === null || (code !== 0 && code !== 1 && code !== 2)) {
                resolve({
                    status: "ERROR",
                    error: `Binary exit code: ${code}`,
                    duration_ms,
                    policy_result: {
                        decision: "DENY",
                        priority: 0,
                        error_code: "BINARY_CRASH",
                        redirect: "Policy Kernel beklenmeyen çıkış kodu — DENY + LOG.",
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
                    policy_result: {
                        decision: "DENY",
                        priority: 0,
                        error_code: "BINARY_CRASH",
                        redirect: "Policy Kernel boş yanıt döndürdü — DENY.",
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
            const statusMap = {
                0: "PERMIT",
                1: parsed.decision === "BLOCK" ? "BLOCK" : "DENY",
                2: "ASK_HUMAN",
            };
            resolve({
                status: statusMap[code ?? 99] ?? "ERROR",
                policy_result: parsed,
                duration_ms,
            });
        });
        kernel.on("error", (err) => {
            clearTimeout(timer);
            fail(`Binary spawn hatası: ${err.message}`);
        });
    });
}
// ---------------------------------------------------------------------------
// PENDING_HUMAN Orkestrasyon Yardımcıları
// ---------------------------------------------------------------------------
/** Token expire döngüsünde izin verilen maksimum deneme sayısı. */
const MAX_RETRY_COUNT = 3;
/**
 * Policy Kernel'den ASK_HUMAN döndüğünde çağrılır.
 * Decision.status → "PENDING_HUMAN", retry_count başlatılır (yoksa 0).
 *
 * ARCHITECTURE.md §3.3:
 *   ASK_HUMAN çıktısında TypeScript orchestration:
 *     → Decision.status = "PENDING_HUMAN"
 *     → Decision.retry_count = (mevcut değer veya 0)
 *     → execution_token üretilmez — insan onayı beklenir
 *
 * @param decision - VALIDATED durumundaki Decision
 * @returns Güncellenmiş Decision (status: PENDING_HUMAN)
 */
export function applyAskHuman(decision) {
    return {
        ...decision,
        status: "PENDING_HUMAN",
        retry_count: decision.retry_count ?? 0,
    };
}
/**
 * Execution Gate EXPIRED_TOKEN döndürdüğünde çağrılır.
 * retry_count++ — sınıra ulaşılırsa otomatik REJECTED.
 *
 * ARCHITECTURE.md §3.4:
 *   EXPIRED_TOKEN alınca TypeScript orchestration:
 *     → Decision.status değişmez ("PENDING_HUMAN" kalır)
 *     → Decision.retry_count++
 *     → retry_count >= 3 → status = "REJECTED", error_code: TOKEN_RETRY_LIMIT
 *     → retry_count < 3  → insan yeniden onaylayabilir
 *
 * @param decision - PENDING_HUMAN durumundaki Decision
 * @returns { decision: Decision, limitReached: boolean }
 *          limitReached=true → status "REJECTED" olarak ayarlandı (TOKEN_RETRY_LIMIT)
 */
export function handleExpiredToken(decision) {
    const newCount = (decision.retry_count ?? 0) + 1;
    if (newCount >= MAX_RETRY_COUNT) {
        return {
            decision: { ...decision, status: "REJECTED", retry_count: newCount },
            limitReached: true,
        };
    }
    return {
        decision: { ...decision, status: "PENDING_HUMAN", retry_count: newCount },
        limitReached: false,
    };
}
/**
 * Policy Kernel binary'nin mevcut ve çalışır olduğunu doğrular.
 * Startup fail-closed: binary yoksa sistem başlamaz.
 *
 * SAP-02 FIX:
 *   - "healthcheck" modu kullanılıyor — main.rs bu modu tanıyor
 *   - resolve(code === 0) — ARCH §7: "exit 0 değilse sistem başlamaz"
 */
export async function healthCheck() {
    return new Promise((resolve) => {
        const kernel = spawn(KERNEL_BINARY, ["healthcheck"], {
            stdio: ["ignore", "pipe", "ignore"],
        });
        const timer = setTimeout(() => {
            kernel.kill();
            resolve(false);
        }, 2000);
        kernel.on("close", (code) => {
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
//# sourceMappingURL=kernel-bridge.js.map