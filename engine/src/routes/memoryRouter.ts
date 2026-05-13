import express from "express";
import { supabase } from "../lib/supabase.js";
import { processFileUpload } from "../memory/chunkPipeline.js";
import { embedSingle } from "../memory/voyageClient.js";
import { runSessionClose } from "../workers/sessionSummaryWorker.js";
import { createTrace, advanceTrace } from "../lib/traceContext.js";
import { writeAudit } from "../lib/auditWriter.js";
import { evaluateDiffPolicy } from "../policy/policyWithDiff.js";

const router = express.Router();

router.post("/upload", async (req, res) => {
  const { project_id, file_name, content, commit_sha, branch = "main" } = req.body;
  if (!project_id || !file_name || !content)
    return res.status(400).json({ error: "project_id, file_name, content zorunlu" });

  // Trace başlat
  const trace = createTrace(project_id);

  try {
    // 1. Chunk pipeline
    const result = await processFileUpload(
      project_id,
      file_name,
      content,
      commit_sha,
      branch,
      undefined,          // beforeContent — direkt upload'da yok, webhook'tan gelir
      trace.trace_id,     // traceId pipeline boyunca taşınır
    );

    // 2. Diff varsa policy değerlendir
    let policyResult = {
      verdict: "PERMIT" as const,
      reason: "Diff üretilemedi — doğrudan upload",
      policy_id: "POL-000",
      requires_human: false,
    };

    if (result.semanticDiffId) {
      const advancedTrace = advanceTrace(trace, "DIFF_GENERATED");

      // Diff'i DB'den çek (policyWithDiff SemanticDiff objesi bekliyor)
      const { data: diff } = await supabase
        .from("semantic_diffs")
        .select("*")
        .eq("id", result.semanticDiffId)
        .single();

      if (diff) {
        const policyTrace = advanceTrace(advancedTrace, "POLICY_EVALUATED");
        policyResult = await evaluateDiffPolicy(diff, project_id);

        // 3. Audit yaz
        await writeAudit(policyTrace, {
          stage: "POLICY_EVALUATED",
          decision: policyResult.verdict,
          reason: policyResult.reason,
          diff_id: diff.id,
          risk_score: diff.risk_score,
          metadata: { file: file_name, policy_id: policyResult.policy_id },
        });
      }
    }

    res.json({
      success: true,
      file: file_name,
      chunks_created: result.chunksCreated,
      chunks_skipped: result.chunksSkipped,
      estimated_token_cost: result.tokenCost,
      // Yeni alanlar (18B):
      trace_id: trace.trace_id,
      risk_score: result.riskScore,
      policy_verdict: policyResult.verdict,
      policy_reason: policyResult.reason,
      requires_human: policyResult.requires_human,
    });

  } catch (err: any) {
    await writeAudit(trace, {
      stage: "REQUEST_RECEIVED",
      decision: "DENY",
      reason: err.message,
    });
    res.status(500).json({ error: err.message, trace_id: trace.trace_id });
  }
});

