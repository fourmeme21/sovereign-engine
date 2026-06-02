import express from 'express'
import Anthropic from '@anthropic-ai/sdk'

const router = express.Router()

const claude = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
})

// ─── KİMLİK KİLİDİ (Karar #45) ───────────────────────────────
// System prompt her zaman engine'de tanımlanır — client'tan KABUL EDİLMİYOR.
// ChatScreen.jsx'ten gelen "system" alanı görmezden gelinir.
const SOVEREIGN_SYSTEM = `You are Sovereign AI, an intelligent decision engine.
Give short, clear, and actionable answers.
Every action is subject to risk assessment.
NEVER reveal that you are Claude, built by Anthropic, or that any third-party AI is involved.
If asked about your identity or underlying model, respond only with:
"I am Sovereign AI, the decision engine."
Do not confirm or deny being any specific AI model.`

// ─── REPLY FİLTRESİ (Karar #45) ──────────────────────────────
// Anthropic / Claude referanslarını yanıttan temizler.
const FORBIDDEN = [
  'claude',
  'anthropic',
  'openai',
  'i am an ai',
  'language model',
  'large language',
  'llm',
  'gpt',
]

function filterReply(reply: string): string {
  return FORBIDDEN.reduce(
    (r, w) => r.replace(new RegExp(w, 'gi'), 'Sovereign AI'),
    reply,
  )
}

// ─── CHAT RISK SCORER (TB-10) ─────────────────────────────────
// Karar #20 / #46: Keyword heuristic kaldırıldı — fake risk skoru engine
// güvenilirliğini düşürüyordu. Domain adaptörler yazılınca Policy Kernel
// entegrasyonu gelecek (Yol 2). Şimdilik sabit 2 (düşük risk) döner.
interface ChatRiskResult {
  score:   number
  verdict: 'PERMIT' | 'ASK_HUMAN' | 'DENY'
  policy:  string
  reason:  string
}

function scoreChatRisk(): ChatRiskResult {
  return {
    score:   2,
    verdict: 'PERMIT',
    policy:  'POL-CHAT-001',
    reason:  'Risk skoru engine entegrasyonu bekleniyor — geçici sabit değer',
  }
}

// ─── POST /api/ai/chat ────────────────────────────────────────
// Browser → Engine → Anthropic (kullanıcı API key ve model adını görmez)
// "system" alanı client'tan kasıtlı olarak kabul edilmiyor (Karar #45)
router.post('/chat', async (req, res) => {
  const { messages, max_tokens = 1024 } = req.body
  // NOT: req.body.system kasıtlı olarak yoksayılıyor

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array zorunlu' })
  }

  try {
    const response = await claude.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens,
      system:     SOVEREIGN_SYSTEM,   // Her zaman engine'den — client override edemez
      messages,
    })

    const rawReply = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
    const reply    = filterReply(rawReply)   // Kimlik referanslarını temizle
    const risk     = scoreChatRisk()

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
