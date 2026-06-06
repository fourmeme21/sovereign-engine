// aiProxy.ts
// Amaç:    AI chat + karar (apply) endpoint'leri — Anthropic proxy, risk skoru, session yönetimi
// Bağlı:   decisions tablosu, memory_chunks tablosu, project_sessions, adapterRegistry, sessionManager
// Karar:   #45 (kimlik kilidi), #52 (validateContract async), #53 (iş dili), #54 (express.d.ts),
//          #68 (/session/close), #69 (tam merge), #77 (R-4 env abstraction), Session 18 (memory_chunks INSERT),
//          #89 (session_index.md üretimi backend sorumluluğu), #90 (insan onayı merkezde)
// Dokunma: memory_chunks INSERT kaldırılırsa TB-2 geri açılır. scoreChatRisk hibrit engine'e dokunma.

import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { loadRegistry, matchCategory } from '../lib/adapterRegistry.js'
import type { ActionResult, ExecutionContext } from '../../../domain/template/adapter.js'
import { checkAndInject }                                from '../lib/contextInjector.js'
import {
  checkIntegrity,
  openSession,
  checkpoint,
  touchActivity,
  closeSession,
} from '../lib/sessionManager.js'

const router = express.Router()

const claude = new Anthropic({
  apiKey: process.env['AI_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'],
})

const AI_MODEL = process.env['AI_MODEL'] ?? 'claude-sonnet-4-5'

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
//
// Hibrit yaklaşım:
//   KAT-1: Hızlı kural filtresi — açık tehlikeleri yakala (<1ms, API yok)
//   KAT-2: Claude risk analizi — sadece orta/yüksek riskli görünenlerde
//   KAT-3: Default PERMIT — düşük risk, API çağrısı yok
//
// Politika referansları:
//   POL-CHAT-001: Düşük risk — sohbet / okuma
//   POL-CHAT-002: Orta risk — yazma / güncelleme
//   POL-CHAT-003: Yüksek risk — silme / geri alınamaz işlem
//   POL-CHAT-004: Kritik — toplu silme / veri imhası / finansal bağlayıcı
//   POL-CHAT-DENY: Açık tehlike — kimlik bilgisi / zarar verici içerik

interface ChatRiskResult {
  score:   number
  verdict: 'PERMIT' | 'ASK_HUMAN' | 'DENY'
  policy:  string
  reason:  string
}

// ── KAT-1: Hızlı kural filtresi ──────────────────────────────

interface QuickFilterResult {
  triggered: boolean
  score:     number
  verdict:   'PERMIT' | 'ASK_HUMAN' | 'DENY'
  policy:    string
  reason:    string
}

