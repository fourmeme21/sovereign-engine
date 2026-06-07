/**
 * engine/src/lib/generationEngine.ts
 *
 * Generation Engine — ADAPTERv1 Session 7 (v1.1) → Session 18 (memory_chunks)
 *
 * Görev:
 *   Master plan + evrensel şablondan proje dökümanlarını Claude'a ürettirir.
 *   Token paketleme, sıralı üretim, her dosya sonrası Supabase recovery kaydı.
 *
 * Mimari (session_index.md → GENERATION ENGINE MİMARİSİ):
 *   1. /api/project/create → projectRouter → runGeneration() çağrılır (arka plan)
 *   2. ~20k token kapasitesi → dolunca yeni oturum + gerçek bağlam özeti enjeksiyonu
 *   3. Üretim sırası: CORE.md → AI_AGENT.md → ARCHITECTURE.md → ... → projeye özel
 *   4. Her dosya sonrası: project_generation_status güncellenir (Karar #26)
 *   5. CORE + AI_AGENT → user_projects.core_doc / ai_agent_doc (Karar #23)
 *   6. Tüm dosyalar tamam → gen_status = 'completed'
 *
 * v1.1 değişiklikleri (ChatGPT denetim raporu):
 *   KRİTİK-1: Gerçek context zinciri — her dosya sonrası Claude'a özet çıkartılır
 *   KRİTİK-4: Best Effort Mode — tek dosya hatasında süreç durmaz, devam eder
 *   KRİTİK-6: SESSION_TOKEN_CAPACITY 3k → 20k (Sonnet 4 context limiti 200k)
 *   KRİTİK-9: Cost tracking — her dosya için input/output token + maliyet loglanır
 *
 * Session 18:
 *   writeArchitectureMemory() — generation tamamlanınca memory_chunks'a yazar
 *
 * Karar #91 (Session 22):
 *   Dosya döngüsünde kümülatif token sayacı — CONTEXT_REFRESH_THRESHOLD (50k)
 *   aşılınca system prompt yenilenir, sayaç sıfırlanır.
 *
 * Kararlar:
 *   #19: "Adapter" = projeye özel eksiksiz yürütme dokümantasyonu
 *   #20: Evrensel şablon Seçenek B — dolu referans, Claude projeye özel yazar
 *   #21: Master plan formatı serbest
 *   #23: CORE + AI_AGENT → Supabase (plain text şimdilik — TODO: AES-256)
 *   #26: Generation recovery — her dosya sonrası durum kaydedilir
 *   #31: Akıllı paketleme — 20k token kapasitesi, dolunca yeni oturum
 *   #91: Context yenileme — 50k kümülatif token eşiğinde system prompt yenilenir
 *
 * Dokunma: writeArchitectureMemory() kaldırılırsa TB-2 açılır.
 *          extractFileSummary() ve priorContext zincirine dokunma.
 *          packIntoSessions() SESSION_TOKEN_CAPACITY kilitledi — değiştirme.
 *          CONTEXT_REFRESH_THRESHOLD değeri Karar #91 ile kilitlendi.
 */

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase.js'

// ---------------------------------------------------------------------------
// SABİTLER
// ---------------------------------------------------------------------------

const SESSION_TOKEN_CAPACITY      = 20_000
const CHARS_PER_TOKEN             = 4.0
const MODEL                       = 'claude-sonnet-4-20250514'
const MAX_RETRIES                 = 2
const PRICE_INPUT_PER_M           = 3.0
const PRICE_OUTPUT_PER_M          = 15.0

// Karar #91: Kümülatif token eşiği — aşılınca system prompt yenilenir
const CONTEXT_REFRESH_THRESHOLD   = 50_000

// ---------------------------------------------------------------------------
// TİPLER
// ---------------------------------------------------------------------------

export interface GenerationOptions {
  projectId:       string
  userId:          string
  projectName:     string
  masterPlan:      string
  completedFiles?: string[]
  bestEffort?:     boolean
}

