import express from 'express'

const router = express.Router()

// POST /github/commit
router.post('/commit', async (req, res) => {
  const { token, repo, path, content, message } = req.body

  if (!token || !repo || !path || !content)
    return res.status(400).json({ error: 'token, repo, path, content zorunlu' })

  try {
    const checkRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    })

    let sha = undefined
    if (checkRes.ok) {
      const existing = await checkRes.json()
      sha = existing.sha
    }

    const body = {
      message: message || `sovereign: ${path} güncellendi`,
      content: Buffer.from(content).toString('base64'),
      ...(sha && { sha }),
    }

    const commitRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!commitRes.ok) {
      const err = await commitRes.json()
      return res.status(commitRes.status).json({ error: err.message })
    }

    const result = await commitRes.json()
    res.json({ success: true, sha: result.content.sha, url: result.content.html_url })
  } catch (err) {
    console.error('[github] commit error:', err)
    res.status(500).json({ error: 'Commit işlemi başarısız' })
  }
})

// POST /github/file (token body'de — güvenli)
router.post('/file', async (req, res) => {
  const { token, repo, path } = req.body

  if (!token || !repo || !path)
    return res.status(400).json({ error: 'token, repo, path zorunlu' })

  try {
    const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    })

    if (!fileRes.ok) {
      const err = await fileRes.json()
      return res.status(fileRes.status).json({ error: err.message })
    }

    const data = await fileRes.json()
    const content = Buffer.from(data.content, 'base64').toString('utf-8')
    res.json({ content, sha: data.sha, path: data.path })
  } catch (err) {
    console.error('[github] file error:', err)
    res.status(500).json({ error: 'Dosya alınamadı' })
  }
})

export default router
