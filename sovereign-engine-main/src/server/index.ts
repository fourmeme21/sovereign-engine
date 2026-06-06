/**
 * engine/src/server/index.ts
 *
 * Amaç:    Sovereign Engine HTTP + WebSocket sunucusu.
 *          Express app kurulumu, route bağlantıları, WS broadcast, keep-alive.
 * Bağlı:   policyEngine.ts (policy değerlendirme)
 *          contextInjector.ts (proje cache)
 *          sessionManager.ts (orphan session cleanup)
 *          Tüm route'lar: memory / github / admin / billing / ai / project / user
 * Karar:   evaluatePatch + issueToken → policyEngine.ts'e taşındı (Session 11 refactor)
 * Dokunma: CORS origin listesi, rate limit değerleri, PORT değiştirilmeden önce
 *          ARCHITECTURE.md §1 (deployment) okunmalı.
 */

import express    from 'express'
import http       from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import cors       from 'cors'
import rateLimit  from 'express-rate-limit'
import { v4 as uuid } from 'uuid'
import { supabase }              from './lib/supabase.js'
import { authMiddleware }        from './middleware/authMiddleware.js'
import { tierGuard }             from './middleware/tierGuard.js'
import memoryRouter              from './routes/memoryRouter.js'
import githubRouter              from './routes/githubRouter.js'
import adminRouter               from './routes/adminRouter.js'
import dodoRouter                from './routes/dodoRouter.js'
import aiProxy                   from './routes/aiProxy.js'
import projectRouter             from './routes/projectRouter.js'
import userRouter                from './routes/userRouter.js'
import { preloadProjectCache }   from './lib/contextInjector.js'
import { markOrphanSessions }    from './lib/sessionManager.js'
import {
  evaluatePatch,
  calcRiskScore,
  type PatchInput,
  type Verdict,
  type Criticality,
} from './lib/policyEngine.js'

// ─── ENV GUARD ───────────────────────────────────────────────
// Fail-closed: JWT_SECRET yoksa sistem başlamaz.

const JWT_SECRET = process.env['JWT_SECRET']
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET env değişkeni tanımlanmamış — sistem başlamıyor.')
  process.exit(1)
}

const MCP_URL = process.env['MCP_URL'] ?? ''
const PORT    = parseInt(process.env['PORT'] ?? '8080', 10)

// ─── TİPLER ──────────────────────────────────────────────────

export interface Decision {
  id:          string
  action:      string
  criticality: Criticality
  verdict:     Verdict
  policy:      string
  reason:      string
  token:       string | null
  time:        string
  latency:     string
}

export interface WsMessage {
  type:       'init' | 'decision' | 'ping'
  decisions?: Decision[]
  decision?:  Decision
}

// ─── IN-MEMORY DECISION STORE ────────────────────────────────
// Dashboard için son MAX_DECISIONS kararı tutar.
// Kalıcı kayıt Supabase'de — bu sadece UI için.

const MAX_DECISIONS   = 200
const decisionStore: Decision[] = []

function addDecision(d: Decision): void {
  decisionStore.unshift(d)
  if (decisionStore.length > MAX_DECISIONS) decisionStore.pop()
}

// ─── WEBSOCKET BROADCAST ─────────────────────────────────────

const clients = new Set<WebSocket>()

function broadcast(msg: WsMessage): void {
  const raw = JSON.stringify(msg)
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw)
  })
}

// ─── MCP PROXY ───────────────────────────────────────────────

/**
 * MCP_URL yoksa yapılandırma hatası döner — fail-open değil.
 * fetch hatası → MCP_UNREACHABLE, caller'a iletilir.
 */
async function mcpProxy(subpath: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!MCP_URL) {
    return {
      ok:    false,
      error: 'MCP_NOT_CONFIGURED',
      hint:  'Set MCP_URL env variable to your local mcp-server ngrok URL',
    }
  }

  try {
    const res  = await fetch(`${MCP_URL}${subpath}`, {
      method:  body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body:    body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json() as Record<string, unknown>
    return { ok: res.ok, ...data }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: 'MCP_UNREACHABLE', hint: msg }
  }
}

// ─── EXPRESS APP ─────────────────────────────────────────────

const app = express()

// CORS
const ALLOWED_ORIGINS = [
  process.env['APP_URL'],
  process.env['ALLOWED_ORIGIN'],
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean) as string[]

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
    callback(new Error(`CORS: izin verilmeyen origin — ${origin}`))
  },
  methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-password'],
}))

// Webhook raw body — express.json'dan ÖNCE tanımlanmalı
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, _res, next) => {
  ;(req as any).rawBody = (req.body as Buffer).toString('utf8')
  next()
})

