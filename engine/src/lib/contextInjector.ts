/**
 * engine/src/lib/contextInjector.ts
 *
 * Bağlam Enjeksiyon Mekanizması — ADAPTERv1 Session 6
 *
 * Görev:
 *   - CORE.md + AI_AGENT.md + session_index.md'yi Claude'a enjekte eder
 *   - Token bazlı eşik: eşik aşılınca enjeksiyon tetiklenir
 *   - CORE + AI_AGENT bellekte cache'lenir (TTL: 30 dakika)
 *   - session_index her enjeksiyonda hot.json'dan okunur (her zaman taze)
 *   - Kullanıcı enjeksiyonu görmez — system prompt'a gömülür
 *
 * Kararlar (session_index.md):
 *   #23: CORE + AI_AGENT Supabase'de şifreli — uygulama katmanı çözer
 *   Session 6: Token bazlı eşik — mesaj sayısı değil
 *   Session 6: Engine başlangıcında belleğe al, TTL sonra arka planda yenile
 *   Session 7: INJECTION_TOKEN_THRESHOLD 80k → 120k
 *   #91: INJECTION_TOKEN_THRESHOLD 120k → 50k + proaktif enjeksiyon export'u
 *        context_refreshed flag InjectionResult'a eklendi
 *
 * Dokunma: INJECTION_TOKEN_THRESHOLD Karar #91 ile kilitlendi — değiştirme.
 *          checkAndInjectProactive() aiProxy.ts /api/ai/chat handler'ı tarafından
 *          Claude çağrısından ÖNCE çağrılır — sıra değiştirilemez.
 */

import { supabase } from './supabase.js'
import fs           from 'fs'
import path         from 'path'

// ---------------------------------------------------------------------------
// SABİTLER
// ---------------------------------------------------------------------------

/**
 * Token eşiği — aşılınca enjeksiyon tetiklenir.
 * Karar #91: 120k → 50k (uzun chat'lerde erken kural kaymasını önler)
 */
const INJECTION_TOKEN_THRESHOLD = 50_000

/** Cache TTL: 30 dakika (ms) */
const CACHE_TTL_MS = 30 * 60 * 1000

