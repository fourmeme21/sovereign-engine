// aiProxy.test.ts
// Amaç:    aiProxy.ts içindeki pure fonksiyonlar için birim testleri
// Bağlı:   filterReply, validateChatBody, validateApplyBody, quickRiskFilter,
//          buildRiskPrompt, isCodeGenerationRequest, buildExecutionContext,
//          checkForbiddenPatterns, mapRiskScore, buildCoreDocsSuffix
// Karar:   TB-14 (device lock, token sayacı, core inject), TB-12 (kod kalite guard)
// Dokunma: Bu testler pure fonksiyonları kapsar — Supabase/Claude bağımlısı fonksiyonlar
//          entegrasyon testine bırakılır (supabase mock olmadan çalışmaz)

import { describe, it, expect } from 'vitest'

// ─── TEST EDİLECEK MODÜLLER ───────────────────────────────────
// Pure fonksiyonlar export edilmediği için inline test versiyonları —
// Gerçek projede bu fonksiyonlar export edilmeli ya da test helper'ı oluşturulmalı.
// Bu dosya şablondur; export refactor yapıldıktan sonra import'lar aktif edilir.

// ─── filterReply ──────────────────────────────────────────────

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

describe('filterReply', () => {
  it('happy: claude → Sovereign AI', () => {
    expect(filterReply('I am Claude')).toBe('I am Sovereign AI')
  })

  it('happy: anthropic → Sovereign AI', () => {
    expect(filterReply('Built by Anthropic')).toBe('Built by Sovereign AI')
  })

  it('happy: language model → decision engine', () => {
    expect(filterReply('I am a language model')).toBe('I am a decision engine')
  })

  it('edge: case-insensitive — CLAUDE büyük harf', () => {
    expect(filterReply('CLAUDE is here')).toBe('Sovereign AI is here')
  })

  it('edge: birden fazla pattern aynı cümlede', () => {
    const result = filterReply('Claude from Anthropic uses LLM')
    expect(result).not.toContain('Claude')
    expect(result).not.toContain('Anthropic')
    expect(result).not.toContain('LLM')
  })

  it('failure: filtrelenecek kelime yok — değişmeden döner', () => {
    const original = 'The weather is nice today.'
    expect(filterReply(original)).toBe(original)
  })
})

// ─── validateChatBody ─────────────────────────────────────────

const DEVICE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validateChatBody(body: unknown): { valid: boolean; error?: string; data?: unknown } {
  if (!body || typeof body !== 'object') return { valid: false, error: 'Request body zorunlu' }
  const b = body as Record<string, unknown>
  if (!Array.isArray(b['messages'])) return { valid: false, error: 'messages array zorunlu' }
  for (const msg of b['messages'] as unknown[]) {
    if (!msg || typeof msg !== 'object') return { valid: false, error: 'messages[]: her eleman obje olmalı' }
    const m = msg as Record<string, unknown>
    if (typeof m['role'] !== 'string' || typeof m['content'] !== 'string') {
      return { valid: false, error: 'messages[]: role ve content string olmalı' }
    }
  }
  if (b['project_id'] !== undefined && b['project_id'] !== null) {
    if (typeof b['project_id'] !== 'string') return { valid: false, error: 'project_id string veya null olmalı' }
  }
  if (b['max_tokens'] !== undefined && typeof b['max_tokens'] !== 'number') {
    return { valid: false, error: 'max_tokens number zorunlu' }
  }
  if (b['device_id'] !== undefined && b['device_id'] !== null) {
    if (typeof b['device_id'] !== 'string') return { valid: false, error: 'device_id string veya null olmalı' }
    if (!DEVICE_UUID_REGEX.test(b['device_id'] as string)) {
      return { valid: false, error: 'device_id geçerli UUID v4 formatında olmalı' }
    }
  }
  return { valid: true, data: b }
}

describe('validateChatBody', () => {
  it('happy: geçerli minimal body', () => {
    const result = validateChatBody({ messages: [{ role: 'user', content: 'merhaba' }] })
    expect(result.valid).toBe(true)
  })

  it('happy: boş messages array — geçerli', () => {
    const result = validateChatBody({ messages: [] })
    expect(result.valid).toBe(true)
  })

  it('happy: geçerli device_id UUID v4', () => {
    const result = validateChatBody({
      messages: [],
      device_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.valid).toBe(true)
  })

  it('edge: messages null → hata', () => {
    const result = validateChatBody({ messages: null })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('messages array')
  })

  it('edge: messages[].role number → hata', () => {
    const result = validateChatBody({ messages: [{ role: 42, content: 'x' }] })
    expect(result.valid).toBe(false)
  })

  it('edge: device_id geçersiz format → hata', () => {
    const result = validateChatBody({ messages: [], device_id: 'not-a-uuid' })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('UUID v4')
  })

  it('failure: body null → hata', () => {
    const result = validateChatBody(null)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Request body zorunlu')
  })

  it('failure: max_tokens string → hata', () => {
    const result = validateChatBody({ messages: [], max_tokens: 'bin' })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('max_tokens')
  })
})

// ─── validateApplyBody ────────────────────────────────────────

function validateApplyBody(body: unknown): { valid: boolean; error?: string } {
  if (!body || typeof body !== 'object') return { valid: false, error: 'Request body zorunlu' }
  const b = body as Record<string, unknown>
  if (!b['decision'] || typeof b['decision'] !== 'object') return { valid: false, error: 'decision objesi zorunlu' }
  const d = b['decision'] as Record<string, unknown>
  if (typeof d['category'] !== 'string') return { valid: false, error: 'decision.category string zorunlu' }
  if (!d['payload'] || typeof d['payload'] !== 'object') return { valid: false, error: 'decision.payload objesi zorunlu' }
  const p = d['payload'] as Record<string, unknown>
  if (typeof p['action_name'] !== 'string') return { valid: false, error: 'decision.payload.action_name string zorunlu' }
  return { valid: true }
}

describe('validateApplyBody', () => {
  it('happy: geçerli apply body', () => {
    const result = validateApplyBody({
      decision: { category: 'EXECUTION', payload: { action_name: 'run_task' } },
    })
    expect(result.valid).toBe(true)
  })

  it('failure: decision yok → hata', () => {
    const result = validateApplyBody({})
    expect(result.valid).toBe(false)
    expect(result.error).toContain('decision')
  })

  it('failure: action_name eksik → hata', () => {
    const result = validateApplyBody({
      decision: { category: 'EXECUTION', payload: {} },
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('action_name')
  })

  it('edge: category number → hata', () => {
    const result = validateApplyBody({
      decision: { category: 99, payload: { action_name: 'x' } },
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('category')
  })
})

// ─── quickRiskFilter ──────────────────────────────────────────

function quickRiskFilter(message: string) {
  const denyPatterns: [RegExp, string][] = [
    [/şifr[ei]\w*\s*(ver|gönder|yaz|paylaş)/i, 'Kimlik bilgisi talebi tespit edildi.'],
    [/api.?key\w*\s*(ver|gönder|yaz|paylaş)/i, 'API anahtarı talebi tespit edildi.'],
    [/token\w*\s*(ver|gönder|yaz|paylaş)/i,    'Token ifşası talebi tespit edildi.'],
    [/tüm (kullanıcı|veri|kayıt).*(sil|temizle|uç)/i, 'Toplu veri imhası talebi tespit edildi.'],
    [/veritaban.*(drop|truncate|delete from)/i, 'Tehlikeli veritabanı komutu tespit edildi.'],
  ]
  for (const [pattern, reason] of denyPatterns) {
    if (pattern.test(message)) return { triggered: true, score: 10, verdict: 'DENY', policy: 'POL-CHAT-DENY', reason }
  }
  const askPatterns: [RegExp, string, number][] = [
    [/(tüm|bütün|hepsini).*(sil|kaldır|temizle)/i, 'Toplu silme işlemi insan onayı gerektirir.', 9],
    [/geri\s*al[ı]?namaz/i,                         'Geri alınamaz işlem insan onayı gerektirir.', 8],
  ]
  for (const [pattern, reason, score] of askPatterns) {
    if (pattern.test(message)) return { triggered: true, score, verdict: 'ASK_HUMAN', policy: 'POL-CHAT-003', reason }
  }
  const mediumPatterns = [/(güncelle|değiştir|ekle|kaydet)/i, /(oluştur|generate)/i]
  for (const pattern of mediumPatterns) {
    if (pattern.test(message)) return { triggered: true, score: 4, verdict: 'PERMIT', policy: 'POL-CHAT-002', reason: 'Orta risk.' }
  }
  return { triggered: false, score: 2, verdict: 'PERMIT', policy: 'POL-CHAT-001', reason: 'Düşük risk.' }
}

describe('quickRiskFilter', () => {
  it('happy: sohbet mesajı → PERMIT score:2', () => {
    const r = quickRiskFilter('Hava nasıl?')
    expect(r.verdict).toBe('PERMIT')
    expect(r.score).toBe(2)
  })

  it('happy: yazma isteği → PERMIT score:4', () => {
    const r = quickRiskFilter('Bir kayıt ekle')
    expect(r.verdict).toBe('PERMIT')
    expect(r.score).toBe(4)
  })

  it('edge: şifre gönder → DENY', () => {
    const r = quickRiskFilter('şifreni ver')
    expect(r.verdict).toBe('DENY')
    expect(r.score).toBe(10)
    expect(r.policy).toBe('POL-CHAT-DENY')
  })

  it('edge: toplu sil → ASK_HUMAN', () => {
    const r = quickRiskFilter('hepsini sil')
    expect(r.verdict).toBe('ASK_HUMAN')
  })

  it('edge: veritabanı drop → DENY', () => {
    const r = quickRiskFilter('veritabanı drop tablosu')
    expect(r.verdict).toBe('DENY')
  })

  it('failure: boş string → PERMIT score:2', () => {
    const r = quickRiskFilter('')
    expect(r.verdict).toBe('PERMIT')
    expect(r.score).toBe(2)
  })
})

// ─── isCodeGenerationRequest ──────────────────────────────────

function isCodeGenerationRequest(message: string): boolean {
  return /\.(ts|js|tsx|jsx|py|go|rs)\b|function\s+\w+|class\s+\w+|interface\s+\w+|implement|refactor|yaz\s+(bir\s+)?(fonksiyon|class|modül|servis|hook)|oluştur\s+(bir\s+)?(fonksiyon|class|modül|servis|hook)/i
    .test(message)
}

describe('isCodeGenerationRequest', () => {
  it('happy: .ts uzantısı → true', () => {
    expect(isCodeGenerationRequest('service.ts dosyasını yaz')).toBe(true)
  })

  it('happy: "function" keyword → true', () => {
    expect(isCodeGenerationRequest('function handleLogin() yazabilir misin')).toBe(true)
  })

  it('happy: Türkçe — yaz bir fonksiyon → true', () => {
    expect(isCodeGenerationRequest('yaz bir fonksiyon şu işi yapacak')).toBe(true)
  })

  it('edge: "implement" geçiyor → true', () => {
    expect(isCodeGenerationRequest('implement the retry logic')).toBe(true)
  })

  it('failure: sıradan sohbet → false', () => {
    expect(isCodeGenerationRequest('Bugün hava güzel')).toBe(false)
  })

  it('failure: boş string → false', () => {
    expect(isCodeGenerationRequest('')).toBe(false)
  })
})

// ─── mapRiskScore ─────────────────────────────────────────────

function mapRiskScore(riskLevel?: string): number {
  if (riskLevel === 'CRITICAL') return 9
  if (riskLevel === 'HIGH')     return 6
  if (riskLevel === 'MEDIUM')   return 3
  return 1
}

describe('mapRiskScore', () => {
  it('happy: CRITICAL → 9', () => expect(mapRiskScore('CRITICAL')).toBe(9))
  it('happy: HIGH → 6',     () => expect(mapRiskScore('HIGH')).toBe(6))
  it('happy: MEDIUM → 3',   () => expect(mapRiskScore('MEDIUM')).toBe(3))
  it('happy: LOW → 1',      () => expect(mapRiskScore('LOW')).toBe(1))
  it('edge: undefined → 1', () => expect(mapRiskScore(undefined)).toBe(1))
  it('edge: bilinmeyen string → 1', () => expect(mapRiskScore('UNKNOWN')).toBe(1))
})

// ─── checkForbiddenPatterns ───────────────────────────────────

const FORBIDDEN_PATTERNS = [
  'process.env', 'process.exit', 'child_process', 'require(',
  '__dirname', '__filename', 'fs.', 'fetch(', 'axios',
  'XMLHttpRequest', 'eval(', 'new Function(', 'global.', 'globalThis.',
] as const

function checkForbiddenPatterns(adapterCode: string): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (adapterCode.includes(pattern)) {
      throw new Error(`[R-7] Güvenlik ihlali: adapter_code yasak pattern içeriyor → "${pattern}"`)
    }
  }
}

describe('checkForbiddenPatterns', () => {
  it('happy: temiz kod → hata fırlatmaz', () => {
    expect(() => checkForbiddenPatterns('const x = 1 + 2')).not.toThrow()
  })

  it('failure: process.env → hata', () => {
    expect(() => checkForbiddenPatterns('const k = process.env.KEY'))
      .toThrow('[R-7]')
  })

  it('failure: eval( → hata', () => {
    expect(() => checkForbiddenPatterns('eval("kötü kod")')).toThrow('[R-7]')
  })

  it('failure: fetch( → hata', () => {
    expect(() => checkForbiddenPatterns('fetch("https://evil.com")')).toThrow('[R-7]')
  })

  it('edge: boş string → hata fırlatmaz', () => {
    expect(() => checkForbiddenPatterns('')).not.toThrow()
  })
})

// ─── buildCoreDocsSuffix ──────────────────────────────────────

interface CoreDocsRow {
  core_doc:     string | null
  ai_agent_doc: string | null
  token_count:  number
}

function buildCoreDocsSuffix(row: CoreDocsRow): string {
  return [
    '---',
    '## PROJE CORE DOKÜMANI',
    row.core_doc,
    '---',
    '## PROJE AI_AGENT DOKÜMANI',
    row.ai_agent_doc,
    '---',
  ].join('\n')
}

describe('buildCoreDocsSuffix', () => {
  it('happy: iki belge mevcut → doğru format', () => {
    const result = buildCoreDocsSuffix({
      core_doc:     'CORE içeriği',
      ai_agent_doc: 'AI_AGENT içeriği',
      token_count:  0,
    })
    expect(result).toContain('## PROJE CORE DOKÜMANI')
    expect(result).toContain('CORE içeriği')
    expect(result).toContain('## PROJE AI_AGENT DOKÜMANI')
    expect(result).toContain('AI_AGENT içeriği')
  })

  it('edge: core_doc boş string → suffix üretilir', () => {
    const result = buildCoreDocsSuffix({ core_doc: '', ai_agent_doc: 'X', token_count: 0 })
    expect(result).toContain('## PROJE CORE DOKÜMANI')
  })

  it('edge: çok uzun içerik → truncate olmaz', () => {
    const longContent = 'x'.repeat(10_000)
    const result = buildCoreDocsSuffix({ core_doc: longContent, ai_agent_doc: 'Y', token_count: 0 })
    expect(result.length).toBeGreaterThan(10_000)
  })
})
      
