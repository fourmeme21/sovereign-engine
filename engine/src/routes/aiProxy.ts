import express from 'express'
import Anthropic from '@anthropic-ai/sdk'

const router = express.Router()

const claude = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
})

// ─── CHAT RISK SCORER ────────────────────────────────────────
interface ChatRiskResult {
  score:   number
  verdict: 'PERMIT' | 'ASK_HUMAN' | 'DENY'
  policy:  string
  reason:  string
}

function scoreChatRisk(userMessage: string, assistantReply: string): ChatRiskResult {
  const msg   = userMessage.toLowerCase()
  const reply = assistantReply.toLowerCase()
  let score   = 1
  let reason  = 'Normal sohbet — düşük risk'

  const CRITICAL = [
    'rm -rf', 'drop table', 'truncate', 'delete from',
    'wipe', 'format', 'destroy', 'remove all',
  ]
  const HIGH = [
    'deploy', 'production', 'migrate', 'schema change',
    'secret', 'api key', 'password', 'auth token', 'payment',
  ]
  const MEDIUM = [
    'modify', 'update', 'alter', 'config',
    'environment', 'setting', 'permission',
  ]

  for (const kw of CRITICAL) {
    if (msg.includes(kw) || reply.includes(kw)) {
      score  = Math.max(score, 9)
      reason = `Kritik işlem tespit edildi: "${kw}"`
      break
    }
  }

  for (const kw of HIGH) {
    if (msg.includes(kw)) {
      score  = Math.max(score, 6)
      reason = `Yüksek riskli alan: "${kw}"`
    }
  }

  for (const kw of MEDIUM) {
    if (msg.includes(kw)) {
      score = Math.max(score, 3)
    }
  }

  if (reply.includes('```')) {
    score = Math.min(10, score + 1)
  }

  let verdict: ChatRiskResult['verdict']
  let policy: string

  if (score >= 8) {
    verdict = 'DENY'
    policy  = 'POL-CHAT-003'
  } else if (score >= 5) {
    verdict = 'ASK_HUMAN'
    policy  = 'POL-CHAT-002'
  } else {
    verdict = 'PERMIT'
    policy  = 'POL-CHAT-001'
  }

  return { score, verdict, policy, reason }
}

// ─── POST /api/ai/chat ────────────────────────────────────────
// Browser → Engine → Anthropic (kullanıcı API key görmez)
router.post('/chat', async (req, res) => {
  const { messages, max_tokens = 1024, system } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array zorunlu' })
  }

  try {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: 'claude-sonnet-4-20250514',
      max_tokens,
      messages,
    }
    if (system) params.system = system

    const response = await claude.messages.create(params)
    const reply    = (response.content[0] as Anthropic.TextBlock)?.text ?? ''

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

export default router
