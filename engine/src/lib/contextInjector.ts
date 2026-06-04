/**
 * engine/src/lib/contextInjector.ts
 *
 * Bağlam Enjeksiyon Mekanizması — ADAPTERv1 Session 6
 *
 * Görev:
 *   - CORE.md + AI_AGENT.md + session_index.md'yi Claude'a enjekte eder
 *   - Token bazlı eşik: 80.000 token aşılınca enjeksiyon tetiklenir
 *   - CORE + AI_AGENT bellekte cache'lenir (TTL: 30 dakika)
 *   - session_index her enjeksiyonda hot.json'dan okunur (her zaman taze)
 *   - Kullanıcı enjeksiyonu görmez — system prompt'a gömülür
 *
 * Kararlar (session_index.md):
 *   #23: CORE + AI_AGENT Supabase'de şifreli — uygulama katmanı çözer
 *   Session 6: Token bazlı eşik (80K) — mesaj sayısı değil
 *   Session 6: Engine başlangıcında belleğe al, TTL sonra arka planda yenile
 */

import { supabase } from './supabase.js'
import fs           from 'fs'
import path         from 'path'

// ---------------------------------------------------------------------------
// SABİTLER
// ---------------------------------------------------------------------------

/** Token eşiği — aşılınca enjeksiyon tetiklenir */
const INJECTION_TOKEN_THRESHOLD = 80_000

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

interface InjectionResult {
  injected:      boolean
  system_suffix: string   // System prompt'a eklenecek metin
  tokens_reset:  boolean
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
    // core_doc ve ai_agent_doc — RLS korumalı, sadece proje sahibi erişir
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
    // İlk kez — senkron yükle
    return await fetchAndCache(projectId)
  }

  const age = Date.now() - cached.cached_at

  if (age > CACHE_TTL_MS && !cached.refreshing) {
    // TTL aşıldı — arka planda yenile, eski veriyi döndür
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
  userId:    string,
  projectId: string,
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
// ANA FONKSİYON: checkAndInject
// ---------------------------------------------------------------------------

/**
 * Her /api/ai/chat çağrısından SONRA çağrılır.
 * Token sayacını günceller, eşik aşıldıysa enjeksiyon içeriği döner.
 *
 * @param userId          - Kullanıcı ID (JWT'den)
 * @param projectId       - Aktif proje ID (null ise enjeksiyon yapılmaz)
 * @param localMemoryPath - hot.json konumu (Tauri'den gelir)
 * @param inputTokens     - API response.usage.input_tokens
 * @param outputTokens    - API response.usage.output_tokens
 *
 * @returns InjectionResult — injected=true ise system_suffix system prompt'a eklenir
 */
export async function checkAndInject(
  userId:          string,
  projectId:       string | null,
  localMemoryPath: string | null,
  inputTokens:     number,
  outputTokens:    number,
): Promise<InjectionResult> {

  const empty: InjectionResult = {
    injected:      false,
    system_suffix: '',
    tokens_reset:  false,
  }

  // Proje yoksa enjeksiyon yok
  if (!projectId) return empty

  // Token sayacını güncelle
  const thresholdReached = addTokens(userId, projectId, inputTokens, outputTokens)

  if (!thresholdReached) return empty

  // ── Eşik aşıldı — enjeksiyon hazırla ────────────────────────────────────

  const docs = await getProjectDocs(projectId)

  if (!docs) {
    // Dökümanlar alınamadı — sayacı sıfırla, devam et
    resetCounter(userId, projectId)
    return empty
  }

  // session_index — her zaman taze
  const sessionIndex = localMemoryPath
    ? readSessionIndex(localMemoryPath)
    : ''

  // System suffix oluştur
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

  const system_suffix = parts.join('\n')

  // Sayacı sıfırla
  resetCounter(userId, projectId)

  console.log(
    `[contextInjector] Enjeksiyon tetiklendi — ` +
    `user: ${userId} | project: ${projectId} | ` +
    `toplam token: ${inputTokens + outputTokens}`
  )

  return {
    injected:      true,
    system_suffix,
    tokens_reset:  true,
  }
}

// ---------------------------------------------------------------------------
// STARTUP: Engine başlarken aktif projeleri ön yükle
// ---------------------------------------------------------------------------

/**
 * Engine başlangıcında çağrılır.
 * Tüm kullanıcıların aktif projelerini belleğe alır.
 * Supabase gecikmesi startup'a gömülür — ilk mesajda gecikme olmaz.
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

    // Paralel yükle — tek tek bekleme
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
  // Token counter'ları temizle (prefix match)
  for (const key of tokenCounters.keys()) {
    if (key.endsWith(`:${projectId}`)) {
      tokenCounters.delete(key)
    }
  }
  console.log(`[contextInjector] Cache temizlendi: ${projectId}`)
}
