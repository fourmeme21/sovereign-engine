/**
 * engine/src/lib/generationEngine.ts
 *
 * Generation Engine — ADAPTERv1 Session 7 (v1.1)
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
 * Kararlar:
 *   #19: "Adapter" = projeye özel eksiksiz yürütme dokümantasyonu
 *   #20: Evrensel şablon Seçenek B — dolu referans, Claude projeye özel yazar
 *   #21: Master plan formatı serbest
 *   #23: CORE + AI_AGENT → Supabase (plain text şimdilik — TODO: AES-256)
 *   #26: Generation recovery — her dosya sonrası durum kaydedilir
 *   #31: Akıllı paketleme — 20k token kapasitesi, dolunca yeni oturum
 */

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase.js'

// ---------------------------------------------------------------------------
// SABİTLER
// ---------------------------------------------------------------------------

/**
 * Her Claude oturumuna paketlenecek yaklaşık token kapasitesi.
 * KRİTİK-6: 3k → 20k. Sonnet 4 context limiti 200k — gereksiz session bölünmesi önlendi.
 * contextInjector.ts → INJECTION_TOKEN_THRESHOLD (120k) ile karıştırılmamalı — o chat içindir.
 */
const SESSION_TOKEN_CAPACITY = 20_000

/**
 * Ortalama karakter başına token tahmini.
 * Türkçe/İngilizce karışık metin için 4.0 daha güvenli alt sınır.
 * KRİTİK-5: Gerçek tokenizer şimdilik mevcut değil — sonraki sprintte ele alınır.
 */
const CHARS_PER_TOKEN = 4.0

/** Claude modeli — aiProxy.ts ile tutarlı */
const MODEL = 'claude-sonnet-4-20250514'

/** Maksimum tekrar denemesi — tek dosya üretiminde */
const MAX_RETRIES = 2

/**
 * Anthropic fiyatlandırması (Sonnet 4, USD / 1M token).
 * KRİTİK-9: Cost tracking için kullanılır.
 * Fiyatlar değişirse buradan güncellenir.
 */
const PRICE_INPUT_PER_M  = 3.0   // $3.00 / 1M input token
const PRICE_OUTPUT_PER_M = 15.0  // $15.00 / 1M output token

// ---------------------------------------------------------------------------
// TİPLER
// ---------------------------------------------------------------------------

