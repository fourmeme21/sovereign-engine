// engine/src/routes/userRouter.ts
// R-2 — GDPR veri silme
// DELETE /api/user/data
// ADAPTERv1 Session 8

import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { supabase } from '../lib/supabase.js'

const router = Router()

router.delete(
  '/data',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id
    const errors: string[] = []

    // --- 1. audit_logs ---
    const { error: e1 } = await supabase
      .from('audit_logs')
      .delete()
      .eq('user_id', userId)
    if (e1) errors.push(`audit_logs: ${e1.message}`)

    // --- 2. decisions ---
    const { error: e2 } = await supabase
      .from('decisions')
      .delete()
      .eq('user_id', userId)
    if (e2) errors.push(`decisions: ${e2.message}`)

    // --- 3. memory_entries ---
    const { error: e3 } = await supabase
      .from('memory_entries')
      .delete()
      .eq('user_id', userId)
    if (e3) errors.push(`memory_entries: ${e3.message}`)

    // --- 4. user_adapters ---
    const { error: e4 } = await supabase
      .from('user_adapters')
      .delete()
      .eq('user_id', userId)
    if (e4) errors.push(`user_adapters: ${e4.message}`)

    // --- 5. sessions ---
    const { error: e5 } = await supabase
      .from('sessions')
      .delete()
      .eq('user_id', userId)
    if (e5) errors.push(`sessions: ${e5.message}`)

    // --- 6. projects (cascade: memory_chunks, dev_sessions, project_generation_status) ---
    const { data: userProjects, error: e6a } = await supabase
      .from('projects')
      .select('id')
      .eq('user_id', userId)

    if (e6a) {
      errors.push(`projects_select: ${e6a.message}`)
    } else if (userProjects && userProjects.length > 0) {
      const projectIds = userProjects.map((p) => p.id)

      // memory_chunks
      const { error: e6b } = await supabase
        .from('memory_chunks')
        .delete()
        .in('project_id', projectIds)
      if (e6b) errors.push(`memory_chunks: ${e6b.message}`)

      // dev_sessions
      const { error: e6c } = await supabase
        .from('dev_sessions')
        .delete()
        .in('project_id', projectIds)
      if (e6c) errors.push(`dev_sessions: ${e6c.message}`)

      // project_generation_status
      const { error: e6d } = await supabase
        .from('project_generation_status')
        .delete()
        .in('project_id', projectIds)
      if (e6d) errors.push(`project_generation_status: ${e6d.message}`)

      // projects (son)
      const { error: e6e } = await supabase
        .from('projects')
        .delete()
        .eq('user_id', userId)
      if (e6e) errors.push(`projects: ${e6e.message}`)
    }

    // --- 7. user_projects ---
    const { error: e7 } = await supabase
      .from('user_projects')
      .delete()
      .eq('user_id', userId)
    if (e7) errors.push(`user_projects: ${e7.message}`)

    // --- 8. user_profiles ---
    const { error: e8 } = await supabase
      .from('user_profiles')
      .delete()
      .eq('user_id', userId)
    if (e8) errors.push(`user_profiles: ${e8.message}`)

    // --- Sonuç ---
    if (errors.length > 0) {
      res.status(207).json({
        status:  'partial',
        message: 'Bazı veriler silinemedi',
        errors,
      })
      return
    }

    res.status(200).json({
      status:  'ok',
      message: 'Tüm veriler silindi',
    })
  }
)

export default router
