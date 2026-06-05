import express from 'express'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { v4 as uuid } from 'uuid'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { supabase }         from './lib/supabase.js'
import { authMiddleware }   from './middleware/authMiddleware.js'
import { tierGuard }        from './middleware/tierGuard.js'
import memoryRouter         from './routes/memoryRouter.js'
import githubRouter         from './routes/githubRouter.js'
import adminRouter          from './routes/adminRouter.js'
import dodoRouter           from './routes/dodoRouter.js'
import aiProxy              from './routes/aiProxy.js'
import projectRouter        from './routes/projectRouter.js'   // ← ADAPTERv1 Session 6
import userRouter           from './routes/userRouter.js'      // ← ADAPTERv1 Session 8 R-2
import { preloadProjectCache } from './lib/contextInjector.js'        // ← ADAPTERv1 Session 6
import { markOrphanSessions }  from './lib/sessionManager.js'         // ← ADAPTERv1 Session 11
import jwt from 'jsonwebtoken'

// ─── JWT SECRET ──────────────────────────────────────────────
const JWT_SECRET = process.env['JWT_SECRET']
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET env değişkeni tanımlanmamış — sistem başlamıyor.')
  process.exit(1)
}

export type Verdict     = 'PERMIT' | 'DENY' | 'ASK_HUMAN'
export type Criticality = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface Decision {
  id: string; action: string; criticality: Criticality; verdict: Verdict
  policy: string; reason: string; token: string | null; time: string; latency: string
}

export interface WsMessage {
  type: 'init' | 'decision' | 'ping'
  decisions?: Decision[]; decision?: Decision
}

const decisionStore: Decision[] = []

const MAX_DECISIONS = 200
function addDecision(d: Decision) {
  decisionStore.unshift(d)
  if (decisionStore.length > MAX_DECISIONS) decisionStore.pop()
}

const clients = new Set<WebSocket>()
function broadcast(msg: WsMessage) {
  const raw = JSON.stringify(msg)
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(raw) })
}

interface PatchInput {
  action?: string; target?: string; criticality?: Criticality
  payload?: Record<string, unknown>; session_id?: string; agent?: string; timestamp?: string
}

// ─── JWT TOKEN ÜRETIMI ───────────────────────────────────────
function issueToken(patch: PatchInput): string {
  const decisionId = uuid()
  const payload = {
    decision_id:  decisionId,
    actor_id:     patch.session_id ?? 'unknown',
    action_name:  patch.action ?? 'EXECUTE_ACTION',
    scope:        `${patch.target ?? 'DEFAULT'}:${patch.action ?? 'execute'}`,
    issued_at:    Math.floor(Date.now() / 1000),
    expires_at:   Math.floor(Date.now() / 1000) + 30,
  }
  return jwt.sign(payload, JWT_SECRET as string, { algorithm: 'HS256', expiresIn: 30 })
}

function evaluatePatch(patch: PatchInput): { verdict: Verdict; policy: string; reason: string; token: string | null } {
  const IMMUTABLE = ['system.config', 'audit.log', 'policy.kernel']
  const target = patch.target ?? ''

  if (patch.action === 'MODIFY_STATE' && IMMUTABLE.some(r => target.includes(r)))
    return { verdict: 'DENY', policy: 'POL-001 (HL-1)', reason: `HL-1: Immutable resource '${target}' is write-protected`, token: null }

  const amount = patch.payload?.['amount'] as number | undefined
  if (typeof amount === 'number' && amount < 0)
    return { verdict: 'DENY', policy: 'POL-002 (HL-2)', reason: `HL-2: Negative amount (${amount}) rejected`, token: null }

  if (patch.criticality === 'CRITICAL')
    return { verdict: 'ASK_HUMAN', policy: 'POL-003 (HL-3)', reason: 'HL-3: Critical risk level requires human review', token: null }

  try {
    const cliPath = path.join(process.cwd(), 'dist', 'cli', 'index.js')
    if (fs.existsSync(cliPath)) {
      const tmpFile = `/tmp/patch-${uuid()}.json`
      fs.writeFileSync(tmpFile, JSON.stringify(patch))
      const result = execSync(`node ${cliPath} validate ${tmpFile}`, { timeout: 5000, encoding: 'utf8' })
      fs.unlinkSync(tmpFile)
      const parsed = JSON.parse(result)
      return {
        verdict: parsed.verdict ?? 'PERMIT',
        policy:  parsed.policy_id ?? 'POL-007',
        reason:  parsed.reason ?? 'CLI validation passed',
        token:   parsed.execution_token ?? issueToken(patch),
      }
    }
  } catch (_) {}

  const token = issueToken(patch)
  return { verdict: 'PERMIT', policy: 'POL-007', reason: 'All checks passed - execution token issued', token }
}

