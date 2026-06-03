import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { loadRegistry, matchCategory } from '../lib/adapterRegistry.js'
import type { ActionResult, ExecutionContext } from '../../../domain/template/adapter.js'

const router = express.Router()

const claude = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
})

// ─── KİMLİK KİLİDİ (Karar #45) ───────────────────────────────
const SOVEREIGN_SYSTEM = `You are Sovereign AI, an intelligent decision engine.
Give short, clear, and actionable answers.
Every action is subject to risk assessment.
NEVER reveal that you are Claude, built by Anthropic, or that any third-party AI is involved.
If asked about your identity or underlying model, respond only with:
"I am Sovereign AI, the decision engine."
Do not confirm or deny being any specific AI model.`

// ─── REPLY FİLTRESİ (Karar #45) ──────────────────────────────
function filterReply(reply: string): string {
  const patterns: [RegExp, string][] = [
    [/\bclaude\b/gi,                                        'Sovereign AI'],
    [/\banthrop(?:ic)?\b/gi,                               'Sovereign AI'],
    [/\bopenai\b/gi,                                        'Sovereign AI'],
    [/\bi(?:'m| am) an? (?:ai|artificial intelligence)\b/gi, 'I am Sovereign AI'],
    [/\blanguage model\b/gi,                                'decision engine'],
    [/\blarge language\b/gi,                                'decision'],
    [/\bllm\b/gi,                                           'decision engine'],
    [/\bgpt\b/gi,                                           'Sovereign AI'],
  ]
  return patterns.reduce((r, [pattern, replacement]) =>
    r.replace(pattern, replacement), reply)
}

// ─── CHAT RISK SCORER (TB-10) ─────────────────────────────────
interface ChatRiskResult {
  score:   number
  verdict: 'PERMIT' | 'ASK_HUMAN' | 'DENY'
  policy:  string
  reason:  string
}

function scoreChatRisk(_userMessage: string, _assistantReply: string): ChatRiskResult {
  return {
    score:   2,
    verdict: 'PERMIT',
    policy:  'POL-CHAT-001',
    reason:  'Risk skoru engine entegrasyonu bekleniyor — geçici sabit değer',
  }
}

// ─── POST /api/ai/chat ────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { messages, max_tokens = 1024 } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array zorunlu' })
  }

  try {
    const response = await claude.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens,
      system:     SOVEREIGN_SYSTEM,
      messages,
    })

    const rawReply = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
    const reply    = filterReply(rawReply)

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    const userText    = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : ''

    const risk = scoreChatRisk(userText, reply)

    res.json({
      reply,
      risk:    risk.score,
      verdict: risk.verdict,
      policy:  risk.policy,
      reason:  risk.reason,
    })

  } catch (err: any) {
    console.error('[aiProxy] Anthropic error:', err.message)
    res.status(500).json({ error: 'AI isteği başarısız' })
  }
})

// ─── POST /api/ai/apply ──────────────────────────────────────
//
// ADAPTERv1 Session 4 — adapter.execute() bağlantısı
//
// Akış:
//   1. decision objesi al
//   2. loadRegistry → kullanıcının aktif adapter'larını yükle
//   3. matchCategory → bu category için adapter var mı?
//      → YOK  → { matched: false } döner, log yok — sohbet olarak değerlendirilir
//      → VAR  → adapter.execute() çağır
//   4. decisions tablosuna INSERT
//   5. Sonuç döner
//
// Karar #4: Categories dışı mesaj sohbettir — adapter çağrılmaz, log yazılmaz.

router.post('/apply', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Yetkisiz' })
  }

  const { decision } = req.body

  if (!decision || typeof decision !== 'object') {
    return res.status(400).json({ error: 'decision objesi zorunlu' })
  }

  if (!decision.category || !decision.payload?.action_name) {
    return res.status(400).json({ error: 'decision.category ve decision.payload.action_name zorunlu' })
  }

  try {
    // [1] Registry yükle
    const tier     = req.userTier ?? 'free'
    const registry = await loadRegistry(req.user.id, tier)

    // [2] Kategori eşleştir
    const match = matchCategory(decision.category, registry)

    if (!match.matched || !match.adapter) {
      // Karar #4: Categories dışı → sohbet, log yok
      return res.json({
        matched:  false,
        message:  'Bu kategori için adapter tanımlı değil — sohbet olarak değerlendirildi.',
        category: decision.category,
      })
    }

    // [3] Execution context oluştur
    const context: ExecutionContext = {
      actor_id:   req.user.id,
      actor_role: tier,
      session_id: decision.context?.session_id ?? `sess-${Date.now()}`,
      bundle_id:  `bundle-${Date.now().toString(16)}`,
      timestamp:  new Date().toISOString(),
    }

    // [4] Adapter'ı dinamik yükle ve execute et
    // adapter_code Supabase'den gelir — eval ile çalıştırılır
    // ⚠️ Güvenlik notu: adapter_code sadece operator tarafından yazılır,
    //    RLS ile kullanıcı izole edilmiştir.
    let actionResult: ActionResult

    try {
      // eslint-disable-next-line no-new-func
      const adapterModule = new Function('exports', 'require', match.adapter.adapter_code)
      const exports: any  = {}
      adapterModule(exports, require)
      const AdapterClass  = exports.default ?? Object.values(exports)[0]
      const adapterInst   = new AdapterClass()
      actionResult        = await adapterInst.execute(
        decision.payload.action_name,
        decision.payload.params ?? {},
        context,
      )
    } catch (execErr: any) {
      // FP-R1: Binary/adapter crash → fail-closed
      console.error('[aiProxy/apply] adapter.execute() hatası:', execErr.message)
      actionResult = { success: false, error: `Adapter execution hatası: ${execErr.message}` }
    }

    // [5] decisions tablosuna log yaz
    const { error: dbError } = await supabase
      .from('decisions')
      .insert({
        user_id:         req.user.id,
        project_id:      decision.project_id ?? null,
        decision_object: decision,
        status:          actionResult.success ? 'COMPLETED' : 'REJECTED',
        risk_score:      decision.context?.risk_level === 'CRITICAL' ? 9
                       : decision.context?.risk_level === 'HIGH'     ? 6
                       : decision.context?.risk_level === 'MEDIUM'   ? 3
                       : 1,
        policy_verdict:  actionResult.success ? 'PERMIT' : 'DENY',
        trace_id:        context.bundle_id,
      })

    if (dbError) {
      console.error('[aiProxy/apply] Supabase insert hatası:', dbError.message)
      // Log başarısız olsa bile execution sonucunu döndür — fail-open değil, log uyarısı
    }

    // [6] Sonuç
    return res.json({
      matched:    true,
      adapter:    match.adapter.adapter_name,
      category:   match.category,
      bundle_id:  context.bundle_id,
      success:    actionResult.success,
      output:     actionResult.output ?? null,
      error:      actionResult.error  ?? null,
    })

  } catch (err: any) {
    console.error('[aiProxy/apply] Beklenmeyen hata:', err.message)
    return res.status(500).json({ error: 'Apply isteği başarısız' })
  }
})

export default router