interface FileSpec {
  fileName:      string
  fileOrder:     number
  storageTarget: 'supabase' | 'local_warm' | 'local_hot'
  instruction:   string
}

interface GenerationSession {
  files:        FileSpec[]
  priorContext: string
}

interface FileCost {
  fileName:     string
  inputTokens:  number
  outputTokens: number
  costUsd:      number
}

export interface GenerationResult {
  success:        boolean
  status:         'completed' | 'partial_success' | 'failed'
  completedFiles: string[]
  failedFiles:    string[]
  totalCostUsd:   number
  fileCosts:      FileCost[]
  error?:         string
}

// ---------------------------------------------------------------------------
// EVRENSEL DOSYA PLANI
// ---------------------------------------------------------------------------

const DEFAULT_FILE_PLAN: Omit<FileSpec, 'instruction'>[] = [
  { fileName: 'CORE.md',             fileOrder: 1,  storageTarget: 'supabase'   },
  { fileName: 'AI_AGENT.md',         fileOrder: 2,  storageTarget: 'supabase'   },
  { fileName: 'ARCHITECTURE.md',     fileOrder: 3,  storageTarget: 'local_warm' },
  { fileName: 'ROADMAP.md',          fileOrder: 4,  storageTarget: 'local_warm' },
  { fileName: 'TASK_CARDS.md',       fileOrder: 5,  storageTarget: 'local_warm' },
  { fileName: 'DEPENDENCIES.md',     fileOrder: 6,  storageTarget: 'local_warm' },
  { fileName: 'failure_patterns.md', fileOrder: 7,  storageTarget: 'local_warm' },
  { fileName: 'rollback.md',         fileOrder: 8,  storageTarget: 'local_warm' },
  { fileName: 'session_index.md',    fileOrder: 9,  storageTarget: 'local_hot'  },
  { fileName: 'session_log.md',      fileOrder: 10, storageTarget: 'local_hot'  },
]

// ---------------------------------------------------------------------------
// YARDIMCI: Token ve maliyet tahmini
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function calcCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens  / 1_000_000) * PRICE_INPUT_PER_M +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M
  )
}

// ---------------------------------------------------------------------------
// YARDIMCI: Dosyaya özel talimat
// ---------------------------------------------------------------------------

