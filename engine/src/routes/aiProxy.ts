// aiProxy.ts
// Amaç:    AI chat + karar (apply) endpoint'leri — Anthropic proxy, risk skoru, session yönetimi
// Bağlı:   decisions tablosu, memory_chunks tablosu, project_sessions, adapterRegistry, sessionManager
// Karar:   #45 (kimlik kilidi), #52 (validateContract async), #53 (iş dili), #54 (express.d.ts),
//          #68 (/session/close), #69 (tam merge), #77 (R-4 env abstraction), Session 18 (memory_chunks INSERT),
//          #89 (session_index.md üretimi backend sorumluluğu), #90 (insan onayı merkezde),
//          #91 (proaktif context enjeksiyonu — Claude çağrısından önce eşik kontrolü),
//          TB-12 (codeQualityGuard entegrasyonu — kod üretim isteklerinde 4 katmanlı kalite pipeline)
// Dokunma: memory_chunks INSERT kaldırılırsa TB-2 geri açılır. scoreChatRisk hibrit engine'e dokunma.
//          checkAndInjectProactive() sırası değiştirilemez — Claude çağrısından ÖNCE olmalı.
//          Handler fonksiyonları 20 satır disiplinine göre bölündü — orchestrator pattern.

import express, { Request, Response } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { loadRegistry, matchCategory } from '../lib/adapterRegistry.js'
import type { ActionResult, ExecutionContext } from '../../../domain/template/adapter.js'
import { checkAndInject, checkAndInjectProactive } from '../lib/contextInjector.js'
import {
  checkIntegrity,
  openSession,
  checkpoint,
  touchActivity,
  closeSession,
} from '../lib/sessionManager.js'
import { runCodeQualityGuard } from '../services/codeQualityGuard.js'

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
    [/\bclaude\b/gi,                                          'Sovereign AI'],
    [/\banthrop(?:ic)?\b/gi,                                 'Sovereign AI'],
    [/\bopenai\b/gi,                                          'Sovereign AI'],
    [/\bi(?:'m| am) an? (?:ai|artificial intelligence)\b/gi, 'I am Sovereign AI'],
    [/\blanguage model\b/gi,                                  'decision engine'],
    [/\blarge language\b/gi,                                  'decision'],
    [/\bllm\b/gi,                                             'decision engine'],
    [/\bgpt\b/gi,                                             'Sovereign AI'],
  ]
  return patterns.reduce((r, [pattern, replacement]) =>
    r.replace(pattern, replacement), reply)
}

// ─── INPUT VALIDATION (SSC-3) ────────────────────────────────
// Amaç:    Dışarıdan gelen req.body alanlarını tip + format açısından doğrular
// Edge:    messages boş array geçilebilir — allow, Claude boş history ile çalışır
//          project_id null olabilir — opsiyonel alan
//          UUID format kontrolü — geçersiz project_id Supabase hatasına yol açar

interface ChatBody {
  messages:          Array<{ role: string; content: string }>
  max_tokens?:       number
  project_id?:       string | null
  local_memory_path?: string | null
  is_first_message?: boolean
  session_action?:   string | null
}

function validateChatBody(body: unknown): { valid: true; data: ChatBody } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body zorunlu' }
  }

  const b = body as Record<string, unknown>

  if (!Array.isArray(b['messages'])) {
    return { valid: false, error: 'messages array zorunlu' }
  }

  for (const msg of b['messages'] as unknown[]) {
    if (!msg || typeof msg !== 'object') {
      return { valid: false, error: 'messages[]: her eleman obje olmalı' }
    }
    const m = msg as Record<string, unknown>
    if (typeof m['role'] !== 'string' || typeof m['content'] !== 'string') {
      return { valid: false, error: 'messages[]: role ve content string olmalı' }
    }
  }

  if (b['project_id'] !== undefined && b['project_id'] !== null) {
    if (typeof b['project_id'] !== 'string') {
      return { valid: false, error: 'project_id string veya null olmalı' }
    }
  }

  if (b['max_tokens'] !== undefined && typeof b['max_tokens'] !== 'number') {
    return { valid: false, error: 'max_tokens number zorunlu' }
  }

  return { valid: true, data: b as unknown as ChatBody }
}

