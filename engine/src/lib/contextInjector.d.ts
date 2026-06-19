/**
 * engine/src/lib/contextInjector.ts
 *
 * Bağlam Enjeksiyon Mekanizması — ADAPTERv1 Session 6
 *
 * Görev:
 *   - CORE.md + AI_AGENT.md + session_index.md'yi Claude'a enjekte eder
 *   - Token bazlı eşik: eşik aşılınca enjeksiyon tetiklenir
 *   - CORE + AI_AGENT bellekte cache'lenir (TTL: 30 dakika)
 *   - session_index her enjeksiyonda hot.json'dan okunur (her zaman taze)
 *   - Kullanıcı enjeksiyonu görmez — system prompt'a gömülür
 *
 * Kararlar (session_index.md):
 *   #23: CORE + AI_AGENT Supabase'de şifreli — uygulama katmanı çözer
 *   Session 6: Token bazlı eşik — mesaj sayısı değil
 *   Session 6: Engine başlangıcında belleğe al, TTL sonra arka planda yenile
 *   Session 7: INJECTION_TOKEN_THRESHOLD 80k → 120k
 *   #91: INJECTION_TOKEN_THRESHOLD 120k → 50k + proaktif enjeksiyon export'u
 *        context_refreshed flag InjectionResult'a eklendi
 *
 * Dokunma: INJECTION_TOKEN_THRESHOLD Karar #91 ile kilitlendi — değiştirme.
 *          checkAndInjectProactive() aiProxy.ts /api/ai/chat handler'ı tarafından
 *          Claude çağrısından ÖNCE çağrılır — sıra değiştirilemez.
 */
export interface InjectionResult {
    injected: boolean;
    system_suffix: string;
    tokens_reset: boolean;
    context_refreshed: boolean;
}
/**
 * Token sayacını döndürür (monitoring için).
 */
export declare function getTokenCount(userId: string, projectId: string): number;
/**
 * /api/ai/chat handler'ında Claude çağrısından ÖNCE çağrılır.
 * Eşik aşıldıysa enjeksiyon içeriğini döner — system prompt'a eklenir.
 * Eşik aşılmadıysa injected=false döner — işlem yapılmaz.
 *
 * @param userId          - Kullanıcı ID (JWT'den)
 * @param projectId       - Aktif proje ID (null ise enjeksiyon yapılmaz)
 * @param localMemoryPath - hot.json konumu (Tauri'den gelir)
 */
export declare function checkAndInjectProactive(userId: string, projectId: string | null, localMemoryPath: string | null): Promise<InjectionResult>;
/**
 * Her /api/ai/chat çağrısından SONRA çağrılır.
 * Token sayacını günceller, eşik aşıldıysa enjeksiyon içeriği döner.
 * Bir sonraki mesajda system prompt'a eklenir.
 *
 * @param userId          - Kullanıcı ID (JWT'den)
 * @param projectId       - Aktif proje ID (null ise enjeksiyon yapılmaz)
 * @param localMemoryPath - hot.json konumu (Tauri'den gelir)
 * @param inputTokens     - API response.usage.input_tokens
 * @param outputTokens    - API response.usage.output_tokens
 */
export declare function checkAndInject(userId: string, projectId: string | null, localMemoryPath: string | null, inputTokens: number, outputTokens: number): Promise<InjectionResult>;
/**
 * Engine başlangıcında çağrılır.
 * Tüm kullanıcıların aktif projelerini belleğe alır.
 */
export declare function preloadProjectCache(): Promise<void>;
export declare function evictProjectCache(projectId: string): void;
//# sourceMappingURL=contextInjector.d.ts.map