function getFileInstruction(fileName: string): string {
  const instructions: Record<string, string> = {
    'CORE.md': `
Bu dosya her AI session'ında okunacak birincil referanstır.
İçermeli:
  - Proje kimliği (isim, versiyon, stack)
  - Session açılış protokolü (sıra adımları)
  - Tetikleyici tablosu (görev türü → zorunlu dosyalar)
  - Dosya haritası
  - Değişmez sistem kuralları
  - Kilitli durumlar (IMMUTABLE_STATE)
  - Sağlık kontrol listesi
  - Session kapanış protokolü
  - Migration kayıt protokolü
Format: Markdown, başlıklar + tablolar + kod blokları.
Uzunluk: ~500-800 satır.
`.trim(),

    'AI_AGENT.md': `
Bu dosya AI ajanının davranış kurallarını tanımlar.
İçermeli:
  - Kimlik tanımı (sistemin amacı, temel üçlü)
  - Temel kurallar (tahmin etme, eksik veriyle çözüm üretme, vb.)
  - Çalışma akışı (numaralı adımlar)
  - KARAR BİLDİRİMİ formatı
  - SELF-CHECK kontrol listesi
  - Confidence kriterleri
  - PRE-FLIGHT READ
  - Output formatı
  - SELF-CORRECTION tablosu
  - Yasak liste
  - RE-INJECTION PROTOKOLÜ (her 20 mesajda bir)
Format: Markdown.
Uzunluk: ~300-500 satır.
`.trim(),

    'ARCHITECTURE.md': `
Sistemin veri modeli, servis kontratları ve katman sınırlarını tanımlar.
İçermeli:
  - Üst düzey mimari diyagramı
  - Her katmanın sorumluluğu ve sınırı
  - Temel veri modelleri
  - Servis kontratları
  - Bağımlılık yönü
  - Veritabanı şeması özeti
  - API endpoint listesi
`.trim(),

    'ROADMAP.md': `
Projenin inşa sırası ve faz kriterleri.
İçermeli:
  - Mevcut faz ve tamamlanma yüzdesi
  - Her faz için: giriş kriterleri, çıkış kriterleri, görevler
  - Bağımlılıklar, tahmini süre, riskler
`.trim(),

    'TASK_CARDS.md': `
Sıradaki görevlerin detaylı tanımı.
İçermeli:
  - Her görev için: ID, başlık, öncelik, bağımlılıklar, kabul kriterleri
  - Görev durumları: ⬜ bekliyor / 🟡 devam ediyor / ✅ tamamlandı
  - İlk 3 görev için adım adım uygulama talimatı
`.trim(),

    'DEPENDENCIES.md': `
Dosya ve servis bağımlılık haritası.
İçermeli:
  - Hangi dosya hangi servise bağımlı
  - Değişiklik etkisi matrisi
  - Dış bağımlılıklar
  - Kritik bağımlılıklar
`.trim(),

    'failure_patterns.md': `
Bilinen hata ve başarısızlık kalıpları ile çözümleri.
İçermeli:
  - Her pattern için: ID, isim, tetikleyiciler, belirtiler, çözüm adımları
  - Kritik hatalar, recovery prosedürleri, önleyici kontroller
`.trim(),

    'rollback.md': `
Kritik değişiklikler için geri dönüş adımları.
İçermeli:
  - Her değişiklik türü için rollback prosedürü
  - Veritabanı, servis, data rollback
  - Rollback kararı kriterleri
`.trim(),

    'session_index.md': `
Anlık proje durum pusulası — her session başında okunur.
İçermeli:
  - CURRENT FOCUS, son session özeti, genel durum tablosu
  - Proje tamamlanma analizi, sıradaki görevler
  - Referans dosyalar, açık sorular, korunanlar, session log
Format: Markdown tablolar. Uzunluk: ~100-200 satır.
`.trim(),

    'session_log.md': `
Boş başlangıç session log dosyası.
İçermeli:
  - Dosya başlığı ve açıklaması
  - İlk blok: Proje oluşturuldu, generation tamamlandı bilgisi
  - CORE.md'deki Session Log Blok Formatı'na uygun tek blok
`.trim(),
  }

  return instructions[fileName] ?? `${fileName} dosyasını proje için uygun şekilde oluştur.`
}

// ---------------------------------------------------------------------------
// KRİTİK-1: Dosya özeti çıkar — priorContext zinciri
// ---------------------------------------------------------------------------

async function extractFileSummary(
  claude:   Anthropic,
  fileName: string,
  content:  string,
): Promise<string> {
  try {
    const response = await claude.messages.create({
      model:      MODEL,
      max_tokens: 300,
      system:     'Sen bir teknik dokümantasyon analistisin. Kısa ve net ol.',
      messages: [{
        role:    'user',
        content: `Aşağıdaki "${fileName}" dosyasından 3-5 maddelik özet çıkar.
Her madde tek cümle olsun. Sadece maddeleri ver — başka açıklama ekleme.
Odak: mimari kararlar, veri modelleri, servisler, kurallar, kritik kısıtlar.

İçerik:
${content.slice(0, 3000)}${content.length > 3000 ? '\n[...truncated...]' : ''}`,
      }],
    })

    const summary = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
    return `### ${fileName}\n${summary}`

  } catch {
    return `### ${fileName}\n(özet çıkarılamadı)`
  }
}

