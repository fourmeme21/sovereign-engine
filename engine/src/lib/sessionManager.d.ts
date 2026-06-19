/**
 * engine/src/lib/sessionManager.ts
 *
 * Session Integrity Layer — ADAPTERv1 Session 11 → Session 18 (memory_chunks)
 *
 * Sorun:
 *   session_index.md üretiliyor (generationEngine) ve okunuyor (contextInjector)
 *   ama GÜNCELLEME manuel + reaktif. Crash olursa, sohbet yarım kalırsa,
 *   kullanıcı "güncelle" demezse → bir sonraki session yanlış state'den başlar.
 *
 * Çözüm — 3 katman:
 *   KATMAN 1 — Checkpoint:   Her kritik eylemden sonra hot.json + Supabase'e yaz
 *   KATMAN 2 — Integrity:    Session açılışında "sağlıklı mı?" kontrol et
 *   KATMAN 3 — Auto-close:   N dakika inactivity → otomatik kapat + memory yaz
 *
 * Session 18:
 *   writeSessionSummaryMemory() — closeSession() sonunda memory_chunks'a yazar
 *
 * Entegrasyon noktaları:
 *   aiProxy.ts  → openSession() / checkpoint() / touchActivity()
 *   contextInjector.ts → dokunulmaz (single responsibility korunur)
 *   generationEngine.ts → dokunulmaz
 *
 * DB:
 *   project_sessions tablosu (migration: 20260605000002_add_project_sessions.sql)
 *   memory_chunks tablosu (migration: 20260606000003_memory_chunks_user_id_rls_hnsw.sql)
 *
 * Dokunma: writeSessionSummaryMemory() kaldırılırsa TB-2 açılır.
 *          INACTIVITY_TIMEOUT_MS ve CHECKPOINT_DEBOUNCE_MS production kalibrasyon değerleri.
 */
export interface SessionCheckpoint {
    last_task: string;
    last_action: string;
    completed_files?: string[];
    session_index_hash?: string;
    custom?: Record<string, unknown>;
}
export interface SessionRecord {
    id: string;
    project_id: string;
    user_id: string;
    opened_at: string;
    closed_at: string | null;
    last_checkpoint_at: string | null;
    integrity_status: 'healthy' | 'dirty' | 'recovered';
    close_reason: string | null;
    checkpoint_data: SessionCheckpoint;
}
export interface IntegrityCheckResult {
    healthy: boolean;
    recovered: boolean;
    session_id: string | null;
    message: string;
    checkpoint?: SessionCheckpoint;
}
export declare function checkIntegrity(userId: string, projectId: string, localMemoryPath: string | null): Promise<IntegrityCheckResult>;
export declare function openSession(userId: string, projectId: string): Promise<string>;
export declare function checkpoint(userId: string, projectId: string, data: SessionCheckpoint, localMemoryPath: string | null): Promise<void>;
export declare function touchActivity(userId: string, projectId: string, localMemoryPath: string | null): void;
export declare function closeSession(userId: string, projectId: string, reason: "normal" | "timeout" | "crash_recovery" | undefined, localMemoryPath: string | null): Promise<void>;
export declare function getActiveSessionId(userId: string, projectId: string): string | null;
export declare function markOrphanSessions(): Promise<void>;
//# sourceMappingURL=sessionManager.d.ts.map