/**
 * engine/src/lib/adapterRegistry.ts
 *
 * Adapter Registry — ADAPTERv1 Session 4
 * FIX-2 (Session 9): buildSessionSummary iş dili — Karar #1 uyumu
 *
 * Görev:
 *   - Kullanıcıya ait aktif adapter'ları Supabase'den yükler
 *   - categories map'i üretir: kategori → adapter
 *   - Mesaj gelince kategori tespiti yapar
 *   - Tier limiti aşıldıysa yüklemeyi reddeder
 *   - FP-U1: idempotency — aynı session içinde cache'den döner
 *
 * Tier adapter limitleri:
 *   free: 1 | solo: 3 | pro: 10 | team: Infinity
 */

import { supabase } from './supabase.js';

// ─── TİER LİMİTLERİ ──────────────────────────────────────────────────────────

const ADAPTER_LIMITS: Record<string, number> = {
  free: 1,
  solo: 3,
  pro:  10,
  team: Infinity,
};

// ─── TİPLER ──────────────────────────────────────────────────────────────────

export interface AdapterRecord {
  id:           string;
  user_id:      string;
  adapter_name: string;
  adapter_code: string;
  categories:   string[];
  version:      string;
  is_active:    boolean;
}

export interface RegistryResult {
  /** Kategori adı → AdapterRecord */
  categoryMap: Map<string, AdapterRecord>;
  /** Yüklenen adapter sayısı */
  adapterCount: number;
  /** Tier adapter limiti */
  limit: number;
}

export interface CategoryMatch {
  matched: boolean;
  adapter?: AdapterRecord;
  category?: string;
}

// ─── IN-MEMORY SESSION CACHE ─────────────────────────────────────────────────
// FP-U1: Aynı session içinde Supabase'e tekrar gitme.
// TTL: 5 dakika (session boyunca yeterli).