// ---------------------------------------------------------------------------
// MEMORY YAZICI — architecture (Session 18)
// Amaç:    Generation tamamlanınca proje mimarisini memory_chunks'a yazar
// Kural:   Non-critical — hata olsa generation result etkilenmez
// Edge:    partial_success'te de yazılır — status metadata'da belirtilir
// ---------------------------------------------------------------------------

async function writeArchitectureMemory(params: {
  userId:         string
  projectId:      string
  projectName:    string
  completedFiles: string[]
  failedFiles:    string[]
  totalCostUsd:   number
  priorContext:   string
}): Promise<void> {
  const status = params.failedFiles.length > 0 ? 'partial_success' : 'completed'

  const content = [
    `Proje: ${params.projectName}`,
    `Generation durumu: ${status}`,
    `Tamamlanan dosyalar: ${params.completedFiles.join(', ')}`,
    params.failedFiles.length > 0
      ? `Başarısız dosyalar: ${params.failedFiles.join(', ')}`
      : null,
    `Toplam maliyet: $${params.totalCostUsd.toFixed(4)}`,
    params.priorContext
      ? `\nDosya özetleri:\n${params.priorContext.slice(0, 1000)}`
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  const { error } = await supabase
    .from('memory_chunks')
    .insert({
      user_id:     params.userId,
      project_id:  params.projectId,
      session_id:  null,
      memory_type: 'architecture',
      content,
      metadata: {
        project_name:    params.projectName,
        completed_files: params.completedFiles,
        failed_files:    params.failedFiles,
        status,
        total_cost_usd:  params.totalCostUsd,
      },
    })

  if (error) {
    console.error('[writeArchitectureMemory] memory_chunks insert hatası:', error.message)
  }
}

// ---------------------------------------------------------------------------
// YARDIMCI: Dosyaları oturuma paketle
// ---------------------------------------------------------------------------

function packIntoSessions(
  files:      FileSpec[],
  masterPlan: string,
): GenerationSession[] {
  const sessions: GenerationSession[] = []
  const baseCost = estimateTokens(masterPlan) + 500

  let current: FileSpec[] = []
  let currentCost = baseCost

  for (const file of files) {
    const fileCost = estimateTokens(file.instruction) + 200

    if (current.length > 0 && currentCost + fileCost > SESSION_TOKEN_CAPACITY) {
      sessions.push({ files: current, priorContext: '' })
      current     = []
      currentCost = baseCost
    }

    current.push(file)
    currentCost += fileCost
  }

  if (current.length > 0) {
    sessions.push({ files: current, priorContext: '' })
  }

  return sessions
}

// ---------------------------------------------------------------------------
// YARDIMCI: System prompt oluştur
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  projectName:    string,
  masterPlan:     string,
  priorContext:   string,
  isFirstSession: boolean,
): string {
  const intro = isFirstSession
    ? `Sen "${projectName}" projesinin metodoloji dokümantasyon motorusun.`
    : `Sen "${projectName}" projesinin metodoloji dokümantasyon motorusun. Önceki oturumda üretilen dosyaların özetleri aşağıdadır — tutarlılık için bunlara bağlı kal.`

  const priorSection = priorContext
    ? `\n\n## Önceki Oturumda Üretilen Dosyaların Özetleri\n${priorContext}\n\n> Bu özetlere dayanarak yeni dosyaları üret. Çelişki yaratma.`
    : ''

  return `${intro}

## Görev
Kullanıcının master planından yola çıkarak proje metodoloji dosyalarını üret.
Her dosya bağımsız, eksiksiz ve doğrudan kullanılabilir olmalı.

## Master Plan
${masterPlan}
${priorSection}

## Üretim Kuralları
1. Her dosyayı <FILE name="DOSYA_ADI"> ... </FILE> etiketleri arasında ver
2. Dosya içeriği Markdown formatında olmalı
3. Truncated çıktı yasak — her dosya tam ve eksiksiz olmalı
4. Placeholder kullanma — gerçek içerik üret
5. Projeye özgü ol — jenerik şablon değil, bu projeye özel içerik
6. Master plan hangi dildeyse dosyalar da o dilde üretilir`.trim()
}

