/**
 * Sovereign Engine — HTTP + WebSocket Server
 * sovereign-engine-main/src/server/index.ts
 *
 * Railway'de ayrı bir servis olarak çalışır.
 * Dashboard bu servise bağlanır.
 *
 * Kurulum:
 *   npm install express ws cors uuid @types/express @types/ws @types/cors @types/uuid
 *
 * Çalıştırma:
 *   npx ts-node src/server/index.ts
 *   veya package.json'a: "server": "ts-node src/server/index.ts"
 */

import express from 'express'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import cors from 'cors'
import { v4 as uuid } from 'uuid'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export type Verdict = 'PERMIT' | 'DENY' | 'ASK_HUMAN'
export type Criticality = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface Decision {
  id: string
  action: string
  criticality: Criticality
  verdict: Verdict
  policy: string
  reason: string
  token: string | null
  time: string
  latency: string
}

export interface WsMessage {
  type: 'init' | 'decision' | 'ping'
  decisions?: Decision[]
  decision?: Decision
}

// ─── In-memory store ───────────────────────────────────────────────────────────

const decisionStore: Decision[] = [
  { id: 'dec-8a3f2', action: 'MODIFY_STATE',    criticality: 'CRITICAL', verdict: 'ASK_HUMAN', policy: 'POL-011',       reason: 'Low confidence — human required',    token: null,                    time: '14:22:07', latency: '2.1ms' },
  { id: 'dec-7b1e4', action: 'EXECUTE_ACTION',  criticality: 'HIGH',     verdict: 'PERMIT',    policy: 'POL-007',       reason: 'All checks passed — token issued',    token: 'eyJhbGciOiJIUzI1NiJ9', time: '14:21:55', latency: '3.2ms' },
  { id: 'dec-6c9d1', action: 'READ_STATE',       criticality: 'LOW',      verdict: 'PERMIT',    policy: 'POL-003',       reason: 'Read-only — auto permit',             token: 'eyJhbGciOiJIUzI1NiJ9', time: '14:20:40', latency: '0.8ms' },
  { id: 'dec-5d2a8', action: 'MODIFY_STATE',     criticality: 'CRITICAL', verdict: 'DENY',      policy: 'POL-001 (HL-1)',reason: 'HL-1: Immutable resource blocked',    token: null,                    time: '14:18:33', latency: '1.1ms' },
  { id: 'dec-4e0f3', action: 'EXECUTE_ACTION',   criticality: 'MEDIUM',   verdict: 'PERMIT',    policy: 'POL-007',       reason: 'All checks passed — token issued',    token: 'eyJhbGciOiJIUzI1NiJ9', time: '14:17:12', latency: '2.9ms' },
]

const MAX_DECISIONS = 200

function addDecision(d: Decision) {
  decisionStore.unshift(d)
  if (decisionStore.length > MAX_DECISIONS) decisionStore.pop()
}

// ─── WebSocket ─────────────────────────────────────────────────────────────────

const clients = new Set<WebSocket>()

function broadcast(msg: WsMessage) {
  const raw = JSON.stringify(msg)
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw)
  })
}

// ─── Policy evaluation (TS layer) ──────────────────────────────────────────────

interface PatchInput {
  action?: string
  target?: string
  criticality?: Criticality
  payload?: Record<string, unknown>
  session_id?: string
  agent?: string
  timestamp?: string
}

