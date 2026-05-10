/**
 * SOVEREIGN ENGINE OS — Local MCP Bridge
 * ----------------------------------------
 * Bu server local makinede çalışır.
 * notebooklm-mcp ile konuşur, Railway Engine'e HTTP API sunar.
 *
 * Başlatma:
 *   cd mcp-server && npm install && npm start
 *
 * Sonra ngrok ile dışarı aç:
 *   ngrok http 3001
 *   → ngrok URL'yi Railway'de MCP_URL env variable olarak ayarla
 */

import express from 'express'
import cors from 'cors'
import { execSync, spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

// ─── Ayarlar ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['MCP_BRIDGE_PORT'] ?? '3001', 10)

// SE OS proje kökü — kendi dizin yapına göre güncelle
const SE_OS_ROOT = process.env['SE_OS_ROOT'] ?? path.join(process.cwd(), '..')

// NotebookLM'e yüklenecek belgeler
const SYNC_FILES = [
  'CORE.md',
  'ARCHITECTURE.md',
  'session_index.md',
  'session_log_hot.md',
  'failure_patterns.md',
  'AI_AGENT.md',
]

// Notebook adı
const NOTEBOOK_NAME = process.env['NOTEBOOK_NAME'] ?? 'Sovereign Engine OS'

// ─── Yardımcı Fonksiyonlar ────────────────────────────────────────────────────

function nlm(args: string[]): { ok: boolean; output: string; error?: string } {
  try {
    const output = execSync(`npx notebooklm-mcp@latest ${args.join(' ')}`, {
      timeout: 30_000,
      encoding: 'utf8',
      env: { ...process.env },
    })
    return { ok: true, output: output.trim() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, output: '', error: msg }
  }
}

function getNotebookId(): string | null {
  const result = nlm(['notebook', 'list', '--json'])
  if (!result.ok) return null
  try {
    const notebooks = JSON.parse(result.output) as Array<{ id: string; title: string }>
    const found = notebooks.find(n => n.title === NOTEBOOK_NAME)
    return found?.id ?? null
  } catch {
    return null
  }
}

function ensureNotebook(): { id: string; created: boolean } | null {
  let id = getNotebookId()
  if (id) return { id, created: false }

  const result = nlm(['notebook', 'create', `"${NOTEBOOK_NAME}"`, '--json'])
  if (!result.ok) return null

  try {
    const parsed = JSON.parse(result.output) as { id: string }
    return { id: parsed.id, created: true }
  } catch {
    return null
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json())

// GET /status — MCP server ve notebooklm-mcp sağlık kontrolü
app.get('/status', (_, res) => {
  const check = nlm(['--version'])
  const notebookId = getNotebookId()
  res.json({
    ok: check.ok,
    notebooklm_mcp: check.ok ? 'connected' : 'not_found',
    notebook: notebookId ? { id: notebookId, name: NOTEBOOK_NAME } : null,
    se_os_root: SE_OS_ROOT,
    mcp_bridge_version: '1.0.0',
  })
})

// POST /sync — SE OS belgelerini NotebookLM'e yükle
// Body: { files?: string[] }
app.post('/sync', async (req, res) => {
  const requestedFiles = (req.body as { files?: string[] }).files ?? SYNC_FILES
  const notebook = ensureNotebook()

  if (!notebook) {
    return res.status(500).json({ ok: false, error: 'Notebook oluşturulamadı — notebooklm-mcp auth kontrol et' })
  }

  const results: Array<{ file: string; ok: boolean; error?: string }> = []

  for (const filename of requestedFiles) {
    const filePath = path.join(SE_OS_ROOT, filename)

    if (!fs.existsSync(filePath)) {
      results.push({ file: filename, ok: false, error: 'Dosya bulunamadı' })
      continue
    }

    const result = nlm([
      'source', 'add', notebook.id,
      '--file', `"${filePath}"`,
      '--title', `"${filename}"`,
    ])

    results.push({ file: filename, ok: result.ok, error: result.error })
  }

  const successCount = results.filter(r => r.ok).length
  res.json({
    ok: successCount > 0,
    notebook: { id: notebook.id, name: NOTEBOOK_NAME, created: notebook.created },
    synced: successCount,
    total: requestedFiles.length,
    results,
    timestamp: new Date().toISOString(),
  })
})

// POST /query — NotebookLM'e soru sor
// Body: { question: string }
app.post('/query', async (req, res) => {
  const { question } = req.body as { question?: string }

  if (!question) {
    return res.status(400).json({ ok: false, error: 'question field required' })
  }

  const notebookId = getNotebookId()
  if (!notebookId) {
    return res.status(404).json({ ok: false, error: `"${NOTEBOOK_NAME}" notebook bulunamadı — önce /sync çalıştır` })
  }

  const result = nlm(['query', notebookId, `"${question}"`, '--json'])

  if (!result.ok) {
    return res.status(500).json({ ok: false, error: result.error })
  }

  try {
    const parsed = JSON.parse(result.output)
    res.json({ ok: true, question, ...parsed })
  } catch {
    // JSON değilse düz metin olarak döndür
    res.json({ ok: true, question, answer: result.output })
  }
})

// ─── Başlat ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ MCP Bridge :${PORT}`)
  console.log(`📁 SE_OS_ROOT: ${SE_OS_ROOT}`)
  console.log(`📓 Notebook: ${NOTEBOOK_NAME}`)
  console.log(``)
  console.log(`Sonraki adım:`)
  console.log(`  ngrok http ${PORT}`)
  console.log(`  → ngrok URL'yi Railway'de MCP_URL olarak ayarla`)
})