/** Enjeksiyon başlığı — sistem promptuna eklenir */
const INJECTION_HEADER = `
━━━ BAĞLAM TAZELENDİ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Aşağıdaki belgeler projenin yürütme rehberidir.
Her karar bu belgelerle tutarlı olmalıdır.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim()

// ---------------------------------------------------------------------------
// TİPLER
// ---------------------------------------------------------------------------

interface ProjectCache {
  core_doc:     string
  ai_agent_doc: string
  cached_at:    number   // Unix ms
  refreshing:   boolean  // Arka plan yenileme devam ediyor mu
}

interface TokenCounter {
  total:      number
  last_reset: number   // Unix ms
}

export interface InjectionResult {
  injected:          boolean
  system_suffix:     string   // System prompt'a eklenecek metin
  tokens_reset:      boolean
  context_refreshed: boolean  // Karar #91: frontend "⚠️ Bağlam yenilendi" göstermesi için
}

// ---------------------------------------------------------------------------
// IN-MEMORY STORE
// ---------------------------------------------------------------------------

/** project_id → ProjectCache */
const projectCache = new Map<string, ProjectCache>()

/** user_id + project_id → TokenCounter */
const tokenCounters = new Map<string, TokenCounter>()

// ---------------------------------------------------------------------------
// CACHE YÖNETİMİ
// ---------------------------------------------------------------------------

/**
 * Proje CORE + AI_AGENT dökümanlarını Supabase'den çeker, belleğe alır.
 * Engine startup'ta ve TTL sonrasında çağrılır.
 */
async function fetchAndCache(projectId: string): Promise<ProjectCache | null> {
  try {
    const { data, error } = await supabase
      .from('user_projects')
      .select('core_doc, ai_agent_doc')
      .eq('id', projectId)
      .single()

    if (error || !data) {
      console.warn(`[contextInjector] Proje dökümanları alınamadı: ${projectId}`)
      return null
    }

    const entry: ProjectCache = {
      core_doc:     (data as any).core_doc     ?? '',
      ai_agent_doc: (data as any).ai_agent_doc ?? '',
      cached_at:    Date.now(),
      refreshing:   false,
    }

    projectCache.set(projectId, entry)
    return entry

  } catch (err: any) {
    console.error(`[contextInjector] Cache hatası: ${err.message}`)
    return null
  }
}

/**
 * Cache'i kontrol eder. TTL aşıldıysa arka planda yeniler (kullanıcı beklemez).
 */
async function getProjectDocs(projectId: string): Promise<ProjectCache | null> {
  const cached = projectCache.get(projectId)

  if (!cached) {
    return await fetchAndCache(projectId)
  }

  const age = Date.now() - cached.cached_at

  if (age > CACHE_TTL_MS && !cached.refreshing) {
    cached.refreshing = true
    fetchAndCache(projectId).then(fresh => {
      if (fresh) {
        console.log(`[contextInjector] Cache yenilendi: ${projectId}`)
      }
    })
  }

  return cached
}

// ---------------------------------------------------------------------------
// SESSION INDEX OKUMA
// ---------------------------------------------------------------------------

/**
 * hot.json'dan session_index içeriğini okur.
 * Her enjeksiyonda taze veri — cache'lenmez.
 */
function readSessionIndex(localMemoryPath: string): string {
  try {
    const hotPath = path.join(localMemoryPath, 'hot.json')

    if (!fs.existsSync(hotPath)) {
      return ''
    }

    const hot = JSON.parse(fs.readFileSync(hotPath, 'utf8'))
    return hot.session_index ?? ''

  } catch (err: any) {
    console.warn(`[contextInjector] session_index okunamadı: ${err.message}`)
    return ''
  }
}

// ---------------------------------------------------------------------------
// TOKEN SAYACI
// ---------------------------------------------------------------------------

function getCounterKey(userId: string, projectId: string): string {
  return `${userId}:${projectId}`
}

/**
 * Token kullanımını sayaca ekler.
 * Eşik aşıldıysa true döner — enjeksiyon tetiklenmeli.
 */
function addTokens(
  userId:       string,
  projectId:    string,
  inputTokens:  number,
  outputTokens: number,
): boolean {
  const key     = getCounterKey(userId, projectId)
  const counter = tokenCounters.get(key) ?? { total: 0, last_reset: Date.now() }

  counter.total += inputTokens + outputTokens
  tokenCounters.set(key, counter)

  return counter.total >= INJECTION_TOKEN_THRESHOLD
}

/**
 * Eşik kontrolü — token eklemeden sadece kontrol eder.
 * Karar #91: proaktif (öncesi) kontrol için kullanılır.
 */
function isThresholdReached(userId: string, projectId: string): boolean {
  const key = getCounterKey(userId, projectId)
  return (tokenCounters.get(key)?.total ?? 0) >= INJECTION_TOKEN_THRESHOLD
}

/**
 * Token sayacını sıfırlar.
 */
function resetCounter(userId: string, projectId: string): void {
  const key = getCounterKey(userId, projectId)
  tokenCounters.set(key, { total: 0, last_reset: Date.now() })
}

/**
 * Token sayacını döndürür (monitoring için).
 */
export function getTokenCount(userId: string, projectId: string): number {
  const key = getCounterKey(userId, projectId)
  return tokenCounters.get(key)?.total ?? 0
}

// ---------------------------------------------------------------------------
// ENJEKSIYON İÇERİĞİ OLUŞTURUCU (paylaşılan yardımcı)
// ---------------------------------------------------------------------------

async function buildInjectionResult(
  userId:          string,
  projectId:       string,
  localMemoryPath: string | null,
): Promise<InjectionResult> {
  const empty: InjectionResult = {
    injected:          false,
    system_suffix:     '',
    tokens_reset:      false,
    context_refreshed: false,
  }

  const docs = await getProjectDocs(projectId)

  if (!docs) {
    resetCounter(userId, projectId)
    return empty
  }

  const sessionIndex = localMemoryPath
    ? readSessionIndex(localMemoryPath)
    : ''

  const parts: string[] = [INJECTION_HEADER]

  if (docs.core_doc) {
    parts.push(`\n## CORE\n${docs.core_doc}`)
  }

  if (docs.ai_agent_doc) {
    parts.push(`\n## AI_AGENT\n${docs.ai_agent_doc}`)
  }

  if (sessionIndex) {
    parts.push(`\n## SESSION_INDEX\n${sessionIndex}`)
  }

  resetCounter(userId, projectId)

  console.log(
    `[contextInjector] Enjeksiyon tetiklendi — ` +
    `user: ${userId} | project: ${projectId}`
  )

  return {
    injected:          true,
    system_suffix:     parts.join('\n'),
    tokens_reset:      true,
    context_refreshed: true,
  }
}

