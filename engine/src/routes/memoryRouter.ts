# SOVEREIGN ENGINE — MEMORY SYSTEM SESSION INDEX

> Bu dosya her session başında Claude'a verilir.
> Claude bu dosyadan görevi alır, tamamlananları işaretler, devam eder.

---

## ANLIK DURUM

| Alan | Değer |
|---|---|
| Proje | sovereign-engine |
| Aktif Faz | **FAZ M — Memory System Activation** |
| Genel Durum | 🟡 FAZ M kodları deploy edildi — M-1 kısmen açık |

---

## SİSTEM MİMARİSİ

```
Claude / MCP
    ↓
sovereign-engine (Railway) ← engine/src/memory/
    ↓
Supabase (pgvector) + Voyage AI
    ↓
memory_chunks tablosu
```

**Mevcut çalışan:**
- ✅ Engine (Railway'de ayakta)
- ✅ MCP Sunucusu (Claude köprüsü bağlı)
- ✅ Chunk yazma kodu (`chunkPipeline.ts` yazılmış)
- ✅ Session summary kodu (`sessionSummaryWorker.ts` güncellendi — M-3)
- ✅ GitHub token (bağlandı)
- ✅ `incrementalMemory.ts` yazıldı ve deploy edildi (M-2)
- ✅ `memoryRouter.ts` session başı inject eklendi (M-4)
- ✅ `POST /memory/decision` endpoint aktif (M-2)

**Açık:**
- ⚠️ Sovereign Memory tam yeşile dönmedi — Voyage AI bağlantısı kontrol edilmeli

---

## FAZ M — GÖREV KARTLARI

### M-1 — Railway Env Variables
| Alan | Değer |
|---|---|
| Durum | ⚠️ KISMI — ANTHROPIC_API_KEY eklendi, Memory yeşile dönmedi |
| Dosya | Railway dashboard → sovereign-engine → Variables |
| Risk | YOK — sadece config |

**Yapılan:**
- `ANTHROPIC_API_KEY` set edildi
- Diğer key'ler mevcut

**Kalan:**
- Voyage AI bağlantısı neden yeşile dönmediği araştırılacak

---

### M-2 — Incremental Memory
| Alan | Değer |
|---|---|
| Durum | ✅ TAMAMLANDI — Deploy başarılı |
| Dosya | `engine/src/memory/incrementalMemory.ts` (YENİ) |
| Risk | DÜŞÜK |

**Yapılan:**
- `writeDecisionEvent()` fonksiyonu yazıldı
- Idempotency (trace_id) koruması eklendi
- `AUTO_APPROVED` → `/upload` endpoint'inde otomatik chunk yazıyor
- `POST /memory/decision` → manuel APPROVE/REJECT için endpoint eklendi

---

### M-3 — Session Collector
| Alan | Değer |
|---|---|
| Durum | ✅ TAMAMLANDI — Deploy başarılı |
| Dosya | `engine/src/workers/sessionSummaryWorker.ts` (GÜNCELLENDİ) |
| Risk | DÜŞÜK |

**Yapılan:**
- `fetchSessionDecisionEvents()` eklendi — session başından itibaren karar chunk'larını çeker
- `generateSessionNarrative()` kararları prompt'a dahil ediyor
- Metadata'ya `decision_events_count`, `approved_count`, `rejected_count` eklendi

---

### M-4 — Memory Query Entegrasyonu
| Alan | Değer |
|---|---|
| Durum | ✅ TAMAMLANDI — Deploy başarılı |
| Dosya | `engine/src/routes/memoryRouter.ts` (GÜNCELLENDİ) |
| Risk | DÜŞÜK |

**Yapılan:**
- `generateContinuityBriefing()` içine son 10 `decision_event` chunk sorgusu eklendi
- `/session/open` yanıtına `recent_decisions` alanı eklendi

---

## SIRADAKI GÖREVLER

1. ⚠️ **M-1 takip** — Voyage AI bağlantısı neden yeşile dönmedi araştır
2. 🧪 **FAZ M test** — `POST /memory/decision` endpoint'ini canlıda test et
3. 🔵 **FAZ N** — (tanımlanmadı — FAZ M test sonrası planlanacak)

---

## KRİTİK TEKNİK KARARLAR

| Karar | Sebep |
|---|---|
| B yaklaşımı (incremental) önce | Session sonu özetleme güvenilmez — bağlantı kopabilir, 30 mesaj limiti yetersiz |
| A hafif versiyon B'den sonra | B chunk'larını toplar — Claude'a ham mesaj göndermez, token israfı yok |
| Chunk'a phase/task_card inject | Memory'den geçmiş kararlar çekilince hangi fazda alındığı bilinir |
| memoryRouter session başı inject | Claude her session'da bağlamı manuel okumadan alır |
| Approve/reject endpoint yeni oluşturuldu | github.js'de mevcut değildi — memoryRouter'a eklendi |

---

## AÇIK SORUNLAR

| # | Sorun | Öncelik |
|---|---|---|
| 1 | Sovereign Memory yeşile dönmedi | 🟡 M-1 takip |
| 2 | Memory query `/memory/query` endpoint canlı testi yapılmadı | 🟡 FAZ M test |

---

## SESSION LOG

| Session | Tarih | Konu |
|---|---|---|
| 1 | 2026-05-16 | Sistem analizi. Bağlantı sorunu tespit edildi. GitHub token form eklendi. FAZ M planlandı. |
| 2 | 2026-05-16 | FAZ M kodları yazıldı. M-2 (incrementalMemory.ts), M-3 (sessionSummaryWorker.ts), M-4 (memoryRouter.ts) tamamlandı. Deploy başarılı. |
