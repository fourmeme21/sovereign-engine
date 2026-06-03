// engine/src/middleware/tierGuard.ts
// ADAPTERv1 Session 4 — adapter_count kontrolü eklendi
//
// Değişiklik: decision_count yanına adapter_count + adapter limiti eklendi.
// Mevcut decision_count mantığı korundu — dokunulmadı.

import { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase.js';

// Tier başına aylık karar limitleri
const TIER_LIMITS: Record<string, number> = {
  free: 50,
  solo: 500,
  pro:  5000,
  team: Infinity,
};

// Tier başına adapter limitleri (ADAPTERv1)
const ADAPTER_LIMITS: Record<string, number> = {
  free: 1,
  solo: 3,
  pro:  10,
  team: Infinity,
};

export function tierGuard(requiredTier?: 'free' | 'solo' | 'pro' | 'team') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Yetkisiz — önce authMiddleware çalışmalı' });
      return;
    }

    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('tier, decision_count_this_month')
      .eq('id', req.user.id)
      .single();

    if (error || !profile) {
      res.status(403).json({ error: 'Profil bulunamadı' });
      return;
    }

    // Tier seviye kontrolü (opsiyonel — belirli route'lar için)
    if (requiredTier) {
      const order = ['free', 'solo', 'pro', 'team'];
      const userLevel     = order.indexOf(profile.tier);
      const requiredLevel = order.indexOf(requiredTier);

      if (userLevel < requiredLevel) {
        res.status(403).json({
          error: `Bu özellik ${requiredTier} planı gerektirir`,
          current_tier:  profile.tier,
          required_tier: requiredTier,
        });
        return;
      }
    }

    // Aylık karar limiti kontrolü
    const decisionLimit = TIER_LIMITS[profile.tier] ?? 50;
    if (profile.decision_count_this_month >= decisionLimit) {
      res.status(429).json({
        error:        'Aylık karar limitine ulaşıldı',
        limit:        decisionLimit,
        used:         profile.decision_count_this_month,
        tier:         profile.tier,
        upgrade_hint: profile.tier !== 'team'
          ? 'Planını yükselt: /api/billing/upgrade'
          : null,
      });
      return;
    }

    // ── ADAPTERv1: Adapter limit bilgisini req'e ekle ─────────────────────
    // /api/adapters/register route'u bu bilgiyi kullanır.
    // Kontrol adapterRegistry.registerAdapter() içinde yapılır —
    // burada sadece limit bilgisi iletilir, akış kesilmez.
    const adapterLimit = ADAPTER_LIMITS[profile.tier] ?? 1;
    req.adapterLimit   = adapterLimit;
    req.userTier       = profile.tier;
    // ─────────────────────────────────────────────────────────────────────

    next();
  };
}
