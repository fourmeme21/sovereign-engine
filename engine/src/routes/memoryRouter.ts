import express from "express";
import { supabase } from "../lib/supabase.js";
import { processFileUpload } from "../memory/chunkPipeline.js";
import { embedSingle } from "../memory/voyageClient.js";
import { runSessionClose } from "../workers/sessionSummaryWorker.js";

const router = express.Router();

router.post("/upload", async (req, res) => {
  const { project_id, file_name, content, commit_sha, branch = "main" } = req.body;
  if (!project_id || !file_name || !content)
    return res.status(400).json({ error: "project_id, file_name, content zorunlu" });
  try {
    const result = await processFileUpload(project_id, file_name, content, commit_sha, branch);
    res.json({ success: true, file: file_name, chunks_created: result.chunksCreated, chunks_skipped: result.chunksSkipped, estimated_token_cost: result.tokenCost });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

  
  const activeZone = (zones as any)?.[0]?.directory || "Belirlenemedi";
let zones = null;
try {
  const { data } = await supabase.rpc("get_active_development_zones", { p_project_id: projectId, p_days: 14 });
  zones = data;
} catch { zones = null; }
  const { data: decisions } = await supabase
    .from("memory_chunks")
    .select("id, content")
    .eq("project_id", projectId)
    .eq("memory_type", "decision")
    .eq("is_invalidated", false)
    .order("created_at", { ascending: false })
    .limit(3);

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
  };
}

export default router;