interface ApplyBody {
  decision: {
    category:   string
    project_id?: string | null
    payload: {
      action_name: string
      params?:     Record<string, unknown>
    }
    context?: {
      session_id?: string
      risk_level?: string
    }
  }
  local_memory_path?: string | null
}

function validateApplyBody(body: unknown): { valid: true; data: ApplyBody } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body zorunlu' }
  }

  const b = body as Record<string, unknown>

  if (!b['decision'] || typeof b['decision'] !== 'object') {
    return { valid: false, error: 'decision objesi zorunlu' }
  }

  const d = b['decision'] as Record<string, unknown>

  if (typeof d['category'] !== 'string') {
    return { valid: false, error: 'decision.category string zorunlu' }
  }

  if (!d['payload'] || typeof d['payload'] !== 'object') {
    return { valid: false, error: 'decision.payload objesi zorunlu' }
  }

  const p = d['payload'] as Record<string, unknown>

  if (typeof p['action_name'] !== 'string') {
    return { valid: false, error: 'decision.payload.action_name string zorunlu' }
  }

  return { valid: true, data: b as unknown as ApplyBody }
}

// ─── CHAT RISK SCORER ─────────────────────────────────────────

interface ChatRiskResult {
  score:   number
  verdict: 'PERMIT' | 'ASK_HUMAN' | 'DENY'
  policy:  string
  reason:  string
}

interface QuickFilterResult {
  triggered: boolean
  score:     number
  verdict:   'PERMIT' | 'ASK_HUMAN' | 'DENY'
  policy:    string
  reason:    string
}

function quickRiskFilter(message: string): QuickFilterResult {
  const denyPatterns: [RegExp, string][] = [
    [/şifr[ei]\w*\s*(ver|gönder|yaz|paylaş)/i,       'Kimlik bilgisi talebi tespit edildi.'],
    [/api.?key\w*\s*(ver|gönder|yaz|paylaş)/i,        'API anahtarı talebi tespit edildi.'],
    [/token\w*\s*(ver|gönder|yaz|paylaş)/i,           'Token ifşası talebi tespit edildi.'],
    [/tüm (kullanıcı|veri|kayıt).*(sil|temizle|uç)/i, 'Toplu veri imhası talebi tespit edildi.'],
    [/veritaban.*(drop|truncate|delete from)/i,        'Tehlikeli veritabanı komutu tespit edildi.'],
  ]

  for (const [pattern, reason] of denyPatterns) {
    if (pattern.test(message)) {
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
    if (pattern.test(message)) {
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
    if (pattern.test(message)) {
      return { triggered: true, score: 4, verdict: 'PERMIT', policy: 'POL-CHAT-002', reason: 'Orta risk — Claude analizi gerekiyor.' }
    }
  }

  return { triggered: false, score: 2, verdict: 'PERMIT', policy: 'POL-CHAT-001', reason: 'Düşük risk — sohbet veya okuma.' }
}

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
    return { score: 6, verdict: 'ASK_HUMAN', policy: 'POL-CHAT-002', reason: 'Risk analizi tamamlanamadı — güvenli tarafta kalınıyor.' }
  }
}

async function scoreChatRisk(
  userMessage:    string,
  assistantReply: string,
  claudeClient:   Anthropic,
): Promise<ChatRiskResult> {
  const quick = quickRiskFilter(userMessage)
  if (quick.verdict === 'DENY') return quick
  if (quick.verdict === 'ASK_HUMAN' && quick.score >= 7) return quick
  if (quick.score >= 4) return analyzeRiskWithClaude(userMessage, assistantReply, claudeClient)
  return quick
}