const cache = new Map<string, { result: RegistryResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── REGISTRY YÜKLEYİCİ ─────────────────────────────────────────────────────

/**
 * Kullanıcının aktif adapter'larını yükler, categories map'i döner.
 *
 * @param userId  - JWT'den çözümlenen kullanıcı ID
 * @param tier    - Kullanıcının tier'ı (user_profiles.tier)
 */
export async function loadRegistry(
  userId: string,
  tier: string,
): Promise<RegistryResult> {

  // Cache kontrolü (FP-U1)
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const limit = ADAPTER_LIMITS[tier] ?? 1;

  // Supabase'den aktif adapter'ları çek
  const { data, error } = await supabase
    .from('user_adapters')
    .select('id, user_id, adapter_name, adapter_code, categories, version, is_active')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(limit); // Tier limitini aşanları zaten çekme

  if (error) {
    throw new Error(`AdapterRegistry: Supabase okuma hatası — ${error.message}`);
  }

  const adapters = (data ?? []) as AdapterRecord[];

  // Kategori → adapter map'i oluştur
  const categoryMap = new Map<string, AdapterRecord>();
  for (const adapter of adapters) {
    for (const category of adapter.categories) {
      // İlk adapter kazanır — çakışma durumunda log yaz
      if (categoryMap.has(category)) {
        console.warn(
          `[AdapterRegistry] Kategori çakışması: "${category}" ` +
          `→ "${categoryMap.get(category)!.adapter_name}" ile ` +
          `"${adapter.adapter_name}" çakışıyor. İlk adapter korunuyor.`,
        );
        continue;
      }
      categoryMap.set(category, adapter);
    }
  }

  const result: RegistryResult = {
    categoryMap,
    adapterCount: adapters.length,
    limit,
  };

  // Cache'e yaz
  cache.set(userId, { result, expiresAt: Date.now() + CACHE_TTL_MS });

  return result;
}

// ─── KATEGORİ TESPİTİ ────────────────────────────────────────────────────────

/**
 * Gelen Decision category'sini registry ile eşleştirir.
 *
 * Karar #4: Categories dışı mesaj sohbettir — adapter çağrılmaz.
 *
 * @param category - Decision.category (örn: "WRITE_RESOURCE")
 * @param registry - loadRegistry() çıktısı
 */
export function matchCategory(
  category: string,
  registry: RegistryResult,
): CategoryMatch {
  const adapter = registry.categoryMap.get(category);

  if (!adapter) {
    return { matched: false };
  }

  return {
    matched: true,
    adapter,
    category,
  };
}

// ─── ADAPTER KAYIT ───────────────────────────────────────────────────────────

/**
 * Yeni adapter kaydeder. Tier limiti aşıldıysa hata fırlatır.
 *
 * @param userId      - Kullanıcı ID
 * @param tier        - Kullanıcı tier'ı
 * @param adapterName - Unique adapter adı
 * @param adapterCode - adapter.ts kaynak kodu
 * @param categories  - Desteklenen kategoriler
 */
export async function registerAdapter(
  userId:      string,
  tier:        string,
  adapterName: string,
  adapterCode: string,
  categories:  string[],
): Promise<AdapterRecord> {

  const limit = ADAPTER_LIMITS[tier] ?? 1;

  // Mevcut adapter sayısını kontrol et
  const { count, error: countError } = await supabase
    .from('user_adapters')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_active', true);

  if (countError) {
    throw new Error(`AdapterRegistry: Sayım hatası — ${countError.message}`);
  }

  if ((count ?? 0) >= limit) {
    throw new Error(
      `Tier limiti aşıldı: ${tier} planı en fazla ${limit} adapter destekler. ` +
      `Planını yükselt: /api/billing/upgrade`,
    );
  }

  // Category formatı doğrula: /^[A-Z_]+$/
  const categoryPattern = /^[A-Z_]+$/;
  for (const cat of categories) {
    if (!categoryPattern.test(cat)) {
      throw new Error(`Geçersiz kategori formatı: "${cat}" — sadece büyük harf ve alt çizgi.`);
    }
  }

  const { data, error } = await supabase
    .from('user_adapters')
    .insert({
      user_id:      userId,
      adapter_name: adapterName,
      adapter_code: adapterCode,
      categories,
      version:      '1.0.0',
      is_active:    true,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`AdapterRegistry: Kayıt hatası — ${error.message}`);
  }

  // Cache'i temizle — yeni adapter yüklendi
  cache.delete(userId);

  return data as AdapterRecord;
}

// ─── SESSION BAŞI ÖZET ────────────────────────────────────────────────────────

/**
 * Session başında kullanıcıya gösterilecek iş dili özeti üretir.
 *
 * Karar #1: Adapter kullanıcıya gösterilmez — etkileri iş diliyle gösterilir.
 * FIX-2 (Session 9): Adapter adı + teknik kategori kaldırıldı — iş dili etiketleri eklendi.
 *
 * TODO (v1.2): user_adapters tablosuna human_label kolonu eklenince
 *              CATEGORY_LABELS sabit map'i kaldırılabilir — adapter kendisi tanımlar.
 *
 * Örnek çıktı:
 *   "Bu session'da şu kararlar alınabilir:
 *    - Kayıt oluşturma ve güncelleme
 *    - Kayıt silme"
 */

// Teknik kategori → iş dili etiket haritası
// Bilinmeyen kategori için fallback: kategori adının kendisi gösterilir.
const CATEGORY_LABELS: Record<string, string> = {
  WRITE_RESOURCE:  'Kayıt oluşturma ve güncelleme',
  DELETE_RESOURCE: 'Kayıt silme',
  READ_RESOURCE:   'Kayıt okuma',
  APPROVE:         'Onay verme',
  REJECT:          'Reddetme',
  ASSIGN:          'Atama yapma',
  NOTIFY:          'Bildirim gönderme',
  SCHEDULE:        'Zamanlama ve planlama',
  TRANSFER:        'Transfer işlemi',
  CALCULATE:       'Hesaplama',
  EXPORT:          'Dışa aktarma',
  IMPORT:          'İçe aktarma',
};

export function buildSessionSummary(registry: RegistryResult): string {
  if (registry.adapterCount === 0) {
    return 'Henüz adapter tanımlanmamış — master planını yaz, sistem otomatik kurar.';
  }

  const lines: string[] = ['Bu session\'da şu kararlar alınabilir:'];

  for (const [category] of registry.categoryMap) {
    const label = CATEGORY_LABELS[category] ?? category;
    lines.push(`  - ${label}`);
  }

  return lines.join('\n');
}
