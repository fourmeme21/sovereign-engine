/**
 * engine/src/routes/projectRouter.ts
 *
 * Project Setup Engine — ADAPTERv1 Session 6
 *
 * Endpoint'ler:
 *   POST   /api/project/create          → Yeni proje + generation başlat
 *   GET    /api/project                 → Kullanıcının projeleri
 *   GET    /api/project/:id/status      → Generation durumu (recovery)
 *   POST   /api/project/:id/file        → Tek dosya kaydet (generation adımı)
 *   DELETE /api/project/:id             → Proje sil (Supabase + lokal uyarısı)
 *   PUT    /api/project/:id/masterplan  → Master plan güncelle → fark analizi
 *
 * Kararlar (session_index.md):
 *   #23: CORE + AI_AGENT Supabase'de şifreli, kullanıcı görmez
 *   #26: Generation recovery — her dosya sonrası durum kaydedilir
 *   #27: Tier → proje limiti (DB trigger zorlar, burada da kontrol edilir)
 *   #28: Proje silme: Supabase + lokal memory uyarısı
 *   #29: Master plan güncelleme → fark analizi
 *   #30: Project Setup Engine ayrı kurulum akışı
 *   #31: Akıllı paketleme — token sayacı engine'de değil istemcide yönetilir
 */

import { Router, Request, Response } from 'express'
import { supabase }                   from '../lib/supabase.js'
import { authMiddleware }             from '../middleware/authMiddleware.js'

// ---------------------------------------------------------------------------
// TİP TANIMLARI
// ---------------------------------------------------------------------------

/** Supabase'e yazılan dosya hedefi */
type StorageTarget = 'supabase' | 'local_warm' | 'local_hot'

/** Generation dosya kaydı */
interface GenerationFile {
  file_name:      string
  file_order:     number
  storage_target: StorageTarget
  content?:       string   // Sadece supabase hedefli dosyalar için
}

/** Supabase'den okunan proje satırı (core_doc / ai_agent_doc HARİÇ) */
interface ProjectRow {
  id:                string
  user_id:           string
  project_name:      string
  project_slug:      string
  gen_status:        string
  local_memory_path: string | null
  created_at:        string
  updated_at:        string
}

// ---------------------------------------------------------------------------
// YARDIMCI: Slug üret
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
}

// ---------------------------------------------------------------------------
// YARDIMCI: Kullanıcı tier'ını çek
// ---------------------------------------------------------------------------

async function getUserTier(userId: string): Promise<string> {
  const { data } = await supabase
    .from('user_profiles')
    .select('tier')
    .eq('id', userId)
    .single()
  return (data as any)?.tier ?? 'free'
}

// ---------------------------------------------------------------------------
// YARDIMCI: Proje sayısını kontrol et (DB trigger ikinci savunma hattı)
// ---------------------------------------------------------------------------

const TIER_PROJECT_LIMITS: Record<string, number> = {
  free: 1,
  solo: 3,
  pro:  10,
  team: Infinity,
}

async function checkProjectLimit(userId: string, tier: string): Promise<boolean> {
  const limit = TIER_PROJECT_LIMITS[tier] ?? 1
  if (limit === Infinity) return true

  const { count } = await supabase
    .from('user_projects')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)

  return (count ?? 0) < limit
}

// ---------------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------------

const router = Router()

