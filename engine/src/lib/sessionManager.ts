/**
 * engine/src/lib/sessionManager.ts
 *
 * Session Integrity Layer — ADAPTERv1 Session 11 → Session 18 (memory_chunks)
 *
 * Sorun:
 *   session_index.md üretiliyor (generationEngine) ve okunuyor (contextInjector)
 *   ama GÜNCELLEME manuel + reaktif. Crash olursa, sohbet yarım kalırsa,
 *   kullanıcı "güncelle" demezse → bir sonraki session yanlış state'den başlar.
 *
 * Çözüm — 3 katman:
 *   KATMAN 1 — Checkpoint:   Her kritik eylemden sonra hot.json + Supabase'e yaz
 *   KATMAN 2 — Integrity:    Session açılışında "sağlıklı mı?" kontrol et
 *   KATMAN 3 — Auto-close:   N dakika inactivity → otomatik kapat + memory yaz
 *
 * Session 18:
 *   writeSessionSummaryMemory() — closeSession() sonunda memory_chunks'a yazar
 *
 * Entegrasyon noktaları:
 *   aiProxy.ts  → openSession() / checkpoint() / touchActivity()
 *   contextInjector.ts → dokunulmaz (single responsibility korunur)
 *   generationEngine.ts → dokunulmaz
 *
 * DB:
 *   project_sessions tablosu (migration: 20260605000002_add_project_sessions.sql)
 *   memory_chunks tablosu (migration: 20260606000003_memory_chunks_user_id_rls_hnsw.sql)
 *
 * Dokunma: writeSessionSummaryMemory() kaldırılırsa TB-2 açılır.
 *          INACTIVITY_TIMEOUT_MS ve CHECKPOINT_DEBOUNCE_MS production kalibrasyon değerleri.
 */

import { supabase } from './supabase.js'
import fs            from 'fs'
import path          from 'path'

// ---------------------------------------------------------------------------
// SABİTLER
// ---------------------------------------------------------------------------

const INACTIVITY_TIMEOUT_MS  = 30 * 60 * 1000  // 30 dakika
const CHECKPOINT_DEBOUNCE_MS = 10_000           // 10 saniye
const HOT_SESSION_INDEX_KEY  = 'session_index'
const HOT_SESSION_META_KEY   = 'session_meta'

// ---------------------------------------------------------------------------
// TİPLER
// ---------------------------------------------------------------------------

export interface SessionCheckpoint {
  last_task:           string
  last_action:         string
  completed_files?:    string[]
  session_index_hash?: string
  custom?:             Record<string, unknown>
}

export interface SessionRecord {
  id:                 string
  project_id:         string
  user_id:            string
  opened_at:          string
  closed_at:          string | null
  last_checkpoint_at: string | null
  integrity_status:   'healthy' | 'dirty' | 'recovered'
  close_reason:       string | null
  checkpoint_data:    SessionCheckpoint
}

export interface IntegrityCheckResult {
  healthy:    boolean
  recovered:  boolean
  session_id: string | null
  message:    string
  checkpoint?: SessionCheckpoint
}

// ---------------------------------------------------------------------------
// IN-MEMORY ACTIVITY TRACKER
// ---------------------------------------------------------------------------

interface ActivityEntry {
  session_id:         string
  last_activity_at:   number
  last_checkpoint_at: number
  timer?:             ReturnType<typeof setTimeout>
}

const activityMap = new Map<string, ActivityEntry>()

function activityKey(userId: string, projectId: string): string {
  return `${userId}:${projectId}`
}

// ---------------------------------------------------------------------------
// YARDIMCI: Basit string hash
// ---------------------------------------------------------------------------

function simpleHash(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(16)
}

// ---------------------------------------------------------------------------
// YARDIMCI: hot.json oku/yaz
// ---------------------------------------------------------------------------

function readHotJson(localMemoryPath: string): Record<string, unknown> {
  try {
    const hotPath = path.join(localMemoryPath, 'hot.json')
    if (!fs.existsSync(hotPath)) return {}
    return JSON.parse(fs.readFileSync(hotPath, 'utf8'))
  } catch {
    return {}
  }
}