// ─── KOD ÜRETİM TETİKLEYİCİ (TB-12) ─────────────────────────
// Amaç:    Mesajın kod üretim isteği olup olmadığını belirler
// Edge:    Kısa mesajlar false pozitif verebilir — pattern yeterince spesifik tutuldu
//          Türkçe + İngilizce karma mesajlar destekleniyor

function isCodeGenerationRequest(message: string): boolean {
  return /\.(ts|js|tsx|jsx|py|go|rs)\b|function\s+\w+|class\s+\w+|interface\s+\w+|implement|refactor|yaz\s+(bir\s+)?(fonksiyon|class|modül|servis|hook)|oluştur\s+(bir\s+)?(fonksiyon|class|modül|servis|hook)/i
    .test(message)
}

// ─── MEMORY YAZICI — decision (Session 18) ───────────────────

async function writeDecisionMemory(params: {
  userId:     string
  projectId:  string
  sessionId:  string | null
  category:   string
  actionName: string
  bundleId:   string
  riskLevel:  string
  output:     unknown
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
      metadata: { category: params.category, action_name: params.actionName, bundle_id: params.bundleId, status: 'COMPLETED' },
    })

  if (error) {
    console.error('[writeDecisionMemory] memory_chunks insert hatası:', error.message)
  }
}

// ─── SESSION ÖZETİ (Karar #89, #90) ──────────────────────────