// Tüm project route'ları auth gerektirir
router.use(authMiddleware)

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/project/create
//
// Yeni proje oluşturur. Generation akışını başlatır.
// Tier limiti DB trigger'da da zorlanır — burada erken hata üretilir.
//
// Body:
//   project_name    string (zorunlu)
//   master_plan     string (opsiyonel — sonradan da yüklenebilir)
//   local_memory_path string (opsiyonel — istemci belirler)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/create', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id

  const { project_name, master_plan, local_memory_path } = req.body

  // Validasyon
  if (!project_name || typeof project_name !== 'string') {
    res.status(400).json({ error: 'project_name zorunlu.' })
    return
  }

  if (project_name.trim().length < 2 || project_name.trim().length > 100) {
    res.status(400).json({ error: 'project_name 2-100 karakter arasında olmalı.' })
    return
  }

  try {
    // Tier limiti kontrolü (erken hata)
    const tier = await getUserTier(userId)
    const allowed = await checkProjectLimit(userId, tier)

    if (!allowed) {
      const limit = TIER_PROJECT_LIMITS[tier] ?? 1
      res.status(403).json({
        error:   'Proje limiti aşıldı.',
        detail:  `${tier} planı en fazla ${limit} proje destekler.`,
        upgrade: '/api/billing/upgrade',
      })
      return
    }

    const slug = slugify(project_name)

    // Proje oluştur
    const { data: project, error: insertError } = await supabase
      .from('user_projects')
      .insert({
        user_id:           userId,
        project_name:      project_name.trim(),
        project_slug:      slug,
        master_plan:       master_plan ?? null,
        gen_status:        'pending',
        local_memory_path: local_memory_path ?? null,
      })
      .select('id, project_name, project_slug, gen_status, created_at')
      .single()

    if (insertError) {
      // Slug çakışması
      if (insertError.code === '23505') {
        res.status(409).json({
          error:  'Bu isimde bir proje zaten var.',
          detail: insertError.message,
        })
        return
      }
      // Tier limiti DB trigger'dan geldi
      if (insertError.code === 'P0001') {
        res.status(403).json({ error: insertError.message })
        return
      }
      throw insertError
    }

    // Generation dosya planını kaydet (pending durumunda)
    const DEFAULT_FILES: GenerationFile[] = [
      { file_name: 'CORE.md',              file_order: 1,  storage_target: 'supabase'   },
      { file_name: 'AI_AGENT.md',          file_order: 2,  storage_target: 'supabase'   },
      { file_name: 'ARCHITECTURE.md',      file_order: 3,  storage_target: 'local_warm' },
      { file_name: 'ROADMAP.md',           file_order: 4,  storage_target: 'local_warm' },
      { file_name: 'TASK_CARDS.md',        file_order: 5,  storage_target: 'local_warm' },
      { file_name: 'DEPENDENCIES.md',      file_order: 6,  storage_target: 'local_warm' },
      { file_name: 'failure_patterns.md',  file_order: 7,  storage_target: 'local_warm' },
      { file_name: 'rollback.md',          file_order: 8,  storage_target: 'local_warm' },
      { file_name: 'session_index.md',     file_order: 9,  storage_target: 'local_hot'  },
      { file_name: 'session_log.md',       file_order: 10, storage_target: 'local_hot'  },
    ]

    const statusRows = DEFAULT_FILES.map(f => ({
      project_id:     (project as any).id,
      file_name:      f.file_name,
      file_order:     f.file_order,
      storage_target: f.storage_target,
      status:         'pending',
    }))

    const { error: statusError } = await supabase
      .from('project_generation_status')
      .insert(statusRows)

    if (statusError) {
      console.error('[projectRouter/create] Generation status kayıt hatası:', statusError.message)
      // Kritik değil — proje oluşturuldu, status sonradan eklenebilir
    }

    res.status(201).json({
      project_id:   (project as any).id,
      project_name: (project as any).project_name,
      project_slug: (project as any).project_slug,
      gen_status:   (project as any).gen_status,
      created_at:   (project as any).created_at,
      pending_files: DEFAULT_FILES.map(f => f.file_name),
      message:      'Proje oluşturuldu. Generation başlatılabilir.',
    })

  } catch (err: any) {
    console.error('[projectRouter/create] Hata:', err.message)
    res.status(500).json({ error: 'Proje oluşturulamadı.', detail: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/project
//
// Kullanıcının tüm projelerini listeler.
// core_doc / ai_agent_doc HİÇBİR ZAMAN döndürülmez.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id

  try {
    const { data, error } = await supabase
      .from('user_projects')
      // core_doc ve ai_agent_doc kasıtlı olarak SELECT'e dahil edilmedi
      .select('id, project_name, project_slug, gen_status, local_memory_path, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ projects: data ?? [] })

  } catch (err: any) {
    console.error('[projectRouter/list] Hata:', err.message)
    res.status(500).json({ error: 'Projeler listelenemedi.' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/project/:id/status
//
// Generation durumunu döner — recovery için kullanılır.
// Hangi dosyalar tamamlandı, hangisi bekliyor.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:id/status', async (req: Request, res: Response): Promise<void> => {
  const userId    = req.user!.id
  const projectId = req.params.id

  try {
    // Proje sahibi doğrula
    const { data: project, error: projError } = await supabase
      .from('user_projects')
      .select('id, project_name, gen_status')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single()

    if (projError || !project) {
      res.status(404).json({ error: 'Proje bulunamadı.' })
      return
    }

    // Dosya durumları
    const { data: files, error: filesError } = await supabase
      .from('project_generation_status')
      .select('file_name, file_order, storage_target, status, error_message, completed_at')
      .eq('project_id', projectId)
      .order('file_order', { ascending: true })

    if (filesError) throw filesError

    const completed = (files ?? []).filter(f => f.status === 'completed')
    const pending   = (files ?? []).filter(f => f.status === 'pending')
    const failed    = (files ?? []).filter(f => f.status === 'failed')

    // Recovery mesajı
    let recovery_message: string | null = null
    if ((project as any).gen_status === 'in_progress' && pending.length > 0) {
      recovery_message = `Generation yarım kaldı. Sıradaki: "${pending[0].file_name}". Kaldığı yerden devam edebilirsin.`
    }

    res.json({
      project_id:       projectId,
      project_name:     (project as any).project_name,
      gen_status:       (project as any).gen_status,
      total_files:      (files ?? []).length,
      completed_files:  completed.length,
      pending_files:    pending.length,
      failed_files:     failed.length,
      files:            files ?? [],
      recovery_message,
    })

  } catch (err: any) {
    console.error('[projectRouter/status] Hata:', err.message)
    res.status(500).json({ error: 'Durum alınamadı.' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/project/:id/file
//
// Generation adımı: tek dosya kaydeder.
// Karar #26: Her dosya sonrası durum güncellenir — recovery için.
//
// Body:
//   file_name      string  (zorunlu)
//   storage_target string  (zorunlu: 'supabase' | 'local_warm' | 'local_hot')
//   content        string  (storage_target='supabase' ise zorunlu)
//   is_extra       boolean (opsiyonel — varsayılan dosyalar dışındaysa true)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/:id/file', async (req: Request, res: Response): Promise<void> => {
  const userId    = req.user!.id
  const projectId = req.params.id

  const { file_name, storage_target, content, is_extra } = req.body

  // Validasyon
  if (!file_name || typeof file_name !== 'string') {
    res.status(400).json({ error: 'file_name zorunlu.' })
    return
  }

  const validTargets: StorageTarget[] = ['supabase', 'local_warm', 'local_hot']
  if (!validTargets.includes(storage_target)) {
    res.status(400).json({ error: 'Geçersiz storage_target. supabase | local_warm | local_hot' })
    return
  }

  if (storage_target === 'supabase' && !content) {
    res.status(400).json({ error: 'supabase hedefli dosyalar için content zorunlu.' })
    return
  }

  try {
    // Proje sahibi doğrula
    const { data: project, error: projError } = await supabase
      .from('user_projects')
      .select('id, gen_status')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single()

    if (projError || !project) {
      res.status(404).json({ error: 'Proje bulunamadı.' })
      return
    }

    // core_doc / ai_agent_doc için özel yazım
    // Karar #23: Şifreli olarak kaydedilir, kullanıcı göremez
    if (file_name === 'CORE.md' || file_name === 'AI_AGENT.md') {
      const field = file_name === 'CORE.md' ? 'core_doc' : 'ai_agent_doc'

      const { error: docError } = await supabase
        .from('user_projects')
        .update({ [field]: content, gen_status: 'in_progress' })
        .eq('id', projectId)

      if (docError) throw docError
    }

    // Generation status güncelle veya ekle (is_extra dosyalar için upsert)
    const { data: existing } = await supabase
      .from('project_generation_status')
      .select('id, file_order')
      .eq('project_id', projectId)
      .eq('file_name', file_name)
      .single()

    if (existing) {
      // Mevcut — güncelle
      const { error: updateError } = await supabase
        .from('project_generation_status')
        .update({
          status:       'completed',
          completed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('project_id', projectId)
        .eq('file_name', file_name)

      if (updateError) throw updateError
    } else {
      // Yeni (projeye özel ek dosya)
      const { data: maxOrder } = await supabase
        .from('project_generation_status')
        .select('file_order')
        .eq('project_id', projectId)
        .order('file_order', { ascending: false })
        .limit(1)
        .single()

      const nextOrder = ((maxOrder as any)?.file_order ?? 10) + 1

      const { error: insertError } = await supabase
        .from('project_generation_status')
        .insert({
          project_id:     projectId,
          file_name,
          file_order:     nextOrder,
          storage_target,
          status:         'completed',
          started_at:     new Date().toISOString(),
          completed_at:   new Date().toISOString(),
        })

      if (insertError) throw insertError
    }

    // gen_status güncelle: tüm dosyalar tamam mı?
    const { data: allFiles } = await supabase
      .from('project_generation_status')
      .select('status')
      .eq('project_id', projectId)

    const allDone   = (allFiles ?? []).every(f => f.status === 'completed')
    const newStatus = allDone ? 'completed' : 'in_progress'

    await supabase
      .from('user_projects')
      .update({ gen_status: newStatus })
      .eq('id', projectId)

    res.json({
      file_name,
      storage_target,
      status:     'completed',
      gen_status: newStatus,
      message:    allDone
        ? 'Tüm dosyalar tamamlandı. Generation complete.'
        : `"${file_name}" kaydedildi.`,
    })

  } catch (err: any) {
    console.error('[projectRouter/file] Hata:', err.message)

    // Dosyayı failed olarak işaretle
    await supabase
      .from('project_generation_status')
      .update({ status: 'failed', error_message: err.message })
      .eq('project_id', projectId)
      .eq('file_name', file_name)

    res.status(500).json({ error: 'Dosya kaydedilemedi.', detail: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/project/:id
//
// Proje siler. Supabase CASCADE ile bağlı kayıtları temizler.
// Karar #28: Lokal memory istemci tarafında silinmeli — uyarı gönderilir.
// ═══════════════════════════════════════════════════════════════════════════

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const userId    = req.user!.id
  const projectId = req.params.id

  try {
    // Proje sahibi doğrula + local_memory_path al
    const { data: project, error: projError } = await supabase
      .from('user_projects')
      .select('id, project_name, local_memory_path')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single()

    if (projError || !project) {
      res.status(404).json({ error: 'Proje bulunamadı.' })
      return
    }

    // Supabase'den sil (CASCADE: project_generation_status + decisions)
    const { error: deleteError } = await supabase
      .from('user_projects')
      .delete()
      .eq('id', projectId)

    if (deleteError) throw deleteError

    res.json({
      deleted:            true,
      project_id:         projectId,
      project_name:       (project as any).project_name,
      local_cleanup_required: true,
      local_memory_path:  (project as any).local_memory_path,
      // Karar #28: İstemci bu yolu siler
      message: 'Proje Supabase\'den silindi. Lokal memory\'yi de temizle.',
      local_cleanup_instruction:
        `Şu klasörü sil: ${(project as any).local_memory_path ?? `sovereign-engine/memory/${projectId}/`}`,
    })

  } catch (err: any) {
    console.error('[projectRouter/delete] Hata:', err.message)
    res.status(500).json({ error: 'Proje silinemedi.', detail: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// PUT /api/project/:id/masterplan
//
// Master plan günceller. Fark analizi sonucu döner.
// Karar #29: CORE + AI_AGENT değişti mi → revize gerekiyor mu?
//
// Body:
//   master_plan string (zorunlu — yeni master plan içeriği)
// ═══════════════════════════════════════════════════════════════════════════

router.put('/:id/masterplan', async (req: Request, res: Response): Promise<void> => {
  const userId    = req.user!.id
  const projectId = req.params.id

  const { master_plan } = req.body

  if (!master_plan || typeof master_plan !== 'string') {
    res.status(400).json({ error: 'master_plan zorunlu.' })
    return
  }

  try {
    // Proje sahibi doğrula
    const { data: project, error: projError } = await supabase
      .from('user_projects')
      .select('id, project_name, master_plan')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single()

    if (projError || !project) {
      res.status(404).json({ error: 'Proje bulunamadı.' })
      return
    }

    const oldPlan = (project as any).master_plan ?? ''
    const changed = oldPlan.trim() !== master_plan.trim()

    // Master planı güncelle
    const { error: updateError } = await supabase
      .from('user_projects')
      .update({ master_plan })
      .eq('id', projectId)

    if (updateError) throw updateError

    if (!changed) {
      res.json({
        updated:          true,
        content_changed:  false,
        revision_needed:  false,
        message:          'Master plan değişmedi — revizyon gerekmez.',
      })
      return
    }

    // İçerik değişti — hangi dosyaların revize edileceğini belirt
    // Karar #29: Claude fark analizini yapar
    // Bu endpoint fark bilgisini Claude'a iletmek için gerekli veriyi döner
    res.json({
      updated:         true,
      content_changed: true,
      revision_needed: true,
      message:         'Master plan güncellendi. Revizyon gerekiyor.',
      revision_instructions: {
        priority_files: ['CORE.md', 'AI_AGENT.md'],
        all_files_may_be_affected: true,
        instruction:
          'Claude\'a yeni master planı ver. ' +
          'CORE.md ve AI_AGENT.md değişti mi analiz et. ' +
          'Değiştiyse sadece değişen bölümleri revize et. ' +
          'Etkilenen diğer dosyaları tespit et ve kullanıcıya bildir.',
      },
    })

  } catch (err: any) {
    console.error('[projectRouter/masterplan] Hata:', err.message)
    res.status(500).json({ error: 'Master plan güncellenemedi.', detail: err.message })
  }
})

export default router
