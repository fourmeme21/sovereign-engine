import { ASTParser } from "./astParser.js";
import { generateChunkDescription, generateFileLevelSummary } from "./descriptionGenerator.js";
import { embedTexts, contentHash } from "./voyageClient.js";
import { supabase } from "../lib/supabase.js";
import { generateSemanticDiff } from "./diffEngine.js";
import { v4 as uuid } from "uuid";
const parser = new ASTParser();
export async function processFileUpload(projectId, filePath, fileContent, commitSha, branch = "main", beforeContent, traceId) {
    const resolvedTraceId = traceId ?? uuid();
    if (isTestOrFallback(filePath)) {
        return { chunksCreated: 0, chunksSkipped: 0, tokenCost: 0, traceId: resolvedTraceId, riskScore: 0, semanticDiffId: null };
    }
    let chunksCreated = 0;
    let chunksSkipped = 0;
    let totalTokenCost = 0;
    const astChunks = parser.parse(fileContent, filePath);
    const fileSummary = await generateFileLevelSummary(filePath, fileContent, astChunks);
    const fileHash = contentHash(fileSummary);
    const existingFile = await findExistingChunk(projectId, filePath, "architecture");
    if (existingFile?.metadata?.content_hash !== fileHash) {
        const [fileEmbedResult] = await embedTexts([fileSummary], "document");
        totalTokenCost += fileEmbedResult.tokenCount;
        await upsertChunk({
            projectId,
            commitSha,
            branch,
            memoryType: "architecture",
            content: fileSummary,
            sourcePath: filePath,
            embedding: fileEmbedResult.embedding,
            metadata: { level: 1, content_hash: fileHash },
        });
        chunksCreated++;
    }
    else {
        chunksSkipped++;
    }
    const descriptions = [];
    for (const chunk of astChunks) {
        const desc = await generateChunkDescription(chunk);
        descriptions.push(desc);
    }
    if (descriptions.length > 0) {
        const embedResults = await embedTexts(descriptions, "document");
        totalTokenCost += embedResults.reduce((s, r) => s + r.tokenCount, 0);
        for (let i = 0; i < astChunks.length; i++) {
            const chunk = astChunks[i];
            const chunkHash = contentHash(descriptions[i]);
            const existing = await findExistingChunk(projectId, filePath, "code_semantic", chunk.name);
            if (existing?.metadata?.content_hash !== chunkHash) {
                await upsertChunk({
                    projectId,
                    commitSha,
                    branch,
                    memoryType: "code_semantic",
                    content: descriptions[i],
                    sourcePath: filePath,
                    embedding: embedResults[i].embedding,
                    metadata: {
                        level: 2,
                        entity_name: chunk.name,
                        entity_type: chunk.type,
                        start_line: chunk.startLine,
                        end_line: chunk.endLine,
                        has_todo: chunk.hasToDoFixMe,
                        content_hash: chunkHash,
                    },
                });
                chunksCreated++;
            }
            else {
                chunksSkipped++;
            }
        }
    }
    // ── Semantik diff pipeline ───────────────────────────────────────────────
    let riskScore = 0;
    let semanticDiffId = null;
    if (beforeContent !== undefined) {
        const diff = generateSemanticDiff(projectId, filePath, beforeContent, fileContent, {
            commitSha: commitSha ?? undefined,
            branch,
            traceId: resolvedTraceId,
        });
        riskScore = diff.risk_score;
        semanticDiffId = diff.id;
        await supabase.from("semantic_diffs").insert({
            id: diff.id,
            project_id: diff.project_id,
            file_path: diff.file_path,
            commit_sha: diff.commit_sha,
            branch: diff.branch,
            lines_added: diff.lines_added,
            lines_removed: diff.lines_removed,
            net_change: diff.net_change,
            symbols_added: diff.symbols_added,
            symbols_removed: diff.symbols_removed,
            symbols_modified: diff.symbols_modified,
            imports_added: diff.imports_added,
            imports_removed: diff.imports_removed,
            risk_factors: diff.risk_factors,
            risk_score: diff.risk_score,
            trace_id: diff.trace_id,
            generated_at: diff.generated_at,
        });
        if (riskScore >= 4) {
            const summary = [
                `Dosya: ${diff.file_path} | Risk: ${riskScore}/10`,
                diff.symbols_removed.length ? `Silinen: ${diff.symbols_removed.map(s => s.name).join(", ")}` : null,
                diff.symbols_modified.length ? `Değişen: ${diff.symbols_modified.map(s => s.name).join(", ")}` : null,
            ].filter(Boolean).join(" | ");
            await upsertChunk({
                projectId,
                commitSha,
                branch,
                memoryType: "git_diff",
                content: summary,
                sourcePath: filePath,
                metadata: {
                    diff_id: diff.id,
                    risk_score: riskScore,
                    risk_factors: diff.risk_factors,
                    heat_score: riskScore / 10,
                    trace_id: resolvedTraceId,
                },
            });
        }
        if (riskScore >= 7) {
            void (async () => {
                try {
                    const res = await fetch("https://api.anthropic.com/v1/messages", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            model: "claude-haiku-4-5-20251001",
                            max_tokens: 256,
                            messages: [{
                                    role: "user",
                                    content: `Aşağıdaki kod değişikliğini Türkçe, 2-3 cümleyle özetle. Risk neden yüksek?\n\nDosya: ${diff.file_path}\nRisk: ${riskScore}/10\nSilinen: ${diff.symbols_removed.map(s => s.name).join(", ") || "yok"}\nDeğişen: ${diff.symbols_modified.map(s => s.name).join(", ") || "yok"}\nFaktörler: ${JSON.stringify(diff.risk_factors)}`,
                                }],
                        }),
                    });
                    const data = await res.json();
                    const text = data.content?.[0]?.text;
                    if (text) {
                        await supabase.from("semantic_diffs").update({ semantic_summary: text }).eq("id", diff.id);
                    }
                }
                catch (err) {
                    console.error(`[LLM enrichment] trace=${resolvedTraceId}`, err);
                }
            })();
        }
    }
    // ────────────────────────────────────────────────────────────────────────
    return { chunksCreated, chunksSkipped, tokenCost: totalTokenCost, traceId: resolvedTraceId, riskScore, semanticDiffId };
}
function isTestOrFallback(filePath) {
    return [".test.", ".spec.", "__tests__", "__mocks__", "fallback"].some((e) => filePath.includes(e));
}
async function findExistingChunk(projectId, sourcePath, memoryType, entityName) {
    let query = supabase
        .from("memory_chunks")
        .select("id, metadata")
        .eq("project_id", projectId)
        .eq("source_path", sourcePath)
        .eq("memory_type", memoryType)
        .eq("is_invalidated", false);
    if (entityName) {
        query = query.eq("metadata->>entity_name", entityName);
    }
    const { data } = await query.single();
    return data;
}
async function upsertChunk(params) {
    await supabase.from("memory_chunks").insert({
        project_id: params.projectId,
        commit_sha: params.commitSha,
        memory_type: params.memoryType,
        content: params.content,
        embedding: params.embedding ? JSON.stringify(params.embedding) : null,
        source_path: params.sourcePath,
        branch: params.branch,
        metadata: params.metadata,
    });
}
//# sourceMappingURL=chunkPipeline.js.map