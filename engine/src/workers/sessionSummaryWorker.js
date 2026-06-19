import { supabase } from "../lib/supabase.js";
import { claudeClient } from "../lib/claude.js";
import { embedSingle } from "../memory/voyageClient.js";
export async function runSessionClose(input) {
    try {
        const decisions = await extractSessionDecisions(input.conversationLog);
        const patterns = await extractCodePatterns(input.conversationLog);
        await updateUnresolvedThreads(input.projectId, input.sessionId, input.conversationLog);
        await updatePreferences(input.projectId, input.conversationLog);
        // M-3: Session boyunca yazılan karar event'lerini çek
        const decisionEvents = await fetchSessionDecisionEvents(input.projectId, input.sessionId);
        const summary = await generateSessionNarrative(input.conversationLog, decisionEvents);
        const summaryEmbedding = await embedSingle(summary, "document");
        await supabase.from("memory_chunks").insert({
            project_id: input.projectId,
            session_id: input.sessionId,
            memory_type: "session_summary",
            content: summary,
            embedding: JSON.stringify(summaryEmbedding),
            metadata: {
                decisions_count: decisions.length,
                patterns_count: patterns.length,
                files_edited: input.filesEdited,
                // M-3: Karar istatistikleri
                decision_events_count: decisionEvents.length,
                approved_count: decisionEvents.filter((e) => e.metadata?.action === "APPROVE" || e.metadata?.action === "AUTO_APPROVED").length,
                rejected_count: decisionEvents.filter((e) => e.metadata?.action === "REJECT").length,
            },
        });
        await supabase
            .from("dev_sessions")
            .update({ ended_at: new Date().toISOString(), summary })
            .eq("id", input.sessionId);
        for (const file of input.filesEdited) {
            await supabase.from("re_embed_queue").insert({
                project_id: input.projectId,
                file_path: file,
                reason: "session_edit",
                priority: 3,
            });
        }
        console.log(`Session ${input.sessionId} kapatıldı. Karar event'leri: ${decisionEvents.length}`);
    }
    catch (err) {
        console.error("Session close hata:", err);
    }
}
// M-3: Session başından beri yazılan decision_event chunk'larını getir
async function fetchSessionDecisionEvents(projectId, sessionId) {
    const { data: session } = await supabase
        .from("dev_sessions")
        .select("started_at")
        .eq("id", sessionId)
        .single();
    if (!session?.started_at)
        return [];
    const { data } = await supabase
        .from("memory_chunks")
        .select("content, metadata")
        .eq("project_id", projectId)
        .eq("memory_type", "decision_event")
        .gte("created_at", session.started_at)
        .order("created_at", { ascending: true });
    return data || [];
}
async function extractSessionDecisions(log) {
    if (!process.env.ANTHROPIC_API_KEY)
        return [];
    const recentLog = log.slice(-20).map((m) => `${m.role}: ${m.content}`).join("\n");
    const response = await claudeClient.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        messages: [{ role: "user", content: `Bu geliştirme oturumunda alınan mimari kararları listele. Sadece spesifik teknik kararlar. Format: Her karar "- " ile başlasın.\n\n${recentLog}` }],
    });
    return response.content[0].text.split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.replace("- ", ""));
}
async function extractCodePatterns(log) {
    return [];
}
// M-3: decisionEvents parametresi eklendi
async function generateSessionNarrative(log, decisionEvents = []) {
    if (!process.env.ANTHROPIC_API_KEY) {
        return `Session ${new Date().toISOString()} — ${log.length} mesaj.`;
    }
    const recentLog = log.slice(-30).map((m) => `${m.role}: ${m.content}`).join("\n\n");
    // Karar event'lerini özet olarak hazırla
    let decisionSummary = "";
    if (decisionEvents.length > 0) {
        const lines = decisionEvents.map((e) => {
            const action = e.metadata?.action ?? "?";
            const file = e.metadata?.file_path ?? "?";
            const risk = e.metadata?.risk_score ?? 0;
            return `  - ${action} | ${file} | risk:${risk}`;
        });
        decisionSummary = `\nBu session'da alınan kararlar (${decisionEvents.length} adet):\n${lines.join("\n")}`;
    }
    const response = await claudeClient.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 350,
        messages: [{
                role: "user",
                content: `Bu geliştirme oturumunun 3-4 cümlelik özeti:\n- Ne üzerinde çalışıldı?\n- Hangi dosyalar değiştirildi?\n- Ne tamamlandı, ne bırakıldı?\n- Önemli onay/red kararları var mıydı?${decisionSummary}\n\n${recentLog}\n\nÖzet:`,
            }],
    });
    return response.content[0].text;
}
async function updateUnresolvedThreads(projectId, sessionId, log) {
    if (!process.env.ANTHROPIC_API_KEY)
        return;
    const recentLog = log.slice(-20).map((m) => `${m.role}: ${m.content}`).join("\n");
    const response = await claudeClient.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: `Bu oturumda bitirilen ve yeni açılan işleri listele.\nFormat JSON:\n{"completed": ["..."], "new_unresolved": [{"summary": "...", "file": "src/...", "confidence": 0.9}]}\nSadece JSON döndür:\n\n${recentLog}` }],
    });
    try {
        const parsed = JSON.parse(response.content[0].text.replace(/```json|```/g, "").trim());
        for (const completed of parsed.completed || []) {
            await invalidateResolvedThread(projectId, completed);
        }
        for (const thread of parsed.new_unresolved || []) {
            const embedding = await embedSingle(thread.summary, "document");
            await supabase.from("memory_chunks").insert({
                project_id: projectId,
                session_id: sessionId,
                memory_type: "unresolved",
                content: thread.summary,
                embedding: JSON.stringify(embedding),
                source_path: thread.file,
                confidence: thread.confidence,
                metadata: { detected_in_session: sessionId },
            });
        }
    }
    catch { }
}
async function updatePreferences(projectId, log) {
    if (!process.env.ANTHROPIC_API_KEY)
        return;
    const recentLog = log.slice(-15).map((m) => `${m.role}: ${m.content}`).join("\n");
    const response = await claudeClient.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [{ role: "user", content: `Bu oturumda gözlemlenen developer tercihleri (naming, pattern, stil):\nFormat JSON: {"naming": "...", "patterns": ["..."], "style": ["..."]}\nYoksa boş obje. Sadece JSON:\n\n${recentLog}` }],
    });
    try {
        const prefs = JSON.parse(response.content[0].text.replace(/```json|```/g, "").trim());
        if (Object.keys(prefs).length > 0) {
            await supabase.from("memory_chunks").insert({
                project_id: projectId,
                memory_type: "preference",
                content: JSON.stringify(prefs),
                metadata: { type: "developer_preferences", ...prefs },
            });
        }
    }
    catch { }
}
async function invalidateResolvedThread(projectId, summary) {
    const { data } = await supabase
        .from("memory_chunks")
        .select("id")
        .eq("project_id", projectId)
        .eq("memory_type", "unresolved")
        .eq("is_invalidated", false)
        .ilike("content", `%${summary.slice(0, 30)}%`)
        .limit(1);
    if (data?.[0]) {
        await supabase.from("memory_chunks").update({ is_invalidated: true }).eq("id", data[0].id);
    }
}
//# sourceMappingURL=sessionSummaryWorker.js.map