export interface GenerationOptions {
  projectId:       string
  userId:          string
  projectName:     string
  masterPlan:      string
  /** Önceden tamamlanmış dosya isimleri — recovery için */
  completedFiles?: string[]
  /**
   * KRİTİK-4: Best Effort Mode.
   * true  → dosya hatasında devam et, sonunda partial_success raporu döndür
   * false → (strict) ilk hata anında dur (varsayılan: true)
   */
  bestEffort?: boolean
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

/** KRİTİK-9: Tek dosya için maliyet kaydı */
interface FileCost {
  fileName:     string
  inputTokens:  number
  outputTokens: number
  costUsd:      number
}

export interface GenerationResult {
  success:         boolean
  /** 'completed' | 'partial_success' | 'failed' — KRİTİK-4 */
  status:          'completed' | 'partial_success' | 'failed'
  completedFiles:  string[]
  failedFiles:     string[]   // KRİTİK-4: artık dizi
  /** KRİTİK-9: toplam maliyet */
  totalCostUsd:    number
  fileCosts:       FileCost[]
  error?:          string
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
  - KARAR BİLDİRİMİ formatı (intent/category/action/risk/... alanları)
  - SELF-CHECK kontrol listesi (veri / yetki / güvenlik / bağlam katmanları)
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
  - Üst düzey mimari diyagramı (ASCII veya Mermaid)
  - Her katmanın sorumluluğu ve sınırı
  - Temel veri modelleri (tip tanımları, alanlar, kısıtlar)
  - Servis kontratları (girdi/çıktı tipleri)
  - Bağımlılık yönü (hangi katman hangisini çağırabilir)
  - Veritabanı şeması özeti
  - API endpoint listesi
`.trim(),

    'ROADMAP.md': `
Projenin inşa sırası ve faz kriterleri.
İçermeli:
  - Mevcut faz ve tamamlanma yüzdesi
  - Her faz için: giriş kriterleri, çıkış kriterleri, görevler
  - Bağımlılıklar (hangi faz hangisine bağlı)
  - Tahmini süre
  - Riskler ve azaltma stratejileri
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
  - Hangi dosya hangi servise / modüle bağımlı
  - Değişiklik etkisi matrisi (X değişirse Y etkilenir)
  - Dış bağımlılıklar (API'ler, kütüphaneler, servisler)
  - Kritik bağımlılıklar (değişince sistemin durduğu yerler)
`.trim(),

    'failure_patterns.md': `
Bilinen hata ve başarısızlık kalıpları ile çözümleri.
İçermeli:
  - Her pattern için: ID, isim, tetikleyiciler, belirtiler, çözüm adımları
  - Kritik hatalar (sistem durduran)
  - Recovery prosedürleri
  - Önleyici kontroller
`.trim(),

    'rollback.md': `
Kritik değişiklikler için geri dönüş adımları.
İçermeli:
  - Her değişiklik türü için rollback prosedürü
  - Veritabanı rollback (migration DOWN)
  - Servis rollback (deploy geri alma)
  - Data rollback (backup'tan geri yükleme)
  - Rollback kararı kriterleri (ne zaman rollback yapılır)
`.trim(),

    'session_index.md': `
Anlık proje durum pusulası — her session başında okunur.
İçermeli:
  - CURRENT FOCUS (mevcut görev, faz, gerekçe, beklenen çıktı)
  - Son session özeti
  - Genel durum tablosu
  - Proje tamamlanma analizi (katman bazlı)
  - Sıradaki görevler (numaralı, durumlu)
  - Referans dosyalar (okundu/okunmadı)
  - Açık sorular
  - Korunanlar (dokunulmaması gerekenler)
  - Session log
Format: Markdown tablolar.
Uzunluk: ~100-200 satır.
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
// KRİTİK-1: Dosya özeti çıkar
//
// Her dosya üretildikten sonra Claude'a 3-5 maddelik özet çıkartılır.
// Bu özet sonraki oturumun priorContext'ine eklenir — gerçek bağlam zinciri.
// ---------------------------------------------------------------------------

async function extractFileSummary(
  claude:    Anthropic,
  fileName:  string,
  content:   string,
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
    // Özet başarısız olsa da üretim devam eder
    return `### ${fileName}\n(özet çıkarılamadı)`
  }
}

// ---------------------------------------------------------------------------
// YARDIMCI: Dosyaları oturuma paketle
// ---------------------------------------------------------------------------

/**
 * KRİTİK-6: SESSION_TOKEN_CAPACITY 3k → 20k.
 * Sonnet 4 context 200k — gereksiz session bölünmesi önlendi.
 * 10 dosyanın tamamı büyük olasılıkla tek oturuma sığar.
 */
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
4. Placeholder ("örnek", "TODO", "[buraya ekle]") kullanma — gerçek içerik üret
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

  // Fallback: tek dosya üretiminde etiketsiz yanıt
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
    bestEffort = true,   // KRİTİK-4: varsayılan Best Effort
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
  const failedFiles:  string[] = []                   // KRİTİK-4
  const fileCosts:    FileCost[] = []                 // KRİTİK-9
  let   totalCostUsd = 0
  let   priorContext = ''                             // KRİTİK-1: bağlam zinciri

  // ── Oturum döngüsü ────────────────────────────────────────────────────────
  for (let si = 0; si < sessions.length; si++) {
    const session       = sessions[si]
    const isFirstSession = si === 0 && completedFiles.length === 0

    const systemPrompt = buildSystemPrompt(
      projectName,
      masterPlan,
      priorContext,
      isFirstSession,
    )

    console.log(
      `[generationEngine] Oturum ${si + 1}/${sessions.length}: ` +
      `${session.files.map(f => f.fileName).join(', ')}`
    )

    // ── Dosya döngüsü ──────────────────────────────────────────────────────
    for (const file of session.files) {
      try {
        console.log(`[generationEngine] Üretiliyor: ${file.fileName}`)

        const result = await generateSingleFile(claude, projectId, file, systemPrompt)

        // KRİTİK-9: Maliyet kaydet
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

        // Supabase hedefli dosyaları kaydet
        if (file.storageTarget === 'supabase') {
          await saveToSupabase(projectId, file.fileName, result.content)
        }

        // Dosya durumu: completed
        await markFileStatus(projectId, file.fileName, 'completed')
        successFiles.push(file.fileName)

        // KRİTİK-1: Bu dosyanın özetini çıkar — sonraki oturum için bağlam zinciri
        const summary = await extractFileSummary(claude, file.fileName, result.content)
        priorContext += (priorContext ? '\n\n' : '') + summary

        // Tüm default dosyalar bitti mi?
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
        failedFiles.push(file.fileName)  // KRİTİK-4: diziye ekle

        if (!bestEffort) {
          // Strict mode: ilk hata anında dur
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

        // Best Effort mode: hata logla, sonraki dosyaya devam et
        console.warn(`[generationEngine] Best Effort: "${file.fileName}" atlandı, devam ediliyor...`)
      }
    }

    // Oturumlar arası bekleme — rate limit koruması
    if (si < sessions.length - 1) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  // ── Sonuç ─────────────────────────────────────────────────────────────────

  // KRİTİK-4: partial_success durumu
  const hasFailures = failedFiles.length > 0
  const finalStatus: GenerationResult['status'] = hasFailures
    ? (successFiles.length > completedFiles.length ? 'partial_success' : 'failed')
    : 'completed'

  if (hasFailures) {
    await supabase
      .from('user_projects')
      .update({ gen_status: finalStatus === 'partial_success' ? 'completed' : 'failed' })
      .eq('id', projectId)
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

  // Failed dosyaları pending'e geri al — yeniden denenecek
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
