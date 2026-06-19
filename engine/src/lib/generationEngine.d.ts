/**
 * engine/src/lib/generationEngine.ts
 *
 * Generation Engine — ADAPTERv1 Session 7 (v1.1) → Session 18 (memory_chunks)
 *
 * Görev:
 *   Master plan + evrensel şablondan proje dökümanlarını Claude'a ürettirir.
 *   Token paketleme, sıralı üretim, her dosya sonrası Supabase recovery kaydı.
 *
 * Mimari (session_index.md → GENERATION ENGINE MİMARİSİ):
 *   1. /api/project/create → projectRouter → runGeneration() çağrılır (arka plan)
 *   2. ~20k token kapasitesi → dolunca yeni oturum + gerçek bağlam özeti enjeksiyonu
 *   3. Üretim sırası: CORE.md → AI_AGENT.md → ARCHITECTURE.md → ... → projeye özel
 *   4. Her dosya sonrası: project_generation_status güncellenir (Karar #26)
 *   5. CORE + AI_AGENT → user_projects.core_doc / ai_agent_doc (Karar #23)
 *   6. Tüm dosyalar tamam → gen_status = 'completed'
 *
 * v1.1 değişiklikleri (ChatGPT denetim raporu):
 *   KRİTİK-1: Gerçek context zinciri — her dosya sonrası Claude'a özet çıkartılır
 *   KRİTİK-4: Best Effort Mode — tek dosya hatasında süreç durmaz, devam eder
 *   KRİTİK-6: SESSION_TOKEN_CAPACITY 3k → 20k (Sonnet 4 context limiti 200k)
 *   KRİTİK-9: Cost tracking — her dosya için input/output token + maliyet loglanır
 *
 * Session 18:
 *   writeArchitectureMemory() — generation tamamlanınca memory_chunks'a yazar
 *
 * Karar #91 (Session 22):
 *   Dosya döngüsünde kümülatif token sayacı — CONTEXT_REFRESH_THRESHOLD (50k)
 *   aşılınca system prompt yenilenir, sayaç sıfırlanır.
 *
 * Kararlar:
 *   #19: "Adapter" = projeye özel eksiksiz yürütme dokümantasyonu
 *   #20: Evrensel şablon Seçenek B — dolu referans, Claude projeye özel yazar
 *   #21: Master plan formatı serbest
 *   #23: CORE + AI_AGENT → Supabase (plain text şimdilik — TODO: AES-256)
 *   #26: Generation recovery — her dosya sonrası durum kaydedilir
 *   #31: Akıllı paketleme — 20k token kapasitesi, dolunca yeni oturum
 *   #91: Context yenileme — 50k kümülatif token eşiğinde system prompt yenilenir
 *
 * TB-17 değişiklikleri:
 *   DEFAULT_FILE_PLAN'a adapter.ts eklendi (fileOrder: 11)
 *   getFileInstruction() → adapter.ts instruction eklendi (vm.Script uyumlu)
 *   saveToSupabase() → adapter.ts dalı eklendi
 *   extractCategoriesFromAdapter() — 3 katmanlı strateji (XML > array > kaba kuvvet)
 *   fetchProjectMeta() — proje meta bilgisi çeker
 *   upsertAdapter() — user_adapters upsert
 *
 * Dokunma: writeArchitectureMemory() kaldırılırsa TB-2 açılır.
 *          extractFileSummary() ve priorContext zincirine dokunma.
 *          packIntoSessions() SESSION_TOKEN_CAPACITY kilitledi — değiştirme.
 *          CONTEXT_REFRESH_THRESHOLD değeri Karar #91 ile kilitlendi.
 *          extractCategoriesFromAdapter() strateji sırası değiştirme — XML etiketi önce gelir.
 */
export interface GenerationOptions {
    projectId: string;
    userId: string;
    projectName: string;
    masterPlan: string;
    completedFiles?: string[];
    bestEffort?: boolean;
}
interface FileCost {
    fileName: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}
export interface GenerationResult {
    success: boolean;
    status: 'completed' | 'partial_success' | 'failed';
    completedFiles: string[];
    failedFiles: string[];
    totalCostUsd: number;
    fileCosts: FileCost[];
    error?: string;
}
export declare function runGeneration(opts: GenerationOptions): Promise<GenerationResult>;
export declare function resumeGeneration(projectId: string, userId: string, projectName: string, masterPlan: string): Promise<GenerationResult>;
export {};
//# sourceMappingURL=generationEngine.d.ts.map