function quickRiskFilter(message: string): QuickFilterResult {
  const msg = message.toLowerCase()

  const denyPatterns: [RegExp, string][] = [
    [/şifr[ei]\w*\s*(ver|gönder|yaz|paylaş)/i,       'Kimlik bilgisi talebi tespit edildi.'],
    [/api.?key\w*\s*(ver|gönder|yaz|paylaş)/i,        'API anahtarı talebi tespit edildi.'],
    [/token\w*\s*(ver|gönder|yaz|paylaş)/i,           'Token ifşası talebi tespit edildi.'],
    [/tüm (kullanıcı|veri|kayıt).*(sil|temizle|uç)/i, 'Toplu veri imhası talebi tespit edildi.'],
    [/veritaban.*(drop|truncate|delete from)/i,        'Tehlikeli veritabanı komutu tespit edildi.'],
  ]

  for (const [pattern, reason] of denyPatterns) {
    if (pattern.test(msg)) {
      return { triggered: true, score: 10, verdict: 'DENY', policy: 'POL-CHAT-DENY', reason }
    }
  }

  const askPatterns: [RegExp, string, number][] = [
    [/(tüm|bütün|hepsini).*(sil|kaldır|temizle)/i,    'Toplu silme işlemi insan onayı gerektirir.', 9],
    [/geri\s*al[ı]?namaz/i,                            'Geri alınamaz işlem insan onayı gerektirir.', 8],
    [/(ödeme|fatura|finansal).*(onayla|gönder|işle)/i, 'Finansal işlem insan onayı gerektirir.', 9],
    [/sözleşme.*(imzala|onayla|kabul)/i,               'Hukuki bağlayıcı işlem insan onayı gerektirir.', 9],
    [/production.*(deploy|yayınla|güncelle)/i,         'Production değişikliği insan onayı gerektirir.', 8],
    [/(hesap|üyelik).*(sil|kapat|sonlandır)/i,         'Hesap silme işlemi insan onayı gerektirir.', 8],
    [/migration.*(çalıştır|uygula|run)/i,              'Veritabanı migrasyonu insan onayı gerektirir.', 8],
  ]

  for (const [pattern, reason, score] of askPatterns) {
    if (pattern.test(msg)) {
      return { triggered: true, score, verdict: 'ASK_HUMAN', policy: 'POL-CHAT-003', reason }
    }
  }

  const mediumPatterns: RegExp[] = [
    /(güncelle|değiştir|düzenle|yaz|ekle|kaydet)/i,
    /(oluştur|yarat|üret|generate)/i,
    /(gönder|ilet|publish|yayınla)/i,
    /delete_resource|write_resource/i,
  ]

  for (const pattern of mediumPatterns) {
    if (pattern.test(msg)) {
      return {
        triggered: true,
        score:     4,
        verdict:   'PERMIT',
        policy:    'POL-CHAT-002',
        reason:    'Orta risk — Claude analizi gerekiyor.',
      }
    }
  }

  return {
    triggered: false,
    score:     2,
    verdict:   'PERMIT',
    policy:    'POL-CHAT-001',
    reason:    'Düşük risk — sohbet veya okuma.',
  }
}

// ── KAT-2: Claude risk analizi ───────────────────────────────