// ---------------------------------------------------------------------------
// YARDIMCI: Claude yanıtından dosya içeriğini çıkar
// ---------------------------------------------------------------------------

function extractFileContent(response: string, fileName: string): string | null {
  const pattern = new RegExp(
    `<FILE\\s+name=["']?${fileName.replace('.', '\\.')}["']?>([\\s\\S]*?)</FILE>`,
    'i'
  )
  const match = response.match(pattern)
  if (match) return match[1].trim()
  if (response.length > 100) return response.trim()
  return null
}

// ---------------------------------------------------------------------------
// YARDIMCI: Supabase dosya durumu güncelle
// ---------------------------------------------------------------------------

async function markFileStatus(
  projectId: string,
  fileName:  string,
  status:    'completed' | 'failed',
  errorMsg?: string,
): Promise<void> {
  await supabase
    .from('project_generation_status')
    .update({
      status,
      completed_at:  status === 'completed' ? new Date().toISOString() : null,
      error_message: errorMsg ?? null,
    })
    .eq('project_id', projectId)
    .eq('file_name',  fileName)
}

// ---------------------------------------------------------------------------
// YARDIMCI: Supabase'e dosya kaydet
// ---------------------------------------------------------------------------

async function saveToSupabase(
  projectId: string,
  fileName:  string,
  content:   string,
): Promise<void> {
  if (fileName === 'CORE.md') {
    const { error } = await supabase
      .from('user_projects')
      .update({ core_doc: content, gen_status: 'in_progress' })
      .eq('id', projectId)
    if (error) throw new Error(`core_doc yazılamadı: ${error.message}`)
    return
  }

  if (fileName === 'AI_AGENT.md') {
    const { error } = await supabase
      .from('user_projects')
      .update({ ai_agent_doc: content, gen_status: 'in_progress' })
      .eq('id', projectId)
    if (error) throw new Error(`ai_agent_doc yazılamadı: ${error.message}`)
    return
  }
}

// ---------------------------------------------------------------------------
// TEK DOSYA ÜRETİMİ
// ---------------------------------------------------------------------------

interface SingleFileResult {
  content:      string
  inputTokens:  number
  outputTokens: number
}