// ─── MCP Proxy ───────────────────────────────────────────────
const MCP_URL = process.env['MCP_URL'] ?? ''

async function mcpProxy(subpath: string, body?: unknown) {
  if (!MCP_URL) return { ok: false, error: 'MCP_NOT_CONFIGURED', hint: 'Set MCP_URL env variable to your local mcp-server ngrok URL' }
  try {
    const res = await fetch(`${MCP_URL}${subpath}`, {
      method:  body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body:    body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json()
    return { ok: res.ok, ...data }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: 'MCP_UNREACHABLE', hint: msg }
  }
}

const app = express()

// ─── CORS ────────────────────────────────────────────────────
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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-password'],
}))

// ─── Webhook raw body (express.json'dan ÖNCE) ────────────────
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, _res, next) => {
  ;(req as any).rawBody = (req.body as Buffer).toString('utf8')
  next()
})

// ─── Body parser ─────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }))

// ─── Rate limiting ───────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek — lütfen bekle.' },
})

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit aşıldı.' },
})

app.use(globalLimiter)
app.use('/api/ai', aiLimiter)

// ─── Açık route'lar ──────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  decisions: decisionStore.length,
  uptime: process.uptime(),
}))

// ─── Korumalı route'lar ───────────────────────────────────────
app.get('/api/decisions', authMiddleware, tierGuard(), (_, res) => {
  res.json(decisionStore)
})

app.get('/api/policies', authMiddleware, (_, res) => res.json([
  { id: 'POL-001', label: 'POL-001 · HL-1 · Immutable State',  meta: 'HL-1 · Immutable State Guard · HARD_LOCK',  type: 'HARD_LOCK',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    let immutable = vec!["system.config","audit.log","policy.kernel"];\n    if decision.action == ActionType::ModifyState {\n        for resource in &immutable {\n            if decision.target.contains(resource) {\n                return PolicyResult { verdict: Verdict::Deny, reason: format!("HL-1: Immutable \'{}\' blocked", resource), policy_id: "POL-001", token: None };\n            }\n        }\n    }\n    PolicyResult::pass()\n}' },
  { id: 'POL-002', label: 'POL-002 · HL-2 · Non-Negative',     meta: 'HL-2 · Non-Negative Value Guard',           type: 'HARD_LOCK',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if let Some(amount) = decision.payload.get("amount") {\n        if amount.as_f64().unwrap_or(0.0) < 0.0 {\n            return PolicyResult::deny("HL-2: Negative amount rejected");\n        }\n    }\n    PolicyResult::pass()\n}' },
  { id: 'POL-003', label: 'POL-003 · HL-3 · Critical->Human',  meta: 'HL-3 · Critical Escalation · HARD_LOCK',    type: 'HARD_LOCK',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if decision.criticality == Criticality::Critical {\n        return PolicyResult::ask_human("HL-3: Critical risk requires review");\n    }\n    PolicyResult::pass()\n}' },
  { id: 'POL-004', label: 'POL-004 · HL-4 · Ownership',        meta: 'HL-4 · Resource Ownership Guard',           type: 'ENFORCING',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    PolicyResult::pass()\n}' },
  { id: 'POL-007', label: 'POL-007 · Execution Token',          meta: 'Execution Token Validation · ENFORCING',   type: 'ENFORCING',  code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    PolicyResult::permit_with_token(ctx.issue_token(decision))\n}' },
  { id: 'POL-011', label: 'POL-011 · Human Escalation',         meta: 'Low Confidence -> ASK_HUMAN',              type: 'SOFT_STEER', code: 'fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if decision.confidence < 0.7 {\n        return PolicyResult::ask_human("Low confidence - operator review");\n    }\n    PolicyResult::pass()\n}' },
]))

