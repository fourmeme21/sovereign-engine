import express from 'express'
import Anthropic from '@anthropic-ai/sdk'

const router = express.Router()

const claude = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
})

// ─── CHAT RISK SCORER ────────────────────────────────────────
// TB-3 / Karar #20: Keyword heuristic kaldırıldı — fake risk skoru engine
// güvenilirliğini düşürüyordu. Gerçek skor engine'den gelecek (Phase G sonrası).
// Şimdilik sabit 2 (düşük risk) döner.
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