app.use(express.json({ limit: '2mb' }))

// Rate limiting
const globalLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            120,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: 'Çok fazla istek — lütfen bekle.' },
})

const aiLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            30,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: 'AI rate limit aşıldı.' },
})

app.use(globalLimiter)
app.use('/api/ai', aiLimiter)

// ─── AÇIK ROUTE'LAR ──────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    decisions: decisionStore.length,
    uptime:    process.uptime(),
  })
})

// ─── KORUMALÜ ROUTE'LAR ──────────────────────────────────────

app.get('/api/decisions', authMiddleware, tierGuard(), (_req, res) => {
  res.json(decisionStore)
})

// Policy listesi — Rust core'daki hard lock kurallarının UI temsili
app.get('/api/policies', authMiddleware, (_req, res) => res.json([
  { id: 'POL-001', label: 'POL-001 · HL-1 · Immutable State',  meta: 'HL-1 · Immutable State Guard · HARD_LOCK',  type: 'HARD_LOCK',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    let immutable = vec!["system.config","audit.log","policy.kernel"];\n    if decision.action == ActionType::ModifyState {\n        for resource in &immutable {\n            if decision.target.contains(resource) {\n                return PolicyResult { verdict: Verdict::Deny, reason: format!("HL-1: Immutable \'{}\' blocked", resource), policy_id: "POL-001", token: None };\n            }\n        }\n    }\n    PolicyResult::pass()\n}' },
  { id: 'POL-002', label: 'POL-002 · HL-2 · Non-Negative',     meta: 'HL-2 · Non-Negative Value Guard',           type: 'HARD_LOCK',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if let Some(amount) = decision.payload.get("amount") {\n        if amount.as_f64().unwrap_or(0.0) < 0.0 {\n            return PolicyResult::deny("HL-2: Negative amount rejected");\n        }\n    }\n    PolicyResult::pass()\n}' },
  { id: 'POL-003', label: 'POL-003 · HL-3 · Critical->Human',  meta: 'HL-3 · Critical Escalation · HARD_LOCK',    type: 'HARD_LOCK',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if decision.criticality == Criticality::Critical {\n        return PolicyResult::ask_human("HL-3: Critical risk requires review");\n    }\n    PolicyResult::pass()\n}' },
  { id: 'POL-004', label: 'POL-004 · HL-4 · Ownership',        meta: 'HL-4 · Resource Ownership Guard',           type: 'ENFORCING',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    PolicyResult::pass()\n}' },
  { id: 'POL-007', label: 'POL-007 · Execution Token',          meta: 'Execution Token Validation · ENFORCING',   type: 'ENFORCING',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    PolicyResult::permit_with_token(ctx.issue_token(decision))\n}' },
  { id: 'POL-011', label: 'POL-011 · Human Escalation',         meta: 'Low Confidence -> ASK_HUMAN',              type: 'SOFT_STEER', code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if decision.confidence < 0.7 {\n        return PolicyResult::ask_human("Low confidence - operator review");\n    }\n    PolicyResult::pass()\n}' },
]))

// /api/session — anlık dashboard metrikleri
// TODO: PROD — memory alanı (l1/l2/l3) gerçek değerlerle doldurulmalı
// TODO: PROD — session id/hex/shortId gerçek session kaydından alınmalı
app.get('/api/session', authMiddleware, (_req, res) => {
  const permits = decisionStore.filter(d => d.verdict === 'PERMIT').length
  const denies  = decisionStore.filter(d => d.verdict === 'DENY').length
  const human   = decisionStore.filter(d => d.verdict === 'ASK_HUMAN').length

  res.json({
    id:          'sess-current',
    hex:         '0x0D',
    shortId:     'sess-0d-5a9b',
    started:     new Date(Date.now() - 38 * 60_000).toISOString(),
    agent:       'sovereign-agent-v3',
    decisions:   decisionStore.length,
    permits,
    denies,
    escalations: human,
    permitRate:  decisionStore.length
      ? Math.round((permits / decisionStore.length) * 100)
      : 0,
    memory: { l1: '—', l2: '—', l3: '—' }, // TODO: PROD — gerçek memory usage
    phases: [
      { faz: 'FAZ 0', title: 'Tip Sistemi',          done: true,  active: false },
      { faz: 'FAZ 1', title: 'Validation Engine',     done: true,  active: false },
      { faz: 'FAZ 2', title: 'CLI Entrypoint',        done: true,  active: false },
      { faz: 'FAZ 3', title: 'Policy Kernel (Rust)',  done: true,  active: false },
      { faz: 'FAZ 4', title: 'Execution Gate (Rust)', done: true,  active: false },
      { faz: 'FAZ 5', title: 'Domain Adapter',        done: true,  active: false },
      { faz: 'FAZ 6', title: 'Dashboard',             done: true,  active: true  },
      { faz: 'FAZ 7', title: 'ADAPTERv1',             done: false, active: true  },
    ],
    issues: [],
    mcp: { configured: !!MCP_URL, url: MCP_URL || null },
  })
})

