/**
 * Sovereign Engine OS — Domain Policy Kayıt Sistemi
 * @module src/policy/domain-rules
 *
 * ROADMAP Faz 3 — Domain policy kayıt sistemi + öncelik sırası.
 * Policy Kernel hard lock'lardan sonra bu kuralları değerlendirir.
 *
 * Tasarım ilkesi:
 *   - Hard lock → değiştirilemez (Rust'ta)
 *   - Domain kural → domain adapter kayıt eder (burada)
 *   - Default → DENY (fail-closed)
 *
 * SAP-04 Fix (evaluatePolicy):
 *   Domain config daha önce Rust'a hiç geçilmiyordu.
 *   evaluatePolicy() orchestrator'ı:
 *     1. TypeScript domain kurallarını önce çalıştırır
 *     2. DENY/BLOCK/ASK_HUMAN → Rust'a gitmez, hemen döner (fail-closed)
 *     3. PERMIT veya eşleşme yok → Rust policy kernel devreye girer
 *     4. Rust sonucu nihai kararı verir (hard lock override edilemez)
 */
import { callPolicyKernel } from "./kernel-bridge.js";
// ---------------------------------------------------------------------------
// Policy Registry
// ---------------------------------------------------------------------------
/**
 * Domain kural kaydı — önceliğe göre sıralı tutar.
 * Her domain adapter kendi kurallarını buraya kayıt eder.
 */
export class PolicyRegistry {
    rules = [];
    /**
     * Yeni domain kuralı kayıt et.
     * Aynı isimde kural varsa günceller.
     */
    registerPolicy(rule) {
        if (rule.priority <= 0) {
            throw new Error(`Policy "${rule.name}": priority > 0 olmalıdır — NON_POSITIVE_VALUE`);
        }
        // Aynı isim varsa güncelle
        const existingIndex = this.rules.findIndex(r => r.name === rule.name);
        if (existingIndex >= 0) {
            this.rules[existingIndex] = rule;
        }
        else {
            this.rules.push(rule);
        }
        // Önceliğe göre sırala — yüksek önce
        this.rules.sort((a, b) => b.priority - a.priority);
    }
    /** Tüm kayıtlı kuralları temizle (test amaçlı) */
    clear() {
        this.rules = [];
    }
    /** Kayıtlı kural sayısı */
    get count() {
        return this.rules.length;
    }
    /**
     * Decision üzerinde domain kurallarını çalıştırır.
     *
     * Akış:
     *   1. Yüksek priority → düşük priority sırasıyla
     *   2. category/intent filtresi uygulanır
     *   3. İlk PERMIT/DENY/BLOCK → dur, sonucu döndür
     *   4. Hiçbiri eşleşmezse → null (default DENY tetiklenir)
     */
    evaluate(decision) {
        if (this.rules.length === 0) {
            return {
                matched: false,
                outcome: "DENY",
                rule: null,
                redirect: "Domain kural tanımlanmamış — default DENY (fail-closed).",
            };
        }
        for (const rule of this.rules) {
            // Category filtresi
            if (rule.categories && rule.categories.length > 0) {
                if (!rule.categories.includes(decision.category))
                    continue;
            }
            // Intent filtresi
            if (rule.intents && rule.intents.length > 0) {
                if (!rule.intents.includes(decision.intent))
                    continue;
            }
            // Kural değerlendir
            const outcome = rule.evaluate(decision);
            if (outcome === null)
                continue; // Bu kural uygulanmaz
            return {
                matched: true,
                outcome,
                rule: rule.name,
                redirect: outcome !== "PERMIT" ? rule.redirect : undefined,
                priority: rule.priority,
            };
        }
        // Hiçbir kural PERMIT demedi → default DENY (fail-closed)
        return {
            matched: false,
            outcome: "DENY",
            rule: null,
            redirect: "Hiçbir domain kural bu kararı onaylamadı — default DENY.",
        };
    }
}
// ---------------------------------------------------------------------------
// Global Registry (singleton)
// ---------------------------------------------------------------------------
export const globalPolicyRegistry = new PolicyRegistry();
/**
 * Domain adapter kural kayıt fonksiyonu.
 * Her adapter kendi kategorileri için kurallarını buraya ekler.
 *
 * @example
 * ```typescript
 * registerPolicy({
 *   name:       "user_management_write",
 *   priority:   10,
 *   categories: ["USER_MANAGEMENT"],
 *   intents:    ["WRITE_DATA"],
 *   evaluate:   (d) => d.context.actor_role === "operator" ? "PERMIT" : null,
 *   redirect:   "USER_MANAGEMENT yazma için operator rolü gereklidir.",
 * });
 * ```
 */