async function analyzeRiskWithClaude(
  userMessage:    string,
  assistantReply: string,
  claudeClient:   Anthropic,
): Promise<ChatRiskResult> {
  const prompt = `Sen bir güvenlik risk analiz motorusun. Kullanıcı mesajını ve AI yanıtını değerlendir.

KULLANICI MESAJI:
${userMessage}

AI YANITI:
${assistantReply}

Aşağıdaki JSON formatında yanıt ver. SADECE JSON döndür, başka hiçbir şey ekleme:
{
  "score": <1-10 arası tam sayı>,
  "verdict": "<PERMIT|ASK_HUMAN|DENY>",
  "policy": "<POL-CHAT-001|POL-CHAT-002|POL-CHAT-003|POL-CHAT-004|POL-CHAT-DENY>",
  "reason": "<tek cümle Türkçe açıklama>"
}

Skorlama kriterleri:
- 1-3: Sohbet, okuma, bilgi sorgulama → PERMIT / POL-CHAT-001
- 4-5: Yazma, güncelleme, oluşturma → PERMIT / POL-CHAT-002
- 6-7: Silme, gönderme, publish → ASK_HUMAN / POL-CHAT-003
- 8-9: Toplu işlem, finansal, hukuki, production → ASK_HUMAN / POL-CHAT-004
- 10: Kimlik bilgisi ifşası, toplu veri imhası, zararlı içerik → DENY / POL-CHAT-DENY

Karar kuralları:
- score 1-5 → PERMIT
- score 6-8 → ASK_HUMAN
- score 9-10 → DENY
- Şüphe durumunda skoru yükselt — fail-closed prensibi geçerli`

  try {
    const response = await claudeClient.messages.create({
      model:      AI_MODEL,
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw    = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
    const clean  = raw.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    const validVerdicts = ['PERMIT', 'ASK_HUMAN', 'DENY'] as const
    const validPolicies = ['POL-CHAT-001', 'POL-CHAT-002', 'POL-CHAT-003', 'POL-CHAT-004', 'POL-CHAT-DENY'] as const

    const score   = typeof parsed.score   === 'number' ? Math.min(10, Math.max(1, Math.round(parsed.score))) : 5
    const verdict = validVerdicts.includes(parsed.verdict) ? parsed.verdict : 'ASK_HUMAN'
    const policy  = validPolicies.includes(parsed.policy)  ? parsed.policy  : 'POL-CHAT-002'
    const reason  = typeof parsed.reason  === 'string'     ? parsed.reason  : 'Risk analizi tamamlandı.'

    return { score, verdict, policy, reason }

  } catch (err: any) {
    console.warn('[scoreChatRisk] Claude analiz hatası — fail-closed ASK_HUMAN:', err.message)
    return {
      score:   6,
      verdict: 'ASK_HUMAN',
      policy:  'POL-CHAT-002',
      reason:  'Risk analizi tamamlanamadı — güvenli tarafta kalınıyor.',
    }
  }
}

// ── ANA SCORER ───────────────────────────────────────────────

async function scoreChatRisk(
  userMessage:    string,
  assistantReply: string,
  claudeClient:   Anthropic,
): Promise<ChatRiskResult> {
  const quick = quickRiskFilter(userMessage)

  if (quick.verdict === 'DENY') {
    return { score: quick.score, verdict: quick.verdict, policy: quick.policy, reason: quick.reason }
  }

  if (quick.verdict === 'ASK_HUMAN' && quick.score >= 7) {
    return { score: quick.score, verdict: quick.verdict, policy: quick.policy, reason: quick.reason }
  }

  if (quick.score >= 4) {
    return analyzeRiskWithClaude(userMessage, assistantReply, claudeClient)
  }

  return { score: quick.score, verdict: quick.verdict, policy: quick.policy, reason: quick.reason }
}

// ─── MEMORY YAZICI — decision (Session 18) ───────────────────
// Amaç:    Başarılı adapter execution'larını memory_chunks'a yazar
// Kural:   Non-critical — hata olsa response bloklenmaz
// Edge:    project_id null ise atlanır / session_id nullable geçilir

async function writeDecisionMemory(params: {
  userId:      string
  projectId:   string
  sessionId:   string | null
  category:    string
  actionName:  string
  bundleId:    string
  riskLevel:   string
  output:      unknown
}): Promise<void> {
  const content = [
    `Karar: ${params.category} → ${params.actionName}`,
    `Sonuç: ${params.output ? JSON.stringify(params.output).slice(0, 200) : 'tamamlandı'}`,
    `Bundle: ${params.bundleId}`,
    `Risk: ${params.riskLevel}`,
  ].join('\n')

  const { error } = await supabase
    .from('memory_chunks')
    .insert({
      user_id:     params.userId,
      project_id:  params.projectId,
      session_id:  params.sessionId,
      memory_type: 'decision',
      content,
      metadata: {
        category:    params.category,
        action_name: params.actionName,
        bundle_id:   params.bundleId,
        status:      'COMPLETED',
      },
    })

  if (error) {
    console.error('[writeDecisionMemory] memory_chunks insert hatası:', error.message)
  }
}

// ─── SESSION ÖZETİ PROMPT OLUŞTURUCU (Karar #89, #90) ────────
// Amaç:    Claude'a gönderilecek session özet promptunu üretir
// Kural:   Son 30 mesaj alınır — uzun geçmişlerde token tasarrufu
// Edge:    Mesaj yoksa boş history ile prompt üretilir

function buildSummaryPrompt(
  messages: Array<{ role: string; content: string }>
): string {
  const history = messages
    .slice(-30)
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n')

  return `Sen bir session özet motorusun. Aşağıdaki konuşma geçmişini analiz et ve session_index.md formatında bir özet üret.

KONUŞMA GEÇMİŞİ:
${history || '(Konuşma geçmişi boş)'}

Aşağıdaki formatta SADECE özet üret, başka hiçbir şey ekleme:

## Yapılanlar
- [ne yapıldı — somut çıktı belirt]

## Kararlar
- [bu session'da alınan kararlar]

## Blocker
[varsa blocker — yoksa "Yok"]

## Sıradaki
[bir sonraki session tam olarak nereden başlamalı]

Kurallar:
- Türkçe yaz
- Her madde somut ve tek satır olsun
- Tahmin etme — konuşmada olmayan bilgiyi ekleme
- Blocker yoksa "Yok" yaz, boş bırakma`
}

// ─── SESSION ÖZETİ ÜRETİCİ (Karar #89, #90) ──────────────────
// Amaç:    Claude'a session özeti ürettir — kullanıcı onayına sunulacak
// Bağlı:   /api/ai/session/close endpoint'i
// Edge:    API hatası → content boş döner, summary_error dolu gelir — frontend elle yazma sunar

async function generateSessionSummary(params: {
  userId:    string
  projectId: string
  messages:  Array<{ role: string; content: string }>
}): Promise<{ content: string; error: string | null }> {
  const prompt = buildSummaryPrompt(params.messages)

  try {
    const response = await claude.messages.create({
      model:      AI_MODEL,
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    })

    const content = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
    return { content, error: null }

  } catch (err: any) {
    console.error('[generateSessionSummary] Claude hatası:', err.message)
    return { content: '', error: err.message }
  }
}

// ─── POST /api/ai/chat ────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const {
    messages,
    max_tokens        = 1024,
    project_id        = null,
    local_memory_path = null,
    is_first_message  = false,
    session_action    = null,
  } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array zorunlu' })
  }

  const userId = (req as any).user?.id ?? 'anonymous'

  let integrityMessage: string | null = null

  if (is_first_message && project_id) {
    const integrity = await checkIntegrity(userId, project_id, local_memory_path)
    if (!integrity.healthy && integrity.recovered) {
      integrityMessage = integrity.message
    }
    await openSession(userId, project_id)
  }

  if (project_id) {
    touchActivity(userId, project_id, local_memory_path)
  }

  try {
    const response = await claude.messages.create({
      model:      AI_MODEL,
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

    const risk = await scoreChatRisk(userText, reply, claude)

    const injection = await checkAndInject(
      userId,
      project_id,
      local_memory_path,
      response.usage.input_tokens,
      response.usage.output_tokens,
    )

    if (project_id) {
      await checkpoint(userId, project_id, {
        last_task:   'chat',
        last_action: session_action ?? `chat — ${new Date().toISOString()}`,
      }, local_memory_path)
    }

    res.json({
      reply,
      risk:              risk.score,
      verdict:           risk.verdict,
      policy:            risk.policy,
      reason:            risk.reason,
      context_injected:  injection.injected,
      system_suffix:     injection.injected ? injection.system_suffix : null,
      integrity_message: integrityMessage,
    })

  } catch (err: any) {
    console.error('[aiProxy] Anthropic error:', err.message)
    res.status(500).json({ error: 'AI isteği başarısız' })
  }
})

