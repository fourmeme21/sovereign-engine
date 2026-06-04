/**
 * engine/src/types/express.d.ts
 *
 * Express tip genişletmesi — ADAPTERv1 Session 9 (FIX-3)
 *
 * authMiddleware.ts tarafından req.user ve req.userTier set edilir.
 * Bu dosya olmadan tüm route'larda TypeScript derleme hatası alınır.
 *
 * Konum: engine/src/types/express.d.ts
 * tsconfig.json "typeRoots" veya "include" ile kapsanmalı.
 */

import 'express'

declare module 'express-serve-static-core' {
  interface Request {
    /** authMiddleware tarafından JWT'den çözümlenir */
    user?: {
      id:     string
      email?: string
    }
    /** tierGuard.ts tarafından user_profiles.tier'dan set edilir */
    userTier?: string
  }
}