// /api/apply — dashboard'dan gelen patch değerlendirme
app.post('/api/apply', authMiddleware, tierGuard(), async (req, res) => {
  const patch = req.body as PatchInput

  if (!patch || typeof patch !== 'object') {
    return res.status(400).json({ error: 'Invalid patch body' })
  }

  const start = Date.now()

  // evaluatePatch artık async — execSync yok, event loop bloklanmaz
  const { verdict, policy, reason, token } = await evaluatePatch(patch, JWT_SECRET)

  const decision: Decision = {
    id:          `dec-${uuid().replace(/-/g, '').slice(0, 7)}`,
    action:      patch.action      ?? 'EXECUTE_ACTION',
    criticality: patch.criticality ?? 'MEDIUM',
    verdict,
    policy,
    reason,
    token,
    time:        new Date().toLocaleTimeString('tr-TR'),
    latency:     `${Date.now() - start}ms`,
  }

  addDecision(decision)
  broadcast({ type: 'decision', decision })

  // Yanıtı önce gönder — kullanıcı beklemez
  res.json(decision)

  // Supabase audit logu — fire-and-forget, hata sistemi durdurmaz
  // ⚠️ Insert başarısız olursa karar loglanmadan geçer — monitoring gerekir
  const userId = (req as any).user?.id
  if (userId) {
    supabase.from('decisions').insert({
      user_id:         userId,
      decision_object: decision,
      status:          verdict === 'PERMIT' ? 'approved'
                     : verdict === 'DENY'   ? 'rejected'
                     : 'pending',
      risk_score:      calcRiskScore(patch.criticality),
      policy_verdict:  verdict,
      trace_id:        decision.id,
    }).then(({ error }) => {
      if (error) console.error('[apply] Supabase insert error:', error.message)
    })
  }
})

// ─── MCP ROUTE'LAR ───────────────────────────────────────────

app.get('/mcp/status', authMiddleware, async (_req, res) => {
  const result = await mcpProxy('/status')
  res.json(result)
})

app.post('/mcp/sync', authMiddleware, async (req, res) => {
  const result = await mcpProxy('/sync', req.body)
  res.json(result)
})

app.post('/mcp/query', authMiddleware, async (req, res) => {
  if (!req.body?.question) {
    return res.status(400).json({ error: 'question field required' })
  }
  const result = await mcpProxy('/query', req.body)
  res.json(result)
})

// ─── ROUTER'LAR ──────────────────────────────────────────────

app.use('/memory',      authMiddleware, tierGuard(), memoryRouter)
app.use('/github',      authMiddleware, githubRouter)
app.use('/admin',       adminRouter)
app.use('/api/billing', dodoRouter)
app.use('/api/ai',      authMiddleware, aiProxy)
app.use('/api/project', projectRouter)
app.use('/api/user',    userRouter)

// ─── WEBSOCKET ───────────────────────────────────────────────

const server = http.createServer(app)
const wss    = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.send(JSON.stringify({ type: 'init', decisions: decisionStore } satisfies WsMessage))

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string }
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'ping' }))
    } catch (err) {
      console.error('[WS] Malformed message:', err instanceof Error ? err.message : String(err))
    }
  })

  ws.on('close', () => clients.delete(ws))
  ws.on('error', (err) => console.error('[WS] Error:', err.message))
})

// ─── SUNUCU BAŞLATMA ─────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Sovereign Engine] :${PORT}`)
  console.log(`[Sovereign Engine] Origins: ${ALLOWED_ORIGINS.join(', ')}`)
  console.log(`[Sovereign Engine] MCP_URL: ${MCP_URL || 'not configured'}`)

  // Restart öncesi açık kalan session'ları dirty işaretle (Session 11)
  await markOrphanSessions()

  // Proje cache'lerini ön yükle (Session 6)
  await preloadProjectCache()
})

// ─── RAILWAY KEEP-ALIVE ──────────────────────────────────────
// Railway idle shutdown'ı önlemek için periyodik self-ping.

setInterval(() => {
  http.get(`http://localhost:${PORT}/health`, (res) => {
    if (res.statusCode === 200) {
      console.log('[Keep-Alive] Ping başarılı:', new Date().toLocaleTimeString())
    }
  }).on('error', (err) => {
    console.error('[Keep-Alive] Ping hatası:', err.message)
  })
}, 10 * 60 * 1000)
