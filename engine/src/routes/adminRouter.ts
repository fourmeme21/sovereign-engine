// engine/src/routes/adminRouter.ts
// Phase F — Waitlist davet akışı

import express from "express";
import { supabase } from "../lib/supabase.js";

const router = express.Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sovereign";

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const pass = req.headers["x-admin-password"];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: "Yetkisiz" });
  next();
}

// POST /admin/invite — waitlist kullanıcısına davet emaili gönder
router.post("/invite", adminAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email zorunlu" });

  // Supabase admin davet
  const { data, error } = await (supabase.auth as any).admin.inviteUserByEmail(email);
  if (error) return res.status(500).json({ error: error.message });

  // waitlist tablosunda invited_at güncelle
  await supabase
    .from("waitlist")
    .update({ invited_at: new Date().toISOString() })
    .eq("email", email);

  res.json({ success: true, user_id: data?.user?.id, email });
});

// GET /admin/waitlist — tüm waitlist kayıtlarını getir
router.get("/waitlist", adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("waitlist")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ waitlist: data });
});

export default router;