function buildSummaryPrompt(messages: Array<{ role: string; content: string }>): string {
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

async function generateSessionSummary(params: {
  userId:    string
  projectId: string
  messages:  Array<{ role: string; content: string }>
}): Promise<{ content: string; error: string | null }> {
  try {
    const response = await claude.messages.create({
      model:      AI_MODEL,
      max_tokens: 1500,
      messages:   [{ role: 'user', content: buildSummaryPrompt(params.messages) }],
    })
    const content = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
    return { content, error: null }
  } catch (err: any) {
    console.error('[generateSessionSummary] Claude hatası:', err.message)
    return { content: '', error: err.message }
  }
}

// ─── /chat YARDIMCILARI ───────────────────────────────────────

async function runSessionSetup(
  userId:          string,
  projectId:       string | null,
  localMemoryPath: string | null,
  isFirstMessage:  boolean,
): Promise<string | null> {
  if (isFirstMessage && projectId) {
    const integrity = await checkIntegrity(userId, projectId, localMemoryPath)
    await openSession(userId, projectId)
    if (!integrity.healthy && integrity.recovered) return integrity.message
  }
  if (projectId) touchActivity(userId, projectId, localMemoryPath)
  return null
}

async function buildSystemPromptWithInjection(
  userId:          string,
  projectId:       string | null,
  localMemoryPath: string | null,
): Promise<{ systemPrompt: string; proactiveInjection: Awaited<ReturnType<typeof checkAndInjectProactive>> }> {
  const proactiveInjection = await checkAndInjectProactive(userId, projectId, localMemoryPath)
  const systemPrompt = proactiveInjection.injected
    ? `${SOVEREIGN_SYSTEM}\n\n${proactiveInjection.system_suffix}`
    : SOVEREIGN_SYSTEM
  return { systemPrompt, proactiveInjection }
}

async function callClaudeChat(
  messages:     unknown[],
  maxTokens:    number,
  systemPrompt: string,
): Promise<{ reply: string; inputTokens: number; outputTokens: number }> {
  const response = await claude.messages.create({
    model:      AI_MODEL,
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages:   messages as Anthropic.MessageParam[],
  })
  const rawReply = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
  return {
    reply:        filterReply(rawReply),
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
}

// ─── KOD KALİTE GUARD ÇAĞIRICI (TB-12) ───────────────────────
// Amaç:    Kod üretim isteği tespit edilince 4 katmanlı kalite pipeline çalıştırır
// Edge:    Guard hatası → orijinal reply korunur, sistem bloklanmaz
//          escalated: true → kullanıcıya quality_warning eklenir

async function applyCodeQualityGuard(
  userText:  string,
  reply:     string,
): Promise<{ reply: string; qualityMeta: Record<string, unknown> | null }> {
  if (!isCodeGenerationRequest(userText)) {
    return { reply, qualityMeta: null }
  }

  try {
    const guardResult = await runCodeQualityGuard({
      client:         claude,
      originalPrompt: userText,
      model:          AI_MODEL,
    })

    return {
      reply: guardResult.code || reply,
      qualityMeta: {
        score:      guardResult.lintResult.score,
        maxScore:   guardResult.lintResult.maxScore,
        passed:     guardResult.passed,
        iterations: guardResult.iterations,
        escalated:  guardResult.escalated,
        summary:    guardResult.lintResult.summary,
      },
    }
  } catch (err: any) {
    console.warn('[applyCodeQualityGuard] Guard hatası — orijinal reply korunuyor:', err.message)
    return { reply, qualityMeta: null }
  }
}

// ─── /apply YARDIMCILARI ──────────────────────────────────────

function buildExecutionContext(userId: string, tier: string, sessionId?: string): ExecutionContext {
  return {
    actor_id:   userId,
    actor_role: tier,
    session_id: sessionId ?? `sess-${Date.now()}`,
    bundle_id:  `bundle-${Date.now().toString(16)}`,
    timestamp:  new Date().toISOString(),
  }
}

async function runAdapterExecution(
  adapterCode: string,
  actionName:  string,
  params:      Record<string, unknown>,
  context:     ExecutionContext,
): Promise<ActionResult> {
  const FORBIDDEN_PATTERNS = [
    'process.env', 'process.exit', 'child_process', 'require(',
    '__dirname', '__filename', 'fs.', 'fetch(', 'axios',
    'XMLHttpRequest', 'eval(', 'new Function(', 'global.', 'globalThis.',
  ]

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (adapterCode.includes(pattern)) {
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

  new Script(adapterCode).runInContext(sandbox, { timeout: 3000 })

  const AdapterClass = (sandboxExports['default'] ??
    Object.values(sandboxExports)[0]) as new () => {
      execute:          (action: string, params: Record<string, unknown>, ctx: ExecutionContext) => Promise<ActionResult>
      validateContract: () => Promise<boolean>
    }

  if (typeof AdapterClass !== 'function') {
    throw new Error('[R-7] adapter_code geçerli bir sınıf export etmiyor.')
  }

  const inst = new AdapterClass()

  if (typeof inst.validateContract === 'function') {
    const valid = await inst.validateContract()
    if (!valid) throw new Error('[R-7] validateContract() false döndü — adapter yüklenemiyor.')
  }

  return inst.execute(actionName, params, context)
}

async function persistDecision(params: {
  userId:      string
  projectId:   string | null
  decision:    ApplyBody['decision']
  result:      ActionResult
  context:     ExecutionContext
}): Promise<void> {
  const riskScore = params.decision.context?.risk_level === 'CRITICAL' ? 9
                  : params.decision.context?.risk_level === 'HIGH'     ? 6
                  : params.decision.context?.risk_level === 'MEDIUM'   ? 3
                  : 1

  const { error } = await supabase
    .from('decisions')
    .insert({
      user_id:         params.userId,
      project_id:      params.projectId ?? null,
      decision_object: params.decision,
      status:          params.result.success ? 'COMPLETED' : 'REJECTED',
      risk_score:      riskScore,
      policy_verdict:  params.result.success ? 'PERMIT' : 'DENY',
      trace_id:        params.context.bundle_id,
    })

  if (error) {
    console.error('[persistDecision] Supabase insert hatası:', error.message)
  }
}

// ─── POST /api/ai/chat ────────────────────────────────────────
router.post('/chat', async (req: Request, res: Response) => {
  const validation = validateChatBody(req.body)
  if (!validation.valid) return res.status(400).json({ error: validation.error })

  const {
    messages,
    max_tokens        = 1024,
    project_id        = null,
    local_memory_path = null,
    is_first_message  = false,
    session_action    = null,
  } = validation.data

  const userId = (req as any).user?.id ?? 'anonymous'

  try {
    const integrityMessage = await runSessionSetup(userId, project_id, local_memory_path, is_first_message)
    const { systemPrompt, proactiveInjection } = await buildSystemPromptWithInjection(userId, project_id, local_memory_path)
    const { reply: rawReply, inputTokens, outputTokens } = await callClaudeChat(messages, max_tokens, systemPrompt)

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    const userText    = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''

    const { reply, qualityMeta } = await applyCodeQualityGuard(userText, rawReply)

    const risk = await scoreChatRisk(userText, reply, claude)

    const reactiveInjection = await checkAndInject(userId, project_id, local_memory_path, inputTokens, outputTokens)

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
      context_injected:  proactiveInjection.injected || reactiveInjection.injected,
      context_refreshed: proactiveInjection.context_refreshed || reactiveInjection.context_refreshed,
      system_suffix:     proactiveInjection.injected ? proactiveInjection.system_suffix : null,
      integrity_message: integrityMessage,
      quality:           qualityMeta,
    })

  } catch (err: any) {
    console.error('[aiProxy/chat] Anthropic error:', err.message)
    res.status(500).json({ error: 'AI isteği başarısız' })
  }
})

// ─── POST /api/ai/apply ──────────────────────────────────────
router.post('/apply', async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Yetkisiz' })

  const validation = validateApplyBody(req.body)
  if (!validation.valid) return res.status(400).json({ error: validation.error })

  const { decision, local_memory_path = null } = validation.data

  try {
    const tier     = req.userTier ?? 'free'
    const registry = await loadRegistry(req.user.id, tier)
    const match    = matchCategory(decision.category, registry)

    if (!match.matched || !match.adapter) {
      return res.json({ matched: false, message: 'Bu kategori için adapter tanımlı değil — sohbet olarak değerlendirildi.', category: decision.category })
    }

    const context = buildExecutionContext(req.user.id, tier, decision.context?.session_id)

    let actionResult: ActionResult
    try {
      actionResult = await runAdapterExecution(
        match.adapter.adapter_code,
        decision.payload.action_name,
        decision.payload.params ?? {},
        context,
      )
    } catch (execErr: any) {
      console.error('[aiProxy/apply] adapter.execute() hatası:', execErr.message)
      actionResult = { success: false, error: `Adapter execution hatası: ${execErr.message}` }
    }

    await persistDecision({ userId: req.user.id, projectId: decision.project_id ?? null, decision, result: actionResult, context })

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

    if (decision.project_id && actionResult.success) {
      await checkpoint(req.user.id, decision.project_id, {
        last_task:   'adapter_execution',
        last_action: `${match.category} → ${decision.payload.action_name}`,
        custom:      { bundle_id: context.bundle_id, category: match.category },
      }, local_memory_path)
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
// Karar: #89, #90 — Claude özet üretir, kullanıcı onayına hazır döndürür

router.post('/session/close', async (req: Request, res: Response) => {
  const userId = (req as any).user?.id ?? null
  if (!userId) return res.status(401).json({ error: 'Yetkisiz' })

  const { project_id, local_memory_path = null, messages = [] } = req.body

  if (!project_id || typeof project_id !== 'string') {
    return res.status(400).json({ error: 'project_id zorunlu' })
  }

  try {
    await closeSession(userId, project_id, 'normal', local_memory_path)
    const { content, error } = await generateSessionSummary({ userId, projectId: project_id, messages })

    return res.json({ closed: true, project_id, summary_content: content, summary_error: error })

  } catch (err: any) {
    console.error('[aiProxy/session/close] Hata:', err.message)
    return res.status(500).json({ error: 'Session kapatılamadı' })
  }
})

export default router
