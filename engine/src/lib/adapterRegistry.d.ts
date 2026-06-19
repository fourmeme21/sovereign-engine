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
export interface AdapterRecord {
    id: string;
    user_id: string;
    adapter_name: string;
    adapter_code: string;
    categories: string[];
    version: string;
    is_active: boolean;
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
/**
 * Kullanıcının aktif adapter'larını yükler, categories map'i döner.
 *
 * @param userId  - JWT'den çözümlenen kullanıcı ID
 * @param tier    - Kullanıcının tier'ı (user_profiles.tier)
 */
export declare function loadRegistry(userId: string, tier: string): Promise<RegistryResult>;
/**
 * Gelen Decision category'sini registry ile eşleştirir.
 *
 * Karar #4: Categories dışı mesaj sohbettir — adapter çağrılmaz.
 *
 * @param category - Decision.category (örn: "WRITE_RESOURCE")
 * @param registry - loadRegistry() çıktısı
 */
export declare function matchCategory(category: string, registry: RegistryResult): CategoryMatch;
/**
 * Yeni adapter kaydeder. Tier limiti aşıldıysa hata fırlatır.
 *
 * @param userId      - Kullanıcı ID
 * @param tier        - Kullanıcı tier'ı
 * @param adapterName - Unique adapter adı
 * @param adapterCode - adapter.ts kaynak kodu
 * @param categories  - Desteklenen kategoriler
 */
export declare function registerAdapter(userId: string, tier: string, adapterName: string, adapterCode: string, categories: string[]): Promise<AdapterRecord>;
export declare function buildSessionSummary(registry: RegistryResult): string;
//# sourceMappingURL=adapterRegistry.d.ts.map