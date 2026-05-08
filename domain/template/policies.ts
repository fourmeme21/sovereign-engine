/**
 * policies.ts — registerPolicy örnekleri
 *
 * Bu dosyayı kopyala, domain'e özgü kuralları tanımla.
 * Policy Kernel bu kuralları priority sırasına göre değerlendirir.
 *
 * Kural yazma rehberi:
 *   - priority yüksek → önce değerlendirilir
 *   - Hard Lock'lar priority: 999 — asla override edilemez
 *   - PERMIT vermeyen kural DENY verir — default DENY aktif
 *   - Her DENY/BLOCK'ta redirect zorunlu — boş olamaz
 */

import type { Decision } from '../../src/types/decision.js';

// registerPolicy'nin beklediği tip
export interface PolicyRule {
  name: string;
  priority: number;
  evaluate: (decision: Decision) => PolicyRuleResult | null;
}

export interface PolicyRuleResult {
  decision: 'PERMIT' | 'BLOCK' | 'DENY' | 'ASK_HUMAN';
  redirect?: string;
  reason?: string;
}

// ─── ŞABLON KURALLAR ─────────────────────────────────────────────────────────

/**
 * Örnek: Risk seviyesi CRITICAL → ASK_HUMAN
 * (Hard Lock 3 ile örtüşür — domain katmanında da eklemek iyi pratik)
 */
export const criticalRiskRule: PolicyRule = {
  name: 'template.critical_risk',
  priority: 900,
  evaluate(decision) {
    if (decision.context.risk_level === 'CRITICAL') {
      return {
        decision: 'ASK_HUMAN',
        reason: 'CRITICAL risk seviyesi insan onayı gerektirir.',
      };
    }
    return null; // Bu kural geçerli değil — sonraki kurala geç
  },
};

/**
 * Örnek: Silme işlemleri admin rolü gerektirir
 */
export const deleteRequiresAdminRule: PolicyRule = {
  name: 'template.delete_requires_admin',
  priority: 800,
  evaluate(decision) {
    if (
      decision.category === 'DELETE_RESOURCE' &&
      decision.context.actor_role !== 'admin'
    ) {
      return {
        decision: 'BLOCK',
        redirect: 'Silme işlemi için admin rolü gereklidir. Yöneticinizle iletişime geçin.',
      };
    }
    return null;
  },
};

/**
 * Örnek: READ işlemleri her zaman PERMIT
 */
export const readAlwaysPermitRule: PolicyRule = {
  name: 'template.read_permit',
  priority: 100,
  evaluate(decision) {
    if (decision.category === 'READ_RESOURCE') {
      return { decision: 'PERMIT' };
    }
    return null;
  },
};

/** Tüm şablon kurallar — registerPolicy'ye toplu olarak verilebilir */
export const templatePolicies: PolicyRule[] = [
  criticalRiskRule,
  deleteRequiresAdminRule,
  readAlwaysPermitRule,
];
