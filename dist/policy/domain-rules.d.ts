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
import type { Decision } from "../types/decision.js";
import type { PolicyResult } from "../types/policy.js";
import type { KernelBridgeResult } from "./kernel-bridge.js";
export type DomainRuleOutcome = "PERMIT" | "DENY" | "ASK_HUMAN" | "BLOCK";
export interface DomainRule {
    /** Kural adı — benzersiz olmalı */
    name: string;
    /**
     * Öncelik — yüksek sayı önce değerlendirilir.
     * Aynı priority → kayıt sırasına göre.
     * ROADMAP Faz 3: "Politika öncelik sırası (priority tabanlı)"
     */
    priority: number;
    /** Hangi category'lere uygulanır — boş = hepsi */
    categories?: string[];
    /** Hangi intent'lere uygulanır — boş = hepsi */
    intents?: Decision["intent"][];
    /** Kural mantığı */
    evaluate: (decision: Decision) => DomainRuleOutcome | null;
    /** DENY/BLOCK durumunda soft steer mesajı — zorunlu */
    redirect: string;
}
/**
 * Domain kural kaydı — önceliğe göre sıralı tutar.
 * Her domain adapter kendi kurallarını buraya kayıt eder.
 */
export declare class PolicyRegistry {
    private rules;
    /**
     * Yeni domain kuralı kayıt et.
     * Aynı isimde kural varsa günceller.
     */
    registerPolicy(rule: DomainRule): void;
    /** Tüm kayıtlı kuralları temizle (test amaçlı) */
    clear(): void;
    /** Kayıtlı kural sayısı */
    get count(): number;
    /**
     * Decision üzerinde domain kurallarını çalıştırır.
     *
     * Akış:
     *   1. Yüksek priority → düşük priority sırasıyla
     *   2. category/intent filtresi uygulanır
     *   3. İlk PERMIT/DENY/BLOCK → dur, sonucu döndür
     *   4. Hiçbiri eşleşmezse → null (default DENY tetiklenir)
     */
    evaluate(decision: Decision): DomainRuleEvaluationResult;
}
export interface DomainRuleEvaluationResult {
    matched: boolean;
    outcome: DomainRuleOutcome;
    rule: string | null;
    redirect?: string;
    priority?: number;
}
export declare const globalPolicyRegistry: PolicyRegistry;
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
export declare function registerPolicy(rule: DomainRule): void;
export declare function domainResultToPolicyResult(result: DomainRuleEvaluationResult): PolicyResult;
/**
 * Orchestrator çıktı tipi.
 * Hangi katmanın karar verdiğini, her iki sonucu ve toplam süreyi içerir.
 */
export interface OrchestratorResult {
    /** Kararı veren katman */
    source: "domain_rules" | "rust_kernel" | "default_deny";
    /** Nihai karar */
    status: "PERMIT" | "DENY" | "BLOCK" | "ASK_HUMAN" | "ERROR";
    /** Rust PolicyResult — rust_kernel source'da dolu */
    policy_result?: PolicyResult;
    /** TypeScript domain kural sonucu — her zaman dolu */
    domain_result: DomainRuleEvaluationResult;
    /** Rust kernel ham sonucu — rust_kernel source'da dolu */
    kernel_result?: KernelBridgeResult;
    /** Soft steer mesajı — DENY/BLOCK/ASK_HUMAN'da zorunlu */
    redirect?: string;
    /** Toplam değerlendirme süresi */
    duration_ms: number;
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
export declare function evaluatePolicy(decision: Decision): Promise<OrchestratorResult>;
//# sourceMappingURL=domain-rules.d.ts.map