router.post("/query", async (req, res) => {
  const { project_id, query, top_k = 5, memory_types, branch } = req.body;
  if (!project_id || !query)
    return res.status(400).json({ error: "project_id, query zorunlu" });
  try {
    const queryEmbedding = await embedSingle(query, "query");
    const { data, error } = await supabase.rpc("search_memory", {
      p_query_embedding: JSON.stringify(queryEmbedding),
      p_project_id: project_id,
      p_top_k: top_k,
      p_memory_types: memory_types || null,
      p_branch: branch || null,
    });
    if (error) throw error;
    if (data?.length) {
      await supabase.rpc("increment_reference_counts", { chunk_ids: data.map((r: any) => r.id) });
    }
    res.json({ results: (data || []).map((row: any) => ({ id: row.id, content: row.content, source_file: row.source_path, memory_type: row.memory_type, similarity: row.similarity, metadata: row.metadata })) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/health/:project_id", async (req, res) => {
  const { project_id } = req.params;
  const { data } = await supabase.from("memory_chunks").select("memory_type, confidence, freshness_score").eq("project_id", project_id).eq("is_invalidated", false);
  const summary = (data || []).reduce((acc: any, row: any) => {
    if (!acc[row.memory_type]) acc[row.memory_type] = { count: 0, avgConfidence: 0, avgFreshness: 0 };
    acc[row.memory_type].count++;
    acc[row.memory_type].avgConfidence += row.confidence;
    acc[row.memory_type].avgFreshness += row.freshness_score;
    return acc;
  }, {});
  Object.keys(summary).forEach((k) => { summary[k].avgConfidence /= summary[k].count; summary[k].avgFreshness /= summary[k].count; });
  res.json({ project_id, memory_health: summary });
});

router.post("/session/open", async (req, res) => {
  const { project_id } = req.body;
  if (!project_id) return res.status(400).json({ error: "project_id zorunlu" });

  const { data: lastSession } = await supabase
    .from("dev_sessions")
    .select("ended_at")
    .eq("project_id", project_id)
    .not("ended_at", "is", null)
    .order("ended_at", { ascending: false })
    .limit(1)
    .single();

  const lastSessionAt = lastSession?.ended_at ? new Date(lastSession.ended_at) : null;

  const { data: newSession } = await supabase
    .from("dev_sessions")
    .insert({ project_id, started_at: new Date().toISOString() })
    .select("id")
    .single();

  const briefing = await generateContinuityBriefing(project_id, lastSessionAt);

  res.json({ session_id: newSession?.id, briefing });
});

router.post("/session/close", async (req, res) => {
  const { session_id, project_id, conversation_log, files_edited } = req.body;
  res.json({ ok: true, message: "Session kapatma başlatıldı." });
  setImmediate(async () => {
    await runSessionClose({
      sessionId: session_id,
      projectId: project_id,
      conversationLog: conversation_log || [],
      filesEdited: files_edited || [],
    });
  });
});

async function generateContinuityBriefing(projectId: string, lastSessionAt: Date | null) {
  const now = new Date();
  const gapDays = lastSessionAt ? Math.floor((now.getTime() - lastSessionAt.getTime()) / (1000 * 60 * 60 * 24)) : 0;

  let gitSummary = "Son sessiondan beri değişiklik yok.";
  if (gapDays > 0 && lastSessionAt) {
    const { data: commits } = await supabase
      .from("commit_index")
      .select("message, semantic_diff_summary")
      .eq("project_id", projectId)
      .gt("timestamp", lastSessionAt.toISOString())
      .order("timestamp", { ascending: false })
      .limit(10);
    if (commits?.length) {
      gitSummary = `${commits.length} commit: ${commits.map((c: any) => c.semantic_diff_summary || c.message).join("; ")}`;
    }
  }

  const { data: threads } = await supabase
    .from("memory_chunks")
    .select("id, content, confidence, source_path")
    .eq("project_id", projectId)
    .eq("memory_type", "unresolved")
    .eq("is_invalidated", false)
    .order("confidence", { ascending: false })
    .limit(5);

  let zones = null;
  try {
    const { data } = await supabase.rpc("get_active_development_zones", {
      p_project_id: projectId,
      p_days: 14,
    });
    zones = data;
  } catch { zones = null; }

  const activeZone = (zones as any)?.[0]?.directory || "Belirlenemedi";

  const { data: decisions } = await supabase
    .from("memory_chunks")
    .select("id, content")
    .eq("project_id", projectId)
    .eq("memory_type", "decision")
    .eq("is_invalidated", false)
    .order("created_at", { ascending: false })
    .limit(3);

  // ── YENİ (18B): Son yüksek riskli değişiklikler ──────────────────────────
  const { data: recentHighRisk } = await supabase
    .from("semantic_diffs")
    .select("file_path, risk_score, risk_factors, symbols_added, symbols_removed, symbols_modified, generated_at, semantic_summary")
    .eq("project_id", projectId)
    .gte("risk_score", 4)
    .order("generated_at", { ascending: false })
    .limit(5);
  // ─────────────────────────────────────────────────────────────────────────

  let suggestedFocus = "Kaldığın yerden devam et.";
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { claudeClient } = await import("../lib/claude.js");
      const response = await claudeClient.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 80,
        messages: [{ role: "user", content: `Proje durumuna göre odaklanılacak en önemli şeyi 1 cümleyle belirt.\nGap: ${gapDays} gün\nGit: ${gitSummary}\nUnresolved: ${(threads || []).map((t: any) => t.content).join(", ")}\nZone: ${activeZone}` }],
      });
      suggestedFocus = (response.content[0] as any).text;
    } catch { }
  }

  return {
    temporal_gap_days: gapDays,
    git_summary: gitSummary,
    unresolved_threads: (threads || []).map((t: any) => ({ id: t.id, summary: t.content, confidence: t.confidence, file: t.source_path })),
    active_zone: activeZone,
    architectural_drift_detected: false,
    recommended_context_files: (zones as any)?.map((z: any) => z.directory) || [],
    last_decision_ids: (decisions || []).map((d: any) => d.id),
    suggested_focus: suggestedFocus,
    // ── YENİ (18B) ──
    recent_risky_changes: (recentHighRisk || []).map((d: any) => ({
      file: d.file_path,
      risk_score: d.risk_score,
      summary: d.semantic_summary || buildQuickSummary(d),
      when: d.generated_at,
    })),
  };
}

function buildQuickSummary(d: any): string {
  const parts: string[] = [];
  if (d.symbols_added?.length)    parts.push(`${d.symbols_added.length} eklendi`);
  if (d.symbols_removed?.length)  parts.push(`${d.symbols_removed.length} silindi`);
  if (d.symbols_modified?.length) parts.push(`${d.symbols_modified.length} değişti`);
  return parts.length ? parts.join(", ") : "değişiklik var";
}

export default router;
