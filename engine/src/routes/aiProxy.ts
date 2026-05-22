import express from 'express'
import Anthropic from '@anthropic-ai/sdk'

const router = express.Router()

const claude = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
})

// POST /api/ai/chat
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
    res.json(response)
  } catch (err: any) {
    console.error('[aiProxy] Anthropic error:', err.message)
    res.status(500).json({ error: 'AI isteği başarısız' })
  }
})

export default router