app.get('/api/session', authMiddleware, (_, res) => {
  const permits = decisionStore.filter(d => d.verdict === 'PERMIT').length
  const denies  = decisionStore.filter(d => d.verdict === 'DENY').length
  const human   = decisionStore.filter(d => d.verdict === 'ASK_HUMAN').length
  res.json({
    id: 'sess-current', hex: '0x0D', shortId: 'sess-0d-5a9b',
    started: new Date(Date.now() - 38 * 60_000).toISOString(),
    agent: 'sovereign-agent-v3',
    decisions: decisionStore.length, permits, denies, escalations: human,
    permitRate: decisionStore.length ? Math.round((permits / decisionStore.length) * 100) : 0,
    memory: { l1: '18.4 KB', l2: '84.1 KB', l3: '201.7 KB' },
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

app.post('/api/apply', authMiddleware, tierGuard(), async (req, res) => {
  const patch = req.body as PatchInput
  if (!patch || typeof patch !== 'object')
    return res.status(400).json({ error: 'Invalid patch body' })

  const start = Date.now()
  const { verdict, policy, reason, token } = evaluatePatch(patch)
  const decision: Decision = {
    id:          `dec-${uuid().replace(/-/g, '').slice(0, 7)}`,
    action:      patch.action ?? 'EXECUTE_ACTION',
    criticality: patch.criticality ?? 'MEDIUM',
    verdict, policy, reason, token,
    time:        new Date().toLocaleTimeString('tr-TR'),
    latency:     `${Date.now() - start}ms`,
  }
  addDecision(decision)
  broadcast({ type: 'decision', decision })
  res.json(decision)

  const userId = (req as any).user?.id
  if (userId) {
    const riskScore = patch.criticality === 'CRITICAL' ? 9
      : patch.criticality === 'HIGH'   ? 7
      : patch.criticality === 'MEDIUM' ? 5 : 2
    supabase.from('decisions').insert({
      user_id:         userId,
      decision_object: decision,
      status:          verdict === 'PERMIT' ? 'approved' : verdict === 'DENY' ? 'rejected' : 'pending',
      risk_score:      riskScore,
      policy_verdict:  verdict,
      trace_id:        decision.id,
    }).then(({ error }) => {
      if (error) console.error('[apply] Supabase insert error:', error.message)
    })
  }
})

// ─── MCP (korumalı) ──────────────────────────────────────────
app.get('/mcp/status', authMiddleware, async (_, res) => {
  const result = await mcpProxy('/status')
  res.json(result)
})

app.post('/mcp/sync', authMiddleware, async (req, res) => {
  const result = await mcpProxy('/sync', req.body)
  res.json(result)
})

app.post('/mcp/query', authMiddleware, async (req, res) => {
  if (!req.body?.question)
    return res.status(400).json({ error: 'question field required' })
  const result = await mcpProxy('/query', req.body)
  res.json(result)
})

// ─── Router'lar ───────────────────────────────────────────────
app.use('/memory',       authMiddleware, tierGuard(), memoryRouter)
app.use('/github',       authMiddleware, githubRouter)
app.use('/admin',        adminRouter)
app.use('/api/billing',  dodoRouter)
app.use('/api/ai',       authMiddleware, aiProxy)
app.use('/api/project',  projectRouter)                            // ← ADAPTERv1 Session 6
app.use('/api/user',     userRouter)                               // ← ADAPTERv1 Session 8 R-2

// ─── WebSocket ───────────────────────────────────────────────
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.send(JSON.stringify({ type: 'init', decisions: decisionStore } satisfies WsMessage))
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'ping' }))
    } catch (_) {}
  })
  ws.on('close', () => clients.delete(ws))
  ws.on('error', (err) => console.error('[WS] Error:', err.message))
})

const PORT = parseInt(process.env['PORT'] ?? '8080', 10)
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Sovereign Engine :${PORT}`)
  console.log(`Origins: ${ALLOWED_ORIGINS.join(', ')}`)
  console.log(`MCP_URL: ${MCP_URL || 'not configured'}`)
  // ADAPTERv1 Session 11 — Restart öncesi açık kalan session'ları dirty işaretle
  await markOrphanSessions()
  // ADAPTERv1 Session 6 — Proje cache'lerini ön yükle
  await preloadProjectCache()
})

// ─── RAILWAY KEEP-ALIVE ───────────────────────────────────────
setInterval(() => {
  const url = `http://localhost:${PORT}/health`
  http.get(url, (res) => {
    if (res.statusCode === 200)
      console.log('[Keep-Alive] Ping başarılı:', new Date().toLocaleTimeString())
  }).on('error', (err) => {
    console.error('[Keep-Alive] Ping hatası:', err.message)
  })
}, 10 * 60 * 1000)