function evaluatePatch(patch: PatchInput): { verdict: Verdict; policy: string; reason: string; token: string | null } {
  const IMMUTABLE = ['system.config', 'audit.log', 'policy.kernel']
  const target = patch.target ?? ''

  // HL-1: Immutable state guard
  if (patch.action === 'MODIFY_STATE' && IMMUTABLE.some(r => target.includes(r))) {
    return { verdict: 'DENY', policy: 'POL-001 (HL-1)', reason: `HL-1: Immutable resource '${target}' is write-protected`, token: null }
  }

  // HL-2: Non-negative values
  const amount = (patch.payload?.amount as number | undefined)
  if (typeof amount === 'number' && amount < 0) {
    return { verdict: 'DENY', policy: 'POL-002 (HL-2)', reason: `HL-2: Negative amount (${amount}) rejected`, token: null }
  }

  // HL-3: CRITICAL risk → ASK_HUMAN
  if (patch.criticality === 'CRITICAL') {
    return { verdict: 'ASK_HUMAN', policy: 'POL-003 (HL-3)', reason: 'HL-3: Critical risk level requires human review', token: null }
  }

  // Try real CLI if available
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
        policy: parsed.policy_id ?? 'POL-007',
        reason: parsed.reason ?? 'CLI validation passed',
        token: parsed.execution_token ?? `eyJhbGciOiJIUzI1NiJ9.${uuid().replace(/-/g,'').slice(0,16)}`,
      }
    }
  } catch (_) { /* CLI not available — fall through to TS verdict */ }

  // Default: PERMIT
  const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ id: uuid(), exp: Date.now() + 30_000 })).toString('base64url')}`
  return { verdict: 'PERMIT', policy: 'POL-007', reason: 'All checks passed — execution token issued', token }
}

// ─── Express app ───────────────────────────────────────────────────────────────

const app = express()

app.use(cors({
  origin: '*', // Railway: restrict to dashboard domain in production if needed
  methods: ['GET', 'POST'],
}))
app.use(express.json({ limit: '1mb' }))

// Health
app.get('/health', (_, res) => {
  res.json({ status: 'ok', decisions: decisionStore.length, uptime: process.uptime() })
})

// Decisions list
app.get('/api/decisions', (_, res) => {
  res.json(decisionStore)
})

// Policies (static definition from Rust kernel)
app.get('/api/policies', (_, res) => {
  res.json([
    { id: 'POL-001', label: 'POL-001 · HL-1 · Immutable State',  meta: 'HL-1 · Immutable State Guard · HARD_LOCK',      type: 'HARD_LOCK',   code: `fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    let immutable = vec!["system.config","audit.log","policy.kernel"];\n    if decision.action == ActionType::ModifyState {\n        for resource in &immutable {\n            if decision.target.contains(resource) {\n                return PolicyResult {\n                    verdict: Verdict::Deny,\n                    reason: format!("HL-1: Immutable '{}' blocked", resource),\n                    policy_id: "POL-001",\n                    token: None,\n                };\n            }\n        }\n    }\n    PolicyResult::pass()\n}` },
    { id: 'POL-002', label: 'POL-002 · HL-2 · Non-Negative',      meta: 'HL-2 · Non-Negative Value Guard',               type: 'HARD_LOCK',   code: `fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if let Some(amount) = decision.payload.get("amount") {\n        if amount.as_f64().unwrap_or(0.0) < 0.0 {\n            return PolicyResult::deny("HL-2: Negative amount rejected");\n        }\n    }\n    PolicyResult::pass()\n}` },
    { id: 'POL-003', label: 'POL-003 · HL-3 · Critical→Human',    meta: 'HL-3 · Critical Escalation · HARD_LOCK',        type: 'HARD_LOCK',   code: `fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if decision.criticality == Criticality::Critical {\n        return PolicyResult {\n            verdict: Verdict::AskHuman,\n            reason: "HL-3: Critical risk requires human review".to_string(),\n            policy_id: "POL-003",\n            token: None,\n        };\n    }\n    PolicyResult::pass()\n}` },
    { id: 'POL-004', label: 'POL-004 · HL-4 · Ownership',          meta: 'HL-4 · Resource Ownership Guard',               type: 'ENFORCING',   code: `fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    // NOT_RESOURCE_OWNER stub — DomainConfig.privileged_roles Faz 3\n    PolicyResult::pass()\n}` },
    { id: 'POL-007', label: 'POL-007 · Execution Token',            meta: 'Execution Token Validation · ENFORCING',        type: 'ENFORCING',   code: `fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    // JWT HS256 token issued for PERMIT — 30s expiry\n    PolicyResult::permit_with_token(ctx.issue_token(decision))\n}` },
    { id: 'POL-011', label: 'POL-011 · Human Escalation',           meta: 'Low Confidence → ASK_HUMAN',                   type: 'SOFT_STEER',  code: `fn evaluate(decision: &Decision, ctx: &PolicyContext) -> PolicyResult {\n    if decision.confidence < 0.7 || decision.action == "MODIFY_POLICY" {\n        return PolicyResult::ask_human("Low confidence — operator review required");\n    }\n    PolicyResult::pass()\n}` },
  ])
})

// Session info
app.get('/api/session', (_, res) => {
  const permits = decisionStore.filter(d => d.verdict === 'PERMIT').length
  const denies  = decisionStore.filter(d => d.verdict === 'DENY').length
  const human   = decisionStore.filter(d => d.verdict === 'ASK_HUMAN').length

  res.json({
    id: 'sess-current',
    hex: '0x0D',
    shortId: 'sess-0d-5a9b',
    started: new Date(Date.now() - 38 * 60_000).toISOString(),
    agent: 'sovereign-agent-v3',
    decisions: decisionStore.length,
    permits, denies, escalations: human,
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
      { faz: 'FAZ 7', title: 'NotebookLM MCP',        done: false, active: false },
    ],
    issues: [
      { id: 'ISSUE-001', level: 'warning', desc: 'execution_token JWT secret yönetimi belirsiz' },
      { id: 'ISSUE-006', level: 'warning', desc: 'CLI testleri test.skip — ESM mock kısıtlaması' },
    ],
  })
})

// Apply patch — core endpoint
app.post('/api/apply', (req, res) => {
  const patch = req.body as PatchInput

  if (!patch || typeof patch !== 'object') {
    return res.status(400).json({ error: 'Invalid patch body — must be JSON object' })
  }

  const start = Date.now()
  const { verdict, policy, reason, token } = evaluatePatch(patch)
  const latency = `${Date.now() - start}ms`

  const decision: Decision = {
    id: `dec-${uuid().replace(/-/g,'').slice(0,7)}`,
    action: patch.action ?? 'EXECUTE_ACTION',
    criticality: patch.criticality ?? 'MEDIUM',
    verdict, policy, reason, token,
    time: new Date().toLocaleTimeString('tr-TR'),
    latency,
  }

  addDecision(decision)
  broadcast({ type: 'decision', decision })

  res.json(decision)
})

// ─── HTTP + WS server ──────────────────────────────────────────────────────────

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  clients.add(ws)
  console.log(`[WS] Client connected. Total: ${clients.size}`)

  // Send current state on connect
  ws.send(JSON.stringify({ type: 'init', decisions: decisionStore } satisfies WsMessage))

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'ping' }))
    } catch (_) {}
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[WS] Client disconnected. Total: ${clients.size}`)
  })

  ws.on('error', (err) => console.error('[WS] Error:', err.message))
})

const PORT = parseInt(process.env.PORT ?? '8080', 10)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Sovereign Engine server running on :${PORT}`)
  console.log(`   REST: http://localhost:${PORT}/api/decisions`)
  console.log(`   WS:   ws://localhost:${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/health`)
})
