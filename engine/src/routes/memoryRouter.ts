import express from "express";
import { supabase } from "../lib/supabase";
import { processFileUpload } from "../memory/chunkPipeline";
import { embedSingle } from "../memory/voyageClient";

const router = express.Router();

router.post("/upload", async (req, res) => {
  const { project_id, file_name, content, commit_sha, branch = "main" } = req.body;

  if (!project_id || !file_name || !content) {
    return res.status(400).json({ error: "project_id, file_name, content zorunlu" });
  }

  try {
    const result = await processFileUpload(
      project_id, file_name, content, commit_sha, branch
    );
    res.json({
      success: true,
      file: file_name,
      chunks_created: result.chunksCreated,
      chunks_skipped: result.chunksSkipped,
      estimated_token_cost: result.tokenCost,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/query", async (req, res) => {
  const { project_id, query, top_k = 5, memory_types, branch } = req.body;

  if (!project_id || !query) {
    return res.status(400).json({ error: "project_id, query zorunlu" });
  }

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
      const ids = data.map((r: any) => r.id);
      await supabase.rpc("increment_reference_counts", { chunk_ids: ids });
    }

    res.json({
      results: (data || []).map((row: any) => ({
        id: row.id,
        content: row.content,
        source_file: row.source_path,
        memory_type: row.memory_type,
        similarity: row.similarity,
        metadata: row.metadata,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/health/:project_id", async (req, res) => {
  const { project_id } = req.params;

  const { data } = await supabase
    .from("memory_chunks")
    .select("memory_type, confidence, freshness_score")
    .eq("project_id", project_id)
    .eq("is_invalidated", false);

  const summary = (data || []).reduce((acc: any, row: any) => {
    if (!acc[row.memory_type]) acc[row.memory_type] = { count: 0, avgConfidence: 0, avgFreshness: 0 };
    acc[row.memory_type].count++;
    acc[row.memory_type].avgConfidence += row.confidence;
    acc[row.memory_type].avgFreshness += row.freshness_score;
    return acc;
  }, {});

  Object.keys(summary).forEach((k) => {
    summary[k].avgConfidence /= summary[k].count;
    summary[k].avgFreshness /= summary[k].count;
  });

  res.json({ project_id, memory_health: summary });
});

export default router;
