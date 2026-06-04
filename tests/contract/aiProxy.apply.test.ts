/**
 * tests/contract/aiProxy.apply.test.ts
 *
 * /api/apply entegrasyon testi — ADAPTERv1 Session 9
 *
 * Kapsam:
 *   T-1: Kategori eşleşiyor, execute başarılı
 *   T-2: Kategori eşleşmiyor → matched:false, log yok
 *   T-3: validateContract() false → fail-closed
 *   T-4: KAT-1 güvenlik ihlali (yasak pattern)
 *   T-5: execute() hata fırlatır → success:false, REJECTED
 *   T-6: Auth yok → 401
 *   T-7: decision.category eksik → 400
 *   T-8: Registry boş → matched:false
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// ─── MOCK'LAR ────────────────────────────────────────────────
//
// Supabase ve adapterRegistry dışarıya bağımlı — mock'lanır.
// Gerçek DB / Anthropic API çağrısı yapılmaz.

vi.mock('../../src/lib/supabase.js', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    }),
  },
}))

vi.mock('../../src/lib/adapterRegistry.js', () => ({
  loadRegistry: vi.fn(),
  matchCategory: vi.fn(),
}))

vi.mock('../../src/lib/contextInjector.js', () => ({
  checkAndInject: vi.fn().mockResolvedValue({ injected: false }),
}))

// Anthropic mock — /chat için gerekli, /apply testlerini etkilemez
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'mock reply' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    },
  })),
}))

import { loadRegistry, matchCategory } from '../../src/lib/adapterRegistry.js'
import { supabase } from '../../src/lib/supabase.js'
import aiProxyRouter from '../../src/routes/aiProxy.js'

// ─── TEST APP ─────────────────────────────────────────────────
//
// authMiddleware bypass: req.user + req.userTier doğrudan set edilir.
// Gerçek JWT doğrulaması bu testin kapsamı dışında.

function buildApp(opts: { authenticated: boolean } = { authenticated: true }) {
  const app = express()
  app.use(express.json())

  // Auth middleware simülasyonu
  app.use((req, _res, next) => {
    if (opts.authenticated) {
      ;(req as any).user     = { id: 'user-test-001', email: 'test@example.com' }
      ;(req as any).userTier = 'solo'
    }
    next()
  })

  app.use('/api/ai', aiProxyRouter)
  return app
}

// ─── FIXTURE: Başarılı adapter kodu ──────────────────────────
//
// vm sandbox içinde çalışacak — yasak pattern yok, validateContract true.
const VALID_ADAPTER_CODE = `
exports.default = class TestAdapter {
  validateContract() { return Promise.resolve(true) }
  execute(actionName, params, ctx) {
    return Promise.resolve({ success: true, output: { actionName, params, actorId: ctx.actor_id } })
  }
}
`

// ─── FIXTURE: validateContract false döndüren adapter ────────
const INVALID_CONTRACT_CODE = `
exports.default = class BadAdapter {
  validateContract() { return Promise.resolve(false) }
  execute() { return Promise.resolve({ success: true }) }
}
`

// ─── FIXTURE: execute hata fırlatan adapter ──────────────────
const FAILING_EXECUTE_CODE = `
exports.default = class FailAdapter {
  validateContract() { return Promise.resolve(true) }
  execute() { throw new Error('Simüle edilmiş execute hatası') }
}
`

// ─── FIXTURE: Yasak pattern içeren adapter ───────────────────
const FORBIDDEN_ADAPTER_CODE = `
exports.default = class EvilAdapter {
  validateContract() { return Promise.resolve(true) }
  execute() {
    const x = process.env.SECRET
    return Promise.resolve({ success: true })
  }
}
`

// ─── FIXTURE: Geçerli decision objesi ────────────────────────
function makeDecision(overrides = {}) {
  return {
    category:   'WRITE_RESOURCE',
    project_id: 'proj-001',
    payload: {
      action_name: 'CREATE_NOTE',
      params:      { title: 'Test notu', content: 'İçerik' },
    },
    context: {
      session_id: 'sess-test-001',
      risk_level: 'LOW',
    },
    ...overrides,
  }
}

// ─── FIXTURE: Eşleşen registry kaydı ─────────────────────────
function makeAdapterRecord(adapter_code: string) {
  return {
    id:           'adapter-001',
    user_id:      'user-test-001',
    adapter_name: 'test-adapter',
    adapter_code,
    categories:   ['WRITE_RESOURCE'],
    version:      '1.0.0',
    is_active:    true,
  }
}

// ─── TESTLER ─────────────────────────────────────────────────

describe('POST /api/ai/apply', () => {

  beforeEach(() => {
    vi.clearAllMocks()

    // Supabase insert default: başarılı
    ;(supabase.from as any).mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    })
  })

  // ── T-1: Başarılı execution ───────────────────────────────
  it('T-1: kategori eşleşiyor ve execute başarılı → matched:true, success:true', async () => {
    const adapterRecord = makeAdapterRecord(VALID_ADAPTER_CODE)

    ;(loadRegistry as any).mockResolvedValue({
      categoryMap:  new Map([['WRITE_RESOURCE', adapterRecord]]),
      adapterCount: 1,
      limit:        3,
    })
    ;(matchCategory as any).mockReturnValue({
      matched: true,
      adapter: adapterRecord,
      category: 'WRITE_RESOURCE',
    })

    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({ decision: makeDecision() })

    expect(res.status).toBe(200)
    expect(res.body.matched).toBe(true)
    expect(res.body.success).toBe(true)
    expect(res.body.category).toBe('WRITE_RESOURCE')
    expect(res.body.adapter).toBe('test-adapter')
    expect(res.body.bundle_id).toMatch(/^bundle-/)
    expect(res.body.output).toBeDefined()
  })

  // ── T-2: Kategori eşleşmiyor ──────────────────────────────
  it('T-2: kategori eşleşmiyor → matched:false, Supabase insert yok', async () => {
    ;(loadRegistry as any).mockResolvedValue({
      categoryMap:  new Map(),
      adapterCount: 1,
      limit:        3,
    })
    ;(matchCategory as any).mockReturnValue({ matched: false })

    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({ decision: makeDecision({ category: 'UNKNOWN_CATEGORY' }) })

    expect(res.status).toBe(200)
    expect(res.body.matched).toBe(false)
    expect(res.body.message).toContain('sohbet olarak değerlendirildi')

    // Karar #4: log yazılmaz
    expect(supabase.from).not.toHaveBeenCalled()
  })

  // ── T-3: validateContract false → fail-closed ─────────────
  it('T-3: validateContract() false → success:false, execute çağrılmaz', async () => {
    const adapterRecord = makeAdapterRecord(INVALID_CONTRACT_CODE)

    ;(loadRegistry as any).mockResolvedValue({
      categoryMap:  new Map([['WRITE_RESOURCE', adapterRecord]]),
      adapterCount: 1,
      limit:        3,
    })
    ;(matchCategory as any).mockReturnValue({
      matched:  true,
      adapter:  adapterRecord,
      category: 'WRITE_RESOURCE',
    })

    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({ decision: makeDecision() })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toContain('validateContract')
  })

  // ── T-4: KAT-1 güvenlik ihlali ───────────────────────────
  it('T-4: adapter_code yasak pattern içeriyor → success:false', async () => {
    const adapterRecord = makeAdapterRecord(FORBIDDEN_ADAPTER_CODE)

    ;(loadRegistry as any).mockResolvedValue({
      categoryMap:  new Map([['WRITE_RESOURCE', adapterRecord]]),
      adapterCount: 1,
      limit:        3,
    })
    ;(matchCategory as any).mockReturnValue({
      matched:  true,
      adapter:  adapterRecord,
      category: 'WRITE_RESOURCE',
    })

    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({ decision: makeDecision() })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toContain('R-7')
    expect(res.body.error).toContain('process.env')
  })

  // ── T-5: execute hata fırlatır → REJECTED ─────────────────
  it('T-5: execute() hata fırlatır → success:false, Supabase REJECTED yazar', async () => {
    const adapterRecord = makeAdapterRecord(FAILING_EXECUTE_CODE)

    const insertMock = vi.fn().mockResolvedValue({ error: null })
    ;(supabase.from as any).mockReturnValue({ insert: insertMock })

    ;(loadRegistry as any).mockResolvedValue({
      categoryMap:  new Map([['WRITE_RESOURCE', adapterRecord]]),
      adapterCount: 1,
      limit:        3,
    })
    ;(matchCategory as any).mockReturnValue({
      matched:  true,
      adapter:  adapterRecord,
      category: 'WRITE_RESOURCE',
    })

    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({ decision: makeDecision() })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toContain('Adapter execution hatası')

    // Supabase'e REJECTED yazılmalı
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'REJECTED', policy_verdict: 'DENY' }),
    )
  })

  // ── T-6: Auth yok → 401 ───────────────────────────────────
  it('T-6: auth yok → 401', async () => {
    const res = await request(buildApp({ authenticated: false }))
      .post('/api/ai/apply')
      .send({ decision: makeDecision() })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Yetkisiz')
  })

  // ── T-7: decision.category eksik → 400 ───────────────────
  it('T-7: decision.category eksik → 400', async () => {
    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({
        decision: {
          payload: { action_name: 'CREATE_NOTE', params: {} },
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('category')
  })

  // ── T-7b: decision.payload.action_name eksik → 400 ───────
  it('T-7b: decision.payload.action_name eksik → 400', async () => {
    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({
        decision: {
          category: 'WRITE_RESOURCE',
          payload:  {},
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('action_name')
  })

  // ── T-8: Registry boş → matched:false ────────────────────
  it('T-8: registry boş (adapter yok) → matched:false', async () => {
    ;(loadRegistry as any).mockResolvedValue({
      categoryMap:  new Map(),
      adapterCount: 0,
      limit:        1,
    })
    ;(matchCategory as any).mockReturnValue({ matched: false })

    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({ decision: makeDecision() })

    expect(res.status).toBe(200)
    expect(res.body.matched).toBe(false)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  // ── T-9: Supabase log hatası → execution sonucu yine döner
  it('T-9: Supabase insert hatası → execution sonucu yine döner (fail-open değil)', async () => {
    const adapterRecord = makeAdapterRecord(VALID_ADAPTER_CODE)

    // Supabase insert hata döndürür
    ;(supabase.from as any).mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: { message: 'DB bağlantı hatası' } }),
    })

    ;(loadRegistry as any).mockResolvedValue({
      categoryMap:  new Map([['WRITE_RESOURCE', adapterRecord]]),
      adapterCount: 1,
      limit:        3,
    })
    ;(matchCategory as any).mockReturnValue({
      matched:  true,
      adapter:  adapterRecord,
      category: 'WRITE_RESOURCE',
    })

    const res = await request(buildApp())
      .post('/api/ai/apply')
      .send({ decision: makeDecision() })

    // Log başarısız olsa bile execution sonucu dönmeli
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.matched).toBe(true)
  })

})