// ─── POST /api/ai/apply ──────────────────────────────────────
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
    const tier     = req.userTier ?? 'free'
    const registry = await loadRegistry(req.user.id, tier)
    const match    = matchCategory(decision.category, registry)

    if (!match.matched || !match.adapter) {
      return res.json({
        matched:  false,
        message:  'Bu kategori için adapter tanımlı değil — sohbet olarak değerlendirildi.',
        category: decision.category,
      })
    }

    const context: ExecutionContext = {
      actor_id:   req.user.id,
      actor_role: tier,
      session_id: decision.context?.session_id ?? `sess-${Date.now()}`,
      bundle_id:  `bundle-${Date.now().toString(16)}`,
      timestamp:  new Date().toISOString(),
    }

    let actionResult: ActionResult

    try {
      const FORBIDDEN_PATTERNS = [
        'process.env', 'process.exit', 'child_process', 'require(',
        '__dirname', '__filename', 'fs.', 'fetch(', 'axios',
        'XMLHttpRequest', 'eval(', 'new Function(', 'global.', 'globalThis.',
      ]

      for (const pattern of FORBIDDEN_PATTERNS) {
        if (match.adapter.adapter_code.includes(pattern)) {
          throw new Error(`[R-7] Güvenlik ihlali: adapter_code yasak pattern içeriyor → "${pattern}"`)
        }
      }

      const { createContext, Script } = await import('vm')

      const sandboxExports: Record<string, unknown> = {}
      const sandbox = createContext({
        exports: sandboxExports,
        console: {
          log:   (...args: unknown[]) => console.log('[adapter]', ...args),
          warn:  (...args: unknown[]) => console.warn('[adapter]', ...args),
          error: (...args: unknown[]) => console.error('[adapter]', ...args),
        },
        setTimeout, clearTimeout, Promise, JSON, Math, Date, Error,
        Array, Object, String, Number, Boolean, Map, Set,
      })

      const script = new Script(match.adapter.adapter_code)
      script.runInContext(sandbox, { timeout: 3000 })

      const AdapterClass = (sandboxExports.default ??
        Object.values(sandboxExports)[0]) as new () => {
          execute: (action: string, params: Record<string, unknown>, ctx: ExecutionContext) => Promise<ActionResult>
          validateContract: () => Promise<boolean>
        }

      if (typeof AdapterClass !== 'function') {
        throw new Error('[R-7] adapter_code geçerli bir sınıf export etmiyor.')
      }

      const adapterInst = new AdapterClass()

      if (typeof adapterInst.validateContract === 'function') {
        const valid = await adapterInst.validateContract()
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
      console.error('[aiProxy/apply] adapter.execute() hatası:', execErr.message)
      actionResult = { success: false, error: `Adapter execution hatası: ${execErr.message}` }
    }

    // ── decisions tablosuna yaz ───────────────────────────────
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
      console.error('[aiProxy/apply] Supabase decisions insert hatası:', dbError.message)
    }

    // ── memory_chunks'a yaz — sadece başarılı + project_id varsa (Session 18) ──
    if (actionResult.success && decision.project_id) {
      await writeDecisionMemory({
        userId:     req.user.id,
        projectId:  decision.project_id,
        sessionId:  decision.context?.session_id ?? null,
        category:   match.category,
        actionName: decision.payload.action_name,
        bundleId:   context.bundle_id,
        riskLevel:  decision.context?.risk_level ?? 'LOW',
        output:     actionResult.output ?? null,
      })
    }

    // ── checkpoint ───────────────────────────────────────────
    const localPath = req.body?.local_memory_path ?? null
    if (decision.project_id && actionResult.success) {
      await checkpoint(req.user.id, decision.project_id, {
        last_task:   'adapter_execution',
        last_action: `${match.category} → ${decision.payload.action_name}`,
        custom: {
          bundle_id: context.bundle_id,
          category:  match.category,
        },
      }, localPath)
    }

    return res.json({
      matched:   true,
      adapter:   match.adapter.adapter_name,
      category:  match.category,
      bundle_id: context.bundle_id,
      success:   actionResult.success,
      output:    actionResult.output ?? null,
      error:     actionResult.error  ?? null,
    })

  } catch (err: any) {
    console.error('[aiProxy/apply] Beklenmeyen hata:', err.message)
    return res.status(500).json({ error: 'Apply isteği başarısız' })
  }
})