export function registerPolicy(rule) {
    globalPolicyRegistry.registerPolicy(rule);
}
// ---------------------------------------------------------------------------
// PolicyResult'a dönüştürücü
// ---------------------------------------------------------------------------
export function domainResultToPolicyResult(result) {
    const decisionMap = {
        PERMIT: "PERMIT",
        DENY: "DENY",
        BLOCK: "BLOCK",
        ASK_HUMAN: "ASK_HUMAN",
    };
    return {
        decision: decisionMap[result.outcome],
        priority: result.priority ?? 0,
        redirect: result.redirect,
        execution_token: undefined, // PERMIT ise kernel-bridge üretir
    };
}
/**
 * SAP-04: Ana policy değerlendirme giriş noktası.
 *
 * Daha önce domain config Rust'a hiç geçilmiyordu.
 * Bu fonksiyon iki katmanı sıralı çalıştırarak birleştirir:
 *
 * Akış:
 *   1. TypeScript domain kuralları (globalPolicyRegistry) önce çalışır
 *   2. Domain DENY / BLOCK  → fail-closed, Rust'a gitme, hemen dön
 *   3. Domain ASK_HUMAN     → insan onayı iste, Rust'a gitme
 *   4. Domain PERMIT veya eşleşme yok → Rust kernel (hard lock'lar) devreye girer
 *   5. Rust sonucu nihai karardır — hard lock hiçbir şeyle override edilemez
 *
 * Fail-closed garantisi:
 *   - Domain kuralı DENY/BLOCK → Rust hiç çağrılmaz
 *   - Rust timeout/crash → DENY (kernel-bridge garantisi)
 *   - Her iki katman da PERMIT demezse → DENY
 *
 * @param decision - VALIDATED durumundaki Decision objesi
 */
export async function evaluatePolicy(decision) {
    const start = Date.now();
    // ── AŞAMA 1: TypeScript domain kuralları ─────────────────────────────────
    const domainResult = globalPolicyRegistry.evaluate(decision);
    // Domain DENY → fail-closed, Rust'a gitme
    if (domainResult.matched &&
        domainResult.outcome === "DENY") {
        return {
            source: "domain_rules",
            status: "DENY",
            domain_result: domainResult,
            redirect: domainResult.redirect ?? "Domain kural reddetti — DENY.",
            duration_ms: Date.now() - start,
        };
    }
    // Domain BLOCK → fail-closed, Rust'a gitme
    if (domainResult.matched &&
        domainResult.outcome === "BLOCK") {
        return {
            source: "domain_rules",
            status: "BLOCK",
            domain_result: domainResult,
            redirect: domainResult.redirect ?? "Domain kural engelledi — BLOCK.",
            duration_ms: Date.now() - start,
        };
    }
    // Domain ASK_HUMAN → insan onayı iste, Rust'a gitme
    if (domainResult.matched &&
        domainResult.outcome === "ASK_HUMAN") {
        return {
            source: "domain_rules",
            status: "ASK_HUMAN",
            domain_result: domainResult,
            redirect: domainResult.redirect ?? "Domain kural insan onayı istedi.",
            duration_ms: Date.now() - start,
        };
    }
    // ── AŞAMA 2: Rust policy kernel (hard lock'lar) ──────────────────────────
    // Domain PERMIT veya eşleşme yok → Rust devreye girer.
    // Rust hard lock'ları domain kurallarını override edebilir.
    const kernelResult = await callPolicyKernel(decision);
    // Rust ERROR → fail-closed DENY (kernel-bridge zaten DENY döndürür ama
    // burada da açıkça yaz — CORE.md §9: "Fail-closed: şüphe durumunda DENY")
    const status = kernelResult.status === "ERROR"
        ? "DENY"
        : kernelResult.status;
    return {
        source: "rust_kernel",
        status,
        domain_result: domainResult,
        kernel_result: kernelResult,
        policy_result: kernelResult.policy_result,
        redirect: kernelResult.policy_result?.redirect,
        duration_ms: Date.now() - start,
    };
}
//# sourceMappingURL=domain-rules.js.map