/**
 * engine/src/routes/projectRouter.ts
 *
 * Project Setup Engine — ADAPTERv1 Session 6 / Session 7 güncelleme
 *
 * Endpoint'ler:
 *   POST   /api/project/create          → Yeni proje + generation başlat
 *   GET    /api/project/list            → ProjectDrawer için proje listesi (TB-18)
 *   GET    /api/project                 → Kullanıcının projeleri (tam detay)
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
 *   #56: useActiveProject hook — ProjectDrawer /api/project/list endpoint'ine bağımlı
 *
 * Session 7 değişiklikleri:
 *   - generationEngine import edildi
 *   - /create → runGeneration() arka planda tetikleniyor
 *   - /status → ?resume=true query parametresiyle recovery tetikleniyor
 *
 * Session 38 değişiklikleri (TB-18):
 *   - GET /api/project/list eklendi — ProjectDrawer için minimal proje listesi
 *   - ⚠️ /list route'u /:id route'larından ÖNCE tanımlanmalı (Express sıralı eşleşir)
 *
 * Session 38 kalite düzeltmeleri:
 *   - SSC-3: isValidUuid() ile tüm :id path param'ları doğrulanıyor
 *   - SSC-4: (data as any) yerine Pick<ProjectRow, ...> tip türleri kullanılıyor
 *   - SSC-5: err.message response'dan kaldırıldı — sunucu logunda kalıyor
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=projectRouter.d.ts.map