function writeHotJson(localMemoryPath: string, data: Record<string, unknown>): void {
  try {
    const hotPath = path.join(localMemoryPath, 'hot.json')
    const dir = path.dirname(hotPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(hotPath, JSON.stringify(data, null, 2), 'utf8')
  } catch (err: any) {
    console.warn(`[sessionManager] hot.json yazılamadı: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------
// MEMORY YAZICI — session_summary (Session 18)
// Amaç:    Session kapanışında özeti memory_chunks'a yazar
// Kural:   Non-critical — hata olsa closeSession devam eder
// Edge:    local-* session_id'leri için session_id null geçilir
//          crash_recovery kapanışlarında entry yok → bu fonksiyon çağrılmaz
// ---------------------------------------------------------------------------

async function writeSessionSummaryMemory(params: {
  userId:     string
  projectId:  string
  sessionId:  string
  reason:     string
  checkpoint: SessionCheckpoint
  openedAt:   number   // Unix ms — session süresi hesabı için
}): Promise<void> {
  const durationMin = Math.round((Date.now() - params.openedAt) / 60_000)

  // local-* fallback ID'leri Supabase'de yok — null geç
  const supabaseSessionId = params.sessionId.startsWith('local-')
    ? null
    : params.sessionId

  const content = [
    `Session kapandı: ${new Date().toISOString()}`,
    `Kapatma nedeni: ${params.reason}`,
    `Süre: ~${durationMin} dakika`,
    `Son görev: ${params.checkpoint.last_task}`,
    `Son eylem: ${params.checkpoint.last_action}`,
    params.checkpoint.custom
      ? `Ek bilgi: ${JSON.stringify(params.checkpoint.custom)}`
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  const { error } = await supabase
    .from('memory_chunks')
    .insert({
      user_id:     params.userId,
      project_id:  params.projectId,
      session_id:  supabaseSessionId,
      memory_type: 'session_summary',
      content,
      metadata: {
        close_reason:  params.reason,
        duration_min:  durationMin,
        last_task:     params.checkpoint.last_task,
        last_action:   params.checkpoint.last_action,
        session_id:    params.sessionId,
      },
    })

  if (error) {
    console.error('[writeSessionSummaryMemory] memory_chunks insert hatası:', error.message)
  }
}

// ---------------------------------------------------------------------------
// KATMAN 2: INTEGRITY CHECK
// ---------------------------------------------------------------------------

export async function checkIntegrity(
  userId:          string,
  projectId:       string,
  localMemoryPath: string | null,
): Promise<IntegrityCheckResult> {

  const { data: openSessions } = await supabase
    .from('project_sessions')
    .select('*')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .is('closed_at', null)
    .order('opened_at', { ascending: false })

  if (!openSessions || openSessions.length === 0) {
    return {
      healthy:    true,
      recovered:  false,
      session_id: null,
      message:    'Temiz başlangıç — önceki session düzgün kapanmış.',
    }
  }

  const dirtySession = openSessions[0] as SessionRecord
  console.warn(`[sessionManager] Dirty session tespit edildi: ${dirtySession.id} (toplam: ${openSessions.length})`)

  await supabase
    .from('project_sessions')
    .update({
      closed_at:        new Date().toISOString(),
      integrity_status: 'recovered',
      close_reason:     'crash_recovery',
    })
    .eq('id', dirtySession.id)

  const orphanIds = (openSessions as SessionRecord[]).slice(1).map(s => s.id)
  if (orphanIds.length > 0) {
    await supabase
      .from('project_sessions')
      .update({
        closed_at:        new Date().toISOString(),
        integrity_status: 'recovered',
        close_reason:     'bulk_recovered',
      })
      .in('id', orphanIds)

    console.warn(`[sessionManager] ${orphanIds.length} orphan session bulk temizlendi`)
  }

  if (localMemoryPath) {
    const hot  = readHotJson(localMemoryPath)
    const meta = (hot[HOT_SESSION_META_KEY] as Record<string, unknown>) ?? {}
    hot[HOT_SESSION_META_KEY] = {
      ...meta,
      last_recovery:       new Date().toISOString(),
      recovered_from:      dirtySession.id,
      recovery_checkpoint: dirtySession.checkpoint_data,
      bulk_recovered:      orphanIds.length,
    }
    writeHotJson(localMemoryPath, hot)
  }

  console.log(`[sessionManager] Recovery tamamlandı — ${dirtySession.id}`)

  return {
    healthy:    false,
    recovered:  true,
    session_id: dirtySession.id,
    message:    'Önceki session eksik kapandı — otomatik kurtarıldı. Kaldığın yerden devam edebilirsin.',
    checkpoint: dirtySession.checkpoint_data,
  }
}

// ---------------------------------------------------------------------------
// SESSION AÇ
// ---------------------------------------------------------------------------

export async function openSession(
  userId:    string,
  projectId: string,
): Promise<string> {

  const { data, error } = await supabase
    .from('project_sessions')
    .insert({
      project_id:       projectId,
      user_id:          userId,
      integrity_status: 'healthy',
      checkpoint_data:  {},
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error(`[sessionManager] Session açılamadı: ${error?.message}`)
    return `local-${Date.now()}`
  }

  const sessionId = (data as any).id as string

  const key      = activityKey(userId, projectId)
  const existing = activityMap.get(key)
  if (existing?.timer) clearTimeout(existing.timer)

  activityMap.set(key, {
    session_id:         sessionId,
    last_activity_at:   Date.now(),
    last_checkpoint_at: 0,
  })

  console.log(`[sessionManager] Session açıldı: ${sessionId}`)
  return sessionId
}

// ---------------------------------------------------------------------------
// KATMAN 1: CHECKPOINT
// ---------------------------------------------------------------------------

export async function checkpoint(
  userId:          string,
  projectId:       string,
  data:            SessionCheckpoint,
  localMemoryPath: string | null,
): Promise<void> {

  const key   = activityKey(userId, projectId)
  const entry = activityMap.get(key)
  const now   = Date.now()

  if (entry && now - entry.last_checkpoint_at < CHECKPOINT_DEBOUNCE_MS) return

  if (!entry) {
    console.warn(`[sessionManager] Checkpoint: aktif session bulunamadı ${userId}:${projectId}`)
    return
  }

  let checkpointWithHash = { ...data }
  if (localMemoryPath) {
    const hot          = readHotJson(localMemoryPath)
    const sessionIndex = (hot[HOT_SESSION_INDEX_KEY] as string) ?? ''
    if (sessionIndex) {
      checkpointWithHash.session_index_hash = simpleHash(sessionIndex)
    }
  }

  await supabase
    .from('project_sessions')
    .update({
      checkpoint_data:    checkpointWithHash,
      last_checkpoint_at: new Date().toISOString(),
    })
    .eq('id', entry.session_id)

  if (localMemoryPath) {
    const hot = readHotJson(localMemoryPath)
    hot[HOT_SESSION_META_KEY] = {
      session_id:      entry.session_id,
      last_checkpoint: new Date().toISOString(),
      ...checkpointWithHash,
    }
    writeHotJson(localMemoryPath, hot)
  }

  entry.last_checkpoint_at = now
  activityMap.set(key, entry)

  console.log(`[sessionManager] Checkpoint yazıldı: ${entry.session_id} — ${data.last_action}`)
}

// ---------------------------------------------------------------------------
// KATMAN 3: ACTIVITY TOUCH + AUTO-CLOSE
// ---------------------------------------------------------------------------

export function touchActivity(
  userId:          string,
  projectId:       string,
  localMemoryPath: string | null,
): void {

  const key   = activityKey(userId, projectId)
  const entry = activityMap.get(key)

  if (!entry) return

  if (entry.timer) clearTimeout(entry.timer)

  entry.last_activity_at = Date.now()

  entry.timer = setTimeout(() => {
    console.log(`[sessionManager] Inactivity timeout — session kapatılıyor: ${entry.session_id}`)
    closeSession(userId, projectId, 'timeout', localMemoryPath).catch(err => {
      console.error(`[sessionManager] Auto-close hatası: ${err.message}`)
    })
  }, INACTIVITY_TIMEOUT_MS)

  activityMap.set(key, entry)
}

// ---------------------------------------------------------------------------
// SESSION KAPAT
// Normal kapanış, timeout veya crash_recovery
// Session 18: memory_chunks'a session_summary yazar (crash_recovery hariç)
// ---------------------------------------------------------------------------

export async function closeSession(
  userId:          string,
  projectId:       string,
  reason:          'normal' | 'timeout' | 'crash_recovery' = 'normal',
  localMemoryPath: string | null,
): Promise<void> {

  const key   = activityKey(userId, projectId)
  const entry = activityMap.get(key)

  if (!entry) {
    console.warn(`[sessionManager] closeSession: aktif session bulunamadı ${userId}:${projectId}`)
    return
  }

  if (entry.timer) clearTimeout(entry.timer)

  // Supabase güncelle
  await supabase
    .from('project_sessions')
    .update({
      closed_at:        new Date().toISOString(),
      integrity_status: 'healthy',
      close_reason:     reason,
    })
    .eq('id', entry.session_id)

  // hot.json meta güncelle
  if (localMemoryPath) {
    const hot  = readHotJson(localMemoryPath)
    const meta = (hot[HOT_SESSION_META_KEY] as Record<string, unknown>) ?? {}
    hot[HOT_SESSION_META_KEY] = {
      ...meta,
      last_closed_at: new Date().toISOString(),
      close_reason:   reason,
      session_id:     entry.session_id,
    }
    writeHotJson(localMemoryPath, hot)
  }

  // ── memory_chunks INSERT — session_summary (Session 18) ──────────────────
  // crash_recovery hariç: checkIntegrity() zaten kapatıyor, entry yok
  // normal + timeout: son checkpoint verisiyle özet yaz
  const lastCheckpoint = await supabase
    .from('project_sessions')
    .select('checkpoint_data, opened_at')
    .eq('id', entry.session_id)
    .single()

  const checkpoint = (lastCheckpoint.data?.checkpoint_data as SessionCheckpoint) ?? {
    last_task:   'unknown',
    last_action: 'session kapandı',
  }

  const openedAt = lastCheckpoint.data?.opened_at
    ? new Date(lastCheckpoint.data.opened_at).getTime()
    : Date.now()

  await writeSessionSummaryMemory({
    userId,
    projectId,
    sessionId:  entry.session_id,
    reason,
    checkpoint,
    openedAt,
  })

  // Activity map'ten temizle
  activityMap.delete(key)

  console.log(`[sessionManager] Session kapatıldı: ${entry.session_id} (${reason})`)
}

// ---------------------------------------------------------------------------
// YARDIMCI: Aktif session ID'sini al
// ---------------------------------------------------------------------------

export function getActiveSessionId(userId: string, projectId: string): string | null {
  const key   = activityKey(userId, projectId)
  const entry = activityMap.get(key)
  return entry?.session_id ?? null
}

// ---------------------------------------------------------------------------
// STARTUP: Engine başlarken yarım kalmış sessionları işaretle
// ---------------------------------------------------------------------------

export async function markOrphanSessions(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('project_sessions')
      .update({
        integrity_status: 'dirty',
        close_reason:     'engine_restart',
      })
      .is('closed_at', null)
      .neq('integrity_status', 'dirty')
      .select('id')

    if (error) {
      console.warn(`[sessionManager] markOrphanSessions hatası: ${error.message}`)
      return
    }

    const count = (data as any[])?.length ?? 0
    if (count > 0) {
      console.log(`[sessionManager] ${count} orphan session dirty olarak işaretlendi`)
    }

  } catch (err: any) {
    console.error(`[sessionManager] markOrphanSessions beklenmeyen hata: ${err.message}`)
  }
}