// ─── POST /api/ai/session/close ──────────────────────────────
// Amaç:    Session'ı kapat, Claude'a özet ürettir, kullanıcı onayına hazır döndür
// Karar:   #89 (backend üretim sorumluluğu), #90 (insan sezgisi merkez)
// Edge:    Claude hatası → summary_error dolu, content boş — frontend elle yazma sunar
//          messages boşsa → Claude "geçmiş yok" özetiyle döner
//          project_id eksikse → 400

router.post('/session/close', async (req, res) => {
  const userId = (req as any).user?.id ?? null

  if (!userId) {
    return res.status(401).json({ error: 'Yetkisiz' })
  }

  const {
    project_id,
    local_memory_path = null,
    messages          = [],
  } = req.body

  if (!project_id) {
    return res.status(400).json({ error: 'project_id zorunlu' })
  }

  try {
    await closeSession(userId, project_id, 'normal', local_memory_path)

    const { content, error } = await generateSessionSummary({
      userId,
      projectId: project_id,
      messages,
    })

    return res.json({
      closed:          true,
      project_id,
      summary_content: content,
      summary_error:   error,
    })

  } catch (err: any) {
    console.error('[aiProxy/session/close] Hata:', err.message)
    return res.status(500).json({ error: 'Session kapatılamadı' })
  }
})

export default router
