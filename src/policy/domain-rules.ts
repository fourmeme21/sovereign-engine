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
 */

import type { Decision }     from "../types/decision.js";
import type { PolicyResult } from "../types/policy.js";

// ---------------------------------------------------------------------------
// Domain Kural Tipi
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Policy Registry
// ---------------------------------------------------------------------------

/**
 * Domain kural kaydı — önceliğe göre sıralı tutar.
 * Her domain adapter kendi kurallarını buraya kayıt eder.
 */
export class PolicyRegistry {
  private rules: DomainRule[] = [];

  /**
   * Yeni domain kuralı kayıt et.
   * Aynı isimde kural varsa günceller.
   */
  registerPolicy(rule: DomainRule): void {
    if (rule.priority <= 0) {
      throw new Error(
        `Policy "${rule.name}": priority > 0 olmalıdır — NON_POSITIVE_VALUE`
      );
    }

    // Aynı isim varsa güncelle
    const existingIndex = this.rules.findIndex(r => r.name === rule.name);
    if (existingIndex >= 0) {
      this.rules[existingIndex] = rule;
    } else {
      this.rules.push(rule);
    }

    // Önceliğe göre sırala — yüksek önce
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /** Tüm kayıtlı kuralları temizle (test amaçlı) */
  clear(): void {
    this.rules = [];
  }

  /** Kayıtlı kural sayısı */
  get count(): number {
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
  evaluate(decision: Decision): DomainRuleEvaluationResult {
    if (this.rules.length === 0) {
      return {
        matched:  false,
        outcome:  "DENY",
        rule:     null,
        redirect: "Domain kural tanımlanmamış — default DENY (fail-closed).",
      };
    }

    for (const rule of this.rules) {
      // Category filtresi
      if (rule.categories && rule.categories.length > 0) {
        if (!rule.categories.includes(decision.category)) continue;
      }

      // Intent filtresi
      if (rule.intents && rule.intents.length > 0) {
        if (!rule.intents.includes(decision.intent)) continue;
      }

      // Kural değerlendir
      const outcome = rule.evaluate(decision);
      if (outcome === null) continue; // Bu kural uygulanmaz

      return {
        matched:  true,
        outcome,
        rule:     rule.name,
        redirect: outcome !== "PERMIT" ? rule.redirect : undefined,
        priority: rule.priority,
      };
    }

    // Hiçbir kural PERMIT demedi → default DENY (fail-closed)
    return {
      matched:  false,
      outcome:  "DENY",
      rule:     null,
      redirect: "Hiçbir domain kural bu kararı onaylamadı — default DENY.",
    };
  }
}

export interface DomainRuleEvaluationResult {
  matched:   boolean;
  outcome:   DomainRuleOutcome;
  rule:      string | null;
  redirect?: string;
  priority?: number;
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
export function registerPolicy(rule: DomainRule): void {
  globalPolicyRegistry.registerPolicy(rule);
}

// ---------------------------------------------------------------------------
// PolicyResult'a dönüştürücü
// ---------------------------------------------------------------------------

export function domainResultToPolicyResult(
  result: DomainRuleEvaluationResult
): PolicyResult {
  const decisionMap: Record<DomainRuleOutcome, PolicyResult["decision"]> = {
    PERMIT:    "PERMIT",
    DENY:      "DENY",
    BLOCK:     "BLOCK",
    ASK_HUMAN: "ASK_HUMAN",
  };

  return {
    decision:        decisionMap[result.outcome],
    priority:        result.priority ?? 0,
    redirect:        result.redirect,
    execution_token: undefined, // PERMIT ise kernel-bridge üretir
  };
}