// ---------------------------------------------------------------------------
// PROAKTİF KONTROL: Claude çağrısından ÖNCE çağrılır (Karar #91)
// ---------------------------------------------------------------------------

/**
 * /api/ai/chat handler'ında Claude çağrısından ÖNCE çağrılır.
 * Eşik aşıldıysa enjeksiyon içeriğini döner — system prompt'a eklenir.
 * Eşik aşılmadıysa injected=false döner — işlem yapılmaz.
 *
 * @param userId          - Kullanıcı ID (JWT'den)
 * @param projectId       - Aktif proje ID (null ise enjeksiyon yapılmaz)
 * @param localMemoryPath - hot.json konumu (Tauri'den gelir)
 */
export async function checkAndInjectProactive(
  userId:          string,
  projectId:       string | null,
  localMemoryPath: string | null,
): Promise<InjectionResult> {
  const empty: InjectionResult = {
    injected:          false,
    system_suffix:     '',
    tokens_reset:      false,
    context_refreshed: false,
  }

  if (!projectId) return empty
  if (!isThresholdReached(userId, projectId)) return empty

  return buildInjectionResult(userId, projectId, localMemoryPath)
}

// ---------------------------------------------------------------------------
// REAKTİF KONTROL: Claude çağrısından SONRA çağrılır (orijinal davranış)
// ---------------------------------------------------------------------------

/**
 * Her /api/ai/chat çağrısından SONRA çağrılır.
 * Token sayacını günceller, eşik aşıldıysa enjeksiyon içeriği döner.
 * Bir sonraki mesajda system prompt'a eklenir.
 *
 * @param userId          - Kullanıcı ID (JWT'den)
 * @param projectId       - Aktif proje ID (null ise enjeksiyon yapılmaz)
 * @param localMemoryPath - hot.json konumu (Tauri'den gelir)
 * @param inputTokens     - API response.usage.input_tokens
 * @param outputTokens    - API response.usage.output_tokens
 */
export async function checkAndInject(
  userId:          string,
  projectId:       string | null,
  localMemoryPath: string | null,
  inputTokens:     number,
  outputTokens:    number,
): Promise<InjectionResult> {
  const empty: InjectionResult = {
    injected:          false,
    system_suffix:     '',
    tokens_reset:      false,
    context_refreshed: false,
  }

  if (!projectId) return empty

  const thresholdReached = addTokens(userId, projectId, inputTokens, outputTokens)
  if (!thresholdReached) return empty

  return buildInjectionResult(userId, projectId, localMemoryPath)
}

// ---------------------------------------------------------------------------
// STARTUP: Engine başlarken aktif projeleri ön yükle
// ---------------------------------------------------------------------------

/**
 * Engine başlangıcında çağrılır.
 * Tüm kullanıcıların aktif projelerini belleğe alır.
 */
export async function preloadProjectCache(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('user_projects')
      .select('id')
      .eq('gen_status', 'completed')

    if (error || !data) {
      console.warn('[contextInjector] Preload başarısız:', error?.message)
      return
    }

    const ids = (data as any[]).map(p => p.id)
    console.log(`[contextInjector] ${ids.length} proje ön yükleniyor...`)

    await Promise.allSettled(ids.map(id => fetchAndCache(id)))

    console.log(`[contextInjector] Preload tamamlandı: ${ids.length} proje`)

  } catch (err: any) {
    console.error('[contextInjector] Preload hatası:', err.message)
  }
}

// ---------------------------------------------------------------------------
// CACHE TEMİZLE: Proje silinince çağrılır
// ---------------------------------------------------------------------------

export function evictProjectCache(projectId: string): void {
  projectCache.delete(projectId)
  for (const key of tokenCounters.keys()) {
    if (key.endsWith(`:${projectId}`)) {
      tokenCounters.delete(key)
    }
  }
  console.log(`[contextInjector] Cache temizlendi: ${projectId}`)
}
