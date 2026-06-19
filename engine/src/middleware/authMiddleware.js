// engine/src/middleware/authMiddleware.ts
// Phase B — Task B.1
// Authorization: Bearer <supabase_jwt> → req.user inject
import { supabase } from '../lib/supabase.js';
export async function authMiddleware(req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Yetkisiz — Authorization header eksik' });
        return;
    }
    const token = header.slice(7).trim();
    if (!token) {
        res.status(401).json({ error: 'Yetkisiz — token boş' });
        return;
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
        res.status(401).json({ error: 'Yetkisiz — geçersiz token' });
        return;
    }
    req.user = {
        id: data.user.id,
        email: data.user.email,
    };
    next();
}
//# sourceMappingURL=authMiddleware.js.map