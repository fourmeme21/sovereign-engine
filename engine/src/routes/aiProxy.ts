import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { loadRegistry, matchCategory } from '../lib/adapterRegistry.js'
import type { ActionResult, ExecutionContext } from '../../../domain/template/adapter.js'
import { checkAndInject }                                from '../lib/contextInjector.js'

const router = express.Router()

const claude = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
})

// ─── KİMLİK KİLİDİ (Karar #45) ───────────────────────────────
const SOVEREIGN_SYSTEM = `You are Sovereign AI, an intelligent decision engine.
Give short, clear, and actionable answers.
Every action is subject to risk assessment.
If asked about your identity, respond only with:
"I am Sovereign AI, the decision engine, powered by leading AI technology."
Do not name specific AI providers or models.`

// ─── REPLY FİLTRESİ (Karar #45) ──────────────────────────────
function filterReply(reply: string): string {
  const patterns: [RegExp, string][] = [
    [/\bi(?:'m| am) claude\b/gi,          'I am Sovereign AI'],
    [/\bbuilt by anthropic\b/gi,           'powered by leading AI technology'],
    [/\bcreated by anthropic\b/gi,         'powered by leading AI technology'],
    [/\banthrop(?:ic)?\b/gi,               'leading AI technology'],
    [/\blarge language model\b/gi,         'decision engine'],
    [/\bllm\b/gi,                          'decision engine'],
    [/\bgpt\b/gi,                          'Sovereign AI'],
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
//
// ADAPTERv1 Session 6 — Bağlam enjeksiyonu eklendi
// Her çağrıda token sayacı güncellenir.
// 80.000 token eşiği aşılınca CORE + AI_AGENT + session_index enjekte edilir.
router.post('/chat', async (req, res) => {
  const {
    messages,
    max_tokens        = 1024,
    project_id        = null,    // Aktif proje (yoksa enjeksiyon yapılmaz)
    local_memory_path = null,    // hot.json konumu (Tauri'den gelir)
  } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array zorunlu' })
  }

  const userId = (req as any).user?.id ?? 'anonymous'

  try {
    const response = await claude.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens,
      system:     SOVEREIGN_SYSTEM,
      messages,
    })

    const rawReply = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
    const reply    = filterReply(rawReply)

    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')
    const userText    = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : ''

    const risk = scoreChatRisk(userText, reply)

    // ── Bağlam Enjeksiyonu ────────────────────────────────────────────────
    // Token kullanımını kaydet, eşik aşıldıysa enjeksiyon içeriği al.
    // Kullanıcı bunu görmez — bir sonraki API çağrısında system prompt'a eklenir.
    const injection = await checkAndInject(
      userId,
      project_id,
      local_memory_path,
      response.usage.input_tokens,
      response.usage.output_tokens,
    )

    res.json({
      reply,
      risk:             risk.score,
      verdict:          risk.verdict,
      policy:           risk.policy,
      reason:           risk.reason,
      // İstemci bir sonraki mesajda system_suffix'i system prompt'a ekler
      context_injected: injection.injected,
      system_suffix:    injection.injected ? injection.system_suffix : null,
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

    // [4] Adapter'ı vm sandbox ile yükle ve execute et — R-7 güvenlik geçişi
    //
    // Güvenlik katmanları:
    //   KAT-1: Statik analiz  — yasak pattern tespiti (process, require, fs, eval...)
    //   KAT-2: vm sandbox     — izole context, global erişim yok
    //   KAT-3: Timeout        — 3000ms sınırı, sonsuz döngü koruması
    //
    // adapter_code Claude tarafından üretilir (operator kontrollü).
    // RLS ile kullanıcı bazlı izolasyon Supabase katmanında sağlanır.
    let actionResult: ActionResult

    try {
      // ── KAT-1: STATİK ANALİZ ──────────────────────────────────────────────
      const FORBIDDEN_PATTERNS = [
        'process.env',
        'process.exit',
        'child_process',
        'require(',
        '__dirname',
        '__filename',
        'fs.',
        'fetch(',
        'axios',
        'XMLHttpRequest',
        'eval(',
        'new Function(',
        'global.',
        'globalThis.',
      ]

      for (const pattern of FORBIDDEN_PATTERNS) {
        if (match.adapter.adapter_code.includes(pattern)) {
          throw new Error(
            `[R-7] Güvenlik ihlali: adapter_code yasak pattern içeriyor → "${pattern}"`,
          )
        }
      }

      // ── KAT-2: VM SANDBOX ─────────────────────────────────────────────────
      // Sadece güvenli primitive'ler sandbox'a açılır.
      // process, require, fs, global → tamamen kapalı.
      const { createContext, Script } = await import('vm')

      const sandboxExports: Record<string, unknown> = {}
      const sandbox = createContext({
        exports:    sandboxExports,
        console: {
          log:   (...args: unknown[]) => console.log('[adapter]', ...args),
          warn:  (...args: unknown[]) => console.warn('[adapter]', ...args),
          error: (...args: unknown[]) => console.error('[adapter]', ...args),
        },
        setTimeout,
        clearTimeout,
        Promise,
        JSON,
        Math,
        Date,
        Error,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Map,
        Set,
      })

      // ── KAT-3: TIMEOUT ────────────────────────────────────────────────────
      // 3000ms — sonsuz döngü veya blocking I/O koruması.
      const script = new Script(match.adapter.adapter_code)
      script.runInContext(sandbox, { timeout: 3000 })

      // Adapter sınıfını sandbox'tan al
      const AdapterClass = (sandboxExports.default ??
        Object.values(sandboxExports)[0]) as new () => {
          execute: (action: string, params: Record<string, unknown>, ctx: ExecutionContext) => Promise<ActionResult>
          validateContract: () => boolean
        }

      if (typeof AdapterClass !== 'function') {
        throw new Error('[R-7] adapter_code geçerli bir sınıf export etmiyor.')
      }

      const adapterInst = new AdapterClass()

      // validateContract() kontrolü — ARCHITECTURE.md Kural 11
      if (typeof adapterInst.validateContract === 'function') {
        const valid = adapterInst.validateContract()
        if (!valid) {
          throw new Error('[R-7] validateContract() false döndü — adapter yüklenemiyor.')
        }
      }

      actionResult = await adapterInst.execute(
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