async function generateSingleFile(
  claude:       Anthropic,
  projectId:    string,
  file:         FileSpec,
  systemPrompt: string,
  retryCount:   number = 0,
): Promise<SingleFileResult> {
  const userMessage = `Şimdi sadece "${file.fileName}" dosyasını üret.

${file.instruction}

Yanıtını şu formatta ver:
<FILE name="${file.fileName}">
[dosya içeriği buraya]
</FILE>

Sadece bu dosyayı üret — başka açıklama ekleme.`

  await supabase
    .from('project_generation_status')
    .update({ started_at: new Date().toISOString(), status: 'pending' })
    .eq('project_id', projectId)
    .eq('file_name',  file.fileName)

  let response: Anthropic.Message

  try {
    response = await claude.messages.create({
      model:      MODEL,
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    })
  } catch (err: any) {
    if (retryCount < MAX_RETRIES) {
      console.warn(`[generationEngine] API hatası, retry ${retryCount + 1}/${MAX_RETRIES}: ${err.message}`)
      await new Promise(r => setTimeout(r, 2000 * (retryCount + 1)))
      return generateSingleFile(claude, projectId, file, systemPrompt, retryCount + 1)
    }
    throw err
  }

  const rawText = (response.content[0] as Anthropic.TextBlock)?.text ?? ''
  const content = extractFileContent(rawText, file.fileName)

  if (!content) {
    if (retryCount < MAX_RETRIES) {
      console.warn(`[generationEngine] "${file.fileName}" içerik çıkarılamadı, retry...`)
      return generateSingleFile(claude, projectId, file, systemPrompt, retryCount + 1)
    }
    throw new Error(`"${file.fileName}" için geçerli içerik üretilemedi.`)
  }

  return {
    content,
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
}

// ---------------------------------------------------------------------------
// ANA FONKSİYON: runGeneration
// ---------------------------------------------------------------------------

export async function runGeneration(opts: GenerationOptions): Promise<GenerationResult> {
  const {
    projectId,
    userId,
    projectName,
    masterPlan,
    completedFiles = [],
    bestEffort = true,
  } = opts

  console.log(`[generationEngine] Başladı — ${projectId} (${projectName}) | mode: ${bestEffort ? 'best-effort' : 'strict'}`)

  const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const allFiles: FileSpec[] = DEFAULT_FILE_PLAN.map(f => ({
    ...f,
    instruction: getFileInstruction(f.fileName),
  }))

  const pendingFiles = allFiles.filter(f => !completedFiles.includes(f.fileName))

  if (pendingFiles.length === 0) {
    console.log(`[generationEngine] Tüm dosyalar zaten tamamlanmış — ${projectId}`)
    return {
      success:        true,
      status:         'completed',
      completedFiles,
      failedFiles:    [],
      totalCostUsd:   0,
      fileCosts:      [],
    }
  }

  console.log(`[generationEngine] ${pendingFiles.length} dosya üretilecek (${completedFiles.length} atlandı)`)

  await supabase
    .from('user_projects')
    .update({ gen_status: 'in_progress' })
    .eq('id', projectId)

  const sessions = packIntoSessions(pendingFiles, masterPlan)
  console.log(`[generationEngine] ${sessions.length} oturum planlandı`)

  const successFiles: string[] = [...completedFiles]
  const failedFiles:  string[] = []
  const fileCosts:    FileCost[] = []
  let   totalCostUsd  = 0
  let   priorContext  = ''

  // ── Oturum döngüsü ────────────────────────────────────────────────────────
  for (let si = 0; si < sessions.length; si++) {
    const session        = sessions[si]
    const isFirstSession = si === 0 && completedFiles.length === 0

    let sessionSystemPrompt = buildSystemPrompt(
      projectName,
      masterPlan,
      priorContext,
      isFirstSession,
    )

    console.log(
      `[generationEngine] Oturum ${si + 1}/${sessions.length}: ` +
      `${session.files.map(f => f.fileName).join(', ')}`
    )

    // Karar #91: Kümülatif token sayacı — her oturum başında sıfırlanır
    let cumulativeTokens = 0

    // ── Dosya döngüsü ──────────────────────────────────────────────────────
    for (const file of session.files) {
      try {
        console.log(`[generationEngine] Üretiliyor: ${file.fileName}`)

        const result = await generateSingleFile(claude, projectId, file, sessionSystemPrompt)

        const costUsd = calcCost(result.inputTokens, result.outputTokens)
        totalCostUsd += costUsd
        fileCosts.push({
          fileName:     file.fileName,
          inputTokens:  result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd,
        })
        console.log(
          `[generationEngine] 💰 ${file.fileName}: ` +
          `in=${result.inputTokens} out=${result.outputTokens} cost=$${costUsd.toFixed(4)}`
        )

        if (file.storageTarget === 'supabase') {
          await saveToSupabase(projectId, file.fileName, result.content)
        }

        await markFileStatus(projectId, file.fileName, 'completed')
        successFiles.push(file.fileName)

        const summary = await extractFileSummary(claude, file.fileName, result.content)
        priorContext += (priorContext ? '\n\n' : '') + summary

        // Karar #91: Kümülatif sayacı güncelle — eşik aşılınca system prompt yenile
        cumulativeTokens += result.inputTokens + result.outputTokens
        if (cumulativeTokens >= CONTEXT_REFRESH_THRESHOLD) {
          console.log(
            `[generationEngine] ⚠️ Context yenileniyor — ` +
            `kümülatif token: ${cumulativeTokens} (eşik: ${CONTEXT_REFRESH_THRESHOLD})`
          )
          sessionSystemPrompt = buildSystemPrompt(
            projectName,
            masterPlan,
            priorContext,
            false,          // yenileme hiçbir zaman "ilk oturum" değil
          )
          cumulativeTokens = 0
        }

        const allDefaultDone = DEFAULT_FILE_PLAN.every(f =>
          successFiles.includes(f.fileName)
        )
        if (allDefaultDone) {
          await supabase
            .from('user_projects')
            .update({ gen_status: 'completed' })
            .eq('id', projectId)
        }

        console.log(`[generationEngine] ✅ ${file.fileName}`)

      } catch (err: any) {
        console.error(`[generationEngine] ❌ ${file.fileName}: ${err.message}`)

        await markFileStatus(projectId, file.fileName, 'failed', err.message)
        failedFiles.push(file.fileName)

        if (!bestEffort) {
          await supabase
            .from('user_projects')
            .update({ gen_status: 'failed' })
            .eq('id', projectId)

          return {
            success:        false,
            status:         'failed',
            completedFiles: successFiles,
            failedFiles,
            totalCostUsd,
            fileCosts,
            error:          err.message,
          }
        }

        console.warn(`[generationEngine] Best Effort: "${file.fileName}" atlandı, devam ediliyor...`)
      }
    }

    if (si < sessions.length - 1) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  // ── Sonuç ─────────────────────────────────────────────────────────────────

  const hasFailures  = failedFiles.length > 0
  const finalStatus: GenerationResult['status'] = hasFailures
    ? (successFiles.length > completedFiles.length ? 'partial_success' : 'failed')
    : 'completed'

  if (hasFailures) {
    await supabase
      .from('user_projects')
      .update({ gen_status: finalStatus === 'partial_success' ? 'completed' : 'failed' })
      .eq('id', projectId)
  }

  // ── memory_chunks INSERT — architecture (Session 18) ─────────────────────
  // Başarılı veya partial_success — her iki durumda da yazılır
  // Failed durumda yazılmaz — priorContext boş kalır, anlamsız chunk oluşur
  if (finalStatus !== 'failed') {
    await writeArchitectureMemory({
      userId,
      projectId,
      projectName,
      completedFiles: successFiles,
      failedFiles,
      totalCostUsd,
      priorContext,
    })
  }

  console.log(
    `[generationEngine] ${finalStatus === 'completed' ? '✅' : '⚠️'} Bitti — ` +
    `${successFiles.length} başarılı / ${failedFiles.length} başarısız | ` +
    `toplam maliyet: $${totalCostUsd.toFixed(4)}`
  )

  return {
    success:        finalStatus !== 'failed',
    status:         finalStatus,
    completedFiles: successFiles,
    failedFiles,
    totalCostUsd,
    fileCosts,
    error:          hasFailures
      ? `${failedFiles.length} dosya başarısız: ${failedFiles.join(', ')}`
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// RECOVERY: Yarım kalan üretimi devam ettir
// ---------------------------------------------------------------------------

export async function resumeGeneration(
  projectId:   string,
  userId:      string,
  projectName: string,
  masterPlan:  string,
): Promise<GenerationResult> {
  const { data: statusRows } = await supabase
    .from('project_generation_status')
    .select('file_name, status')
    .eq('project_id', projectId)

  const completed = (statusRows ?? [])
    .filter(r => r.status === 'completed')
    .map(r => r.file_name as string)

  await supabase
    .from('project_generation_status')
    .update({ status: 'pending', error_message: null })
    .eq('project_id', projectId)
    .eq('status',     'failed')

  console.log(`[generationEngine] Recovery başladı — ${completed.length} dosya atlanıyor`)

  return runGeneration({
    projectId,
    userId,
    projectName,
    masterPlan,
    completedFiles: completed,
    bestEffort:     true,
  })
}
