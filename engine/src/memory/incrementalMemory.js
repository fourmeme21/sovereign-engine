// engine/src/memory/incrementalMemory.ts
import { supabase } from "../lib/supabase.js";
import { v4 as uuid } from "uuid";
export async function writeDecisionEvent(params) {
    const traceId = params.traceId ?? uuid();
    // Idempotency: aynı trace_id ile tekrar yazma
    try {
        const { data: existing } = await supabase
            .from("memory_chunks")
            .select("id")
            .eq("project_id", params.projectId)
            .eq("memory_type", "decision_event")
            .eq("metadata->>trace_id", traceId)
            .maybeSingle();
        if (existing) {
            console.log(`[incrementalMemory] trace=${traceId} zaten var — atlandı`);
            return;
        }
    }
    catch (err) {
        console.error(`[incrementalMemory] Idempotency kontrolü hatası:`, err);
    }
    const content = `${params.action} | ${params.filePath} | risk:${params.riskScore} | ${params.reason}`;
    const metadata = {
        action: params.action,
        file_path: params.filePath,
        risk_score: params.riskScore,
        trace_id: traceId,
        reason: params.reason,
        timestamp: Date.now(),
        phase: params.phase ?? "unknown",
        task_card: params.taskCard ?? "unknown",
        policy_id: params.policyId ?? null,
    };
    const { error } = await supabase.from("memory_chunks").insert({
        project_id: params.projectId,
        memory_type: "decision_event",
        content,
        source_path: params.filePath,
        embedding: null,
        branch: "main",
        commit_sha: null,
        metadata,
    });
    if (error) {
        console.error(`[incrementalMemory] Yazma hatası trace=${traceId}:`, error);
        throw error;
    }
    console.log(`[incrementalMemory] ✅ ${params.action} | ${params.filePath} | trace=${traceId}`);
}
//# sourceMappingURL=incrementalMemory.js.map