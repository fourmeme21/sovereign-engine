// aiProxy.ts
// Amaç:    AI chat + karar (apply) endpoint'leri — Anthropic proxy, risk skoru, session yönetimi
// Bağlı:   decisions tablosu, memory_chunks tablosu, project_sessions, adapterRegistry, sessionManager
// Karar:   #45 (kimlik kilidi), #52 (validateContract async), #53 (iş dili), #54 (express.d.ts),
//          #68 (/session/close), #69 (tam merge), #77 (R-4 env abstraction), Session 18 (memory_chunks INSERT),
//          #89 (session_index.md üretimi backend sorumluluğu), #90 (insan onayı merkezde),
//          #91 (proaktif context enjeksiyonu — Claude çağrısından önce eşik kontrolü),
//          TB-12 (codeQualityGuard entegrasyonu — kod üretim isteklerinde 4 katmanlı kalite pipeline),
//          TB-13 (zero-context judge loop — judgeVerdict qualityMeta'ya eklendi),
//          TB-14 (device lock — acquire_device_lock/release_device_lock, token sayacı — increment_token_count,
//                 50k eşiğinde core_doc+ai_agent_doc inject + reset_token_count)
// Dokunma: memory_chunks INSERT kaldırılırsa TB-2 geri açılır. scoreChatRisk hibrit engine'e dokunma.
//          checkAndInjectProactive() sırası değiştirilemez — Claude çağrısından ÖNCE olmalı.
//          Handler fonksiyonları 20 satır disiplinine göre bölündü — orchestrator pattern.
//          TB-14: injectCoreDocsIfNeeded() Claude çağrısından ÖNCE çalışmalı — sıra değiştirilemez.
//          TB-14: releaseDeviceLock() session/close ve hata durumlarında çağrılmalı — sızıntı önlenir.

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

// ─── TOKEN EŞİĞİ (TB-14) ─────────────────────────────────────
const CORE_INJECT_TOKEN_THRESHOLD = 50_000

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
  messages:           Array<{ role: string; content: string }>
  max_tokens?:        number
  project_id?:        string | null
  local_memory_path?: string | null
  is_first_message?:  boolean
  session_action?:    string | null
  device_id?:         string | null
}

// SSC-3: UUID v4 format doğrulaması
const DEVICE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

  if (b['device_id'] !== undefined && b['device_id'] !== null) {
    if (typeof b['device_id'] !== 'string') {
      return { valid: false, error: 'device_id string veya null olmalı' }
    }
    if (!DEVICE_UUID_REGEX.test(b['device_id'] as string)) {
      return { valid: false, error: 'device_id geçerli UUID v4 formatında olmalı' }
    }
  }

  return { valid: true, data: b as unknown as ChatBody }
}

interface ApplyBody {
  decision: {
    category:    string
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

// ─── TB-14: DEVICE LOCK ───────────────────────────────────────
// Amaç:    Aynı proje aynı anda yalnızca bir cihazdan açılabilir
// Bağlı:   user_projects.active_device_id + device_locked_at
// Edge:    project_id null ise kilit atlanır — device_id yoksa kilit atlanır
//          acquire başarısız → 409 döner, chat bloklanır
//          Supabase hatası → sessiz geçilir, sistem bloklanmaz (fail-open: kullanıcı deneyimi öncelikli)
//          TTL: 5 dakika — acquire_device_lock() fonksiyonu DB'de yönetir

async function acquireDeviceLock(
  projectId: string,
  userId:    string,
  deviceId:  string,
): Promise<{ acquired: boolean; reason?: string }> {
  try {
    const { data, error } = await supabase.rpc('acquire_device_lock', {
      p_project_id: projectId,
      p_user_id:    userId,
      p_device_id:  deviceId,
    })
    if (error) throw error
    const result = data as { acquired: boolean; reason?: string }
    return result
  } catch (err: any) {
    console.warn('[acquireDeviceLock] Supabase hatası — kilit atlandı:', err.message)
    return { acquired: true }
  }
}

async function releaseDeviceLock(
  projectId: string,
  userId:    string,
  deviceId:  string,
): Promise<void> {
  try {
    await supabase.rpc('release_device_lock', {
      p_project_id: projectId,
      p_user_id:    userId,
      p_device_id:  deviceId,
    })
  } catch (err: any) {
    console.warn('[releaseDeviceLock] Supabase hatası:', err.message)
  }
}

// ─── TB-14: TOKEN SAYACI ──────────────────────────────────────
// Amaç:    Her mesaj sonrası token_count artırır, 50k geçince sıfırlar
// Bağlı:   user_projects.token_count — increment_token_count() + reset_token_count()
// Edge:    project_id null ise atlanır
//          Supabase hatası → sessiz geçilir, chat bloklanmaz
//          Dönen yeni sayaç null ise 0 kabul edilir

async function incrementTokenCount(
  projectId: string,
  userId:    string,
  amount:    number,
): Promise<number> {
  try {
    const { data, error } = await supabase.rpc('increment_token_count', {
      p_project_id: projectId,
      p_user_id:    userId,
      p_amount:     amount,
    })
    if (error) throw error
    return (data as number) ?? 0
  } catch (err: any) {
    console.warn('[incrementTokenCount] Supabase hatası:', err.message)
    return 0
  }
}

async function resetTokenCount(
  projectId: string,
  userId:    string,
): Promise<void> {
  try {
    await supabase.rpc('reset_token_count', {
      p_project_id: projectId,
      p_user_id:    userId,
    })
  } catch (err: any) {
    console.warn('[resetTokenCount] Supabase hatası:', err.message)
  }
}

// ─── TB-14: CORE DOC INJECT ───────────────────────────────────
// Amaç:    token_count > 50k veya yeni session'da core_doc+ai_agent_doc system prompt'a eklenir
// Bağlı:   user_projects.core_doc + ai_agent_doc + token_count
// Edge:    core_doc veya ai_agent_doc null ise inject atlanır — sistem bloklanmaz
//          project_id null ise inject atlanır
//          Supabase hatası → sessiz geçilir, orijinal system prompt korunur
//          Bu fonksiyon Claude çağrısından ÖNCE çalışmalı — sıra değiştirilemez

interface CoreInjectResult {
  systemPrompt:  string
  injected:      boolean
  tokenReset:    boolean
}

async function injectCoreDocsIfNeeded(
  baseSystemPrompt: string,
  projectId:        string | null,
  userId:           string,
  isFirstMessage:   boolean,
): Promise<CoreInjectResult> {
  if (!projectId) {
    return { systemPrompt: baseSystemPrompt, injected: false, tokenReset: false }
  }

  try {
    const { data, error } = await supabase
      .from('user_projects')
      .select('core_doc, ai_agent_doc, token_count')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single()

    if (error || !data) {
      return { systemPrompt: baseSystemPrompt, injected: false, tokenReset: false }
    }

    const row         = data as { core_doc: string | null; ai_agent_doc: string | null; token_count: number }
    const shouldInject = isFirstMessage || row.token_count >= CORE_INJECT_TOKEN_THRESHOLD

    if (!shouldInject || !row.core_doc || !row.ai_agent_doc) {
      return { systemPrompt: baseSystemPrompt, injected: false, tokenReset: false }
    }

    const coreSuffix = [
      '---',
      '## PROJE CORE DOKÜMANI',
      row.core_doc,
      '---',
      '## PROJE AI_AGENT DOKÜMANI',
      row.ai_agent_doc,
      '---',
    ].join('\n')

    const enrichedPrompt = `${baseSystemPrompt}\n\n${coreSuffix}`

    const tokenReset = row.token_count >= CORE_INJECT_TOKEN_THRESHOLD
    if (tokenReset) {
      await resetTokenCount(projectId, userId)
    }

    return { systemPrompt: enrichedPrompt, injected: true, tokenReset }

  } catch (err: any) {
    console.warn('[injectCoreDocsIfNeeded] Supabase hatası — inject atlandı:', err.message)
    return { systemPrompt: baseSystemPrompt, injected: false, tokenReset: false }
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
  isFirstMessage:  boolean,
): Promise<{
  systemPrompt:       string
  proactiveInjection: Awaited<ReturnType<typeof checkAndInjectProactive>>
  coreInjected:       boolean
  tokenReset:         boolean
}> {
  const proactiveInjection = await checkAndInjectProactive(userId, projectId, localMemoryPath)
  const basePrompt = proactiveInjection.injected
    ? `${SOVEREIGN_SYSTEM}\n\n${proactiveInjection.system_suffix}`
    : SOVEREIGN_SYSTEM

  const coreInject = await injectCoreDocsIfNeeded(basePrompt, projectId, userId, isFirstMessage)

  return {
    systemPrompt:       coreInject.systemPrompt,
    proactiveInjection,
    coreInjected:       coreInject.injected,
    tokenReset:         coreInject.tokenReset,
  }
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

// ─── KOD KALİTE GUARD ÇAĞIRICI (TB-12 / TB-13) ───────────────
// Amaç:    Kod üretim isteği tespit edilince 4 katmanlı kalite pipeline çalıştırır
// Bağlı:   runCodeQualityGuard() → codeQualityGuard.ts
// Karar:   TB-12 (pipeline), TB-13 (judgeVerdict qualityMeta'ya eklendi)
// Edge:    Guard hatası → orijinal reply korunur, sistem bloklanmaz
//          escalated: true → kullanıcıya quality_warning eklenir
//          judgeVerdict null olabilir — lint geçmeden judge çalışmaz

async function applyCodeQualityGuard(
  userText: string,
  reply:    string,
): Promise<{ reply: string; qualityMeta: Record<string, unknown> | null }> {
  if (!isCodeGenerationRequest(userText)) {
    return { reply, qualityMeta: null }
  }

  try {
    const guardResult = await runCodeQualityGuard({
      client:         claude,
      originalPrompt: userText,
      rawReply:       reply,
    })

    return {
      reply: guardResult.code || reply,
      qualityMeta: {
        score:         guardResult.lintResult.score,
        maxScore:      guardResult.lintResult.maxScore,
        passed:        guardResult.passed,
        iterations:    guardResult.iterations,
        escalated:     guardResult.escalated,
        summary:       guardResult.lintResult.summary,
        judge: guardResult.judgeVerdict
          ? {
              score:         guardResult.judgeVerdict.score,
              confidence:    guardResult.judgeVerdict.confidence,
              passed:        guardResult.judgeVerdict.passed,
              failed_checks: guardResult.judgeVerdict.failed_checks,
              todos:         guardResult.judgeVerdict.todos,
            }
          : null,
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
    device_id         = null,
  } = validation.data

  const userId = (req as any).user?.id ?? 'anonymous'

  // TB-14: Device lock — project_id ve device_id varsa kilit al
  if (project_id && device_id) {
    const lockResult = await acquireDeviceLock(project_id, userId, device_id)
    if (!lockResult.acquired) {
      return res.status(409).json({
        error:       'Bu proje başka bir cihazdan açık.',
        reason:      lockResult.reason ?? 'DEVICE_LOCKED',
        retry_after: 300,
      })
    }
  }

  try {
    const integrityMessage = await runSessionSetup(userId, project_id, local_memory_path, is_first_message)

    // TB-14: buildSystemPromptWithInjection artık is_first_message alıyor
    const { systemPrompt, proactiveInjection, coreInjected, tokenReset } =
      await buildSystemPromptWithInjection(userId, project_id, local_memory_path, is_first_message)

    const { reply: rawReply, inputTokens, outputTokens } =
      await callClaudeChat(messages, max_tokens, systemPrompt)

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    const userText    = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''

    const { reply, qualityMeta } = await applyCodeQualityGuard(userText, rawReply)

    const risk = await scoreChatRisk(userText, reply, claude)

    const reactiveInjection = await checkAndInject(userId, project_id, local_memory_path, inputTokens, outputTokens)

    // TB-14: Token sayacını artır — toplam token (input + output)
    if (project_id) {
      await incrementTokenCount(project_id, userId, inputTokens + outputTokens)
    }

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
      // TB-14: core inject bilgisi — UI heartbeat için kullanılabilir
      core_injected:     coreInjected,
      token_reset:       tokenReset,
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
// TB-14: session kapanışında device lock bırakılır

router.post('/session/close', async (req: Request, res: Response) => {
  const userId = (req as any).user?.id ?? null
  if (!userId) return res.status(401).json({ error: 'Yetkisiz' })

  const { project_id, local_memory_path = null, messages = [], device_id = null } = req.body

  if (!project_id || typeof project_id !== 'string') {
    return res.status(400).json({ error: 'project_id zorunlu' })
  }

  try {
    await closeSession(userId, project_id, 'normal', local_memory_path)
    const { content, error } = await generateSessionSummary({ userId, projectId: project_id, messages })

    // TB-14: Session kapanışında device lock bırak
    if (device_id && typeof device_id === 'string') {
      await releaseDeviceLock(project_id, userId, device_id)
    }

    return res.json({ closed: true, project_id, summary_content: content, summary_error: error })

  } catch (err: any) {
    console.error('[aiProxy/session/close] Hata:', err.message)

    // TB-14: Hata durumunda da lock bırak — sızıntı önlenir
    if (device_id && typeof device_id === 'string') {
      await releaseDeviceLock(project_id, userId, device_id)
    }

    return res.status(500).json({ error: 'Session kapatılamadı' })
  }
})

// ─── POST /api/ai/device/release ─────────────────────────────
// TB-14: Tarayıcı/uygulama kapanırken veya proje değiştirilirken
//        istemci bu endpoint'i çağırarak kilidi açar.
// Edge:  beforeunload event'i güvenilmez — TTL (5 dk) son savunma hattıdır.

router.post('/device/release', async (req: Request, res: Response) => {
  const userId = (req as any).user?.id ?? null
  if (!userId) return res.status(401).json({ error: 'Yetkisiz' })

  const { project_id, device_id } = req.body

  if (!project_id || typeof project_id !== 'string') {
    return res.status(400).json({ error: 'project_id zorunlu' })
  }

  if (!device_id || typeof device_id !== 'string') {
    return res.status(400).json({ error: 'device_id zorunlu' })
  }

  // SSC-3: device_id UUID v4 format kontrolü
  if (!DEVICE_UUID_REGEX.test(device_id)) {
    return res.status(400).json({ error: 'device_id geçerli UUID v4 formatında olmalı' })
  }

  await releaseDeviceLock(project_id, userId, device_id)
  return res.json({ released: true, project_id })
})

// ─── POST /api/ai/device/heartbeat ───────────────────────────
// TB-14: Aktif cihaz her 4 dakikada bir bu endpoint'i çağırarak
//        device_locked_at'ı tazeler — TTL sıfırlanmaz, saat güncellenir.
// Edge:  acquire_device_lock() aynı device_id için heartbeat görevi görür.

router.post('/device/heartbeat', async (req: Request, res: Response) => {
  const userId = (req as any).user?.id ?? null
  if (!userId) return res.status(401).json({ error: 'Yetkisiz' })

  const { project_id, device_id } = req.body

  if (!project_id || typeof project_id !== 'string') {
    return res.status(400).json({ error: 'project_id zorunlu' })
  }

  if (!device_id || typeof device_id !== 'string') {
    return res.status(400).json({ error: 'device_id zorunlu' })
  }

  // SSC-3: device_id UUID v4 format kontrolü
  if (!DEVICE_UUID_REGEX.test(device_id)) {
    return res.status(400).json({ error: 'device_id geçerli UUID v4 formatında olmalı' })
  }

  const result = await acquireDeviceLock(project_id, userId, device_id)

  if (!result.acquired) {
    return res.status(409).json({
      error:  'Heartbeat başarısız — kilit başka cihazda.',
      reason: result.reason ?? 'DEVICE_LOCKED',
    })
  }

  return res.json({ alive: true, project_id })
})

export default router
