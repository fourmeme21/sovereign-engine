import { ASTParser } from "./astParser";
import { generateChunkDescription, generateFileLevelSummary } from "./descriptionGenerator";
import { embedTexts, contentHash } from "./voyageClient";
import { supabase } from "../lib/supabase";

const parser = new ASTParser();

export interface UploadResult {
  chunksCreated: number;
  chunksSkipped: number;
  tokenCost: number;
}

export async function processFileUpload(
  projectId: string,
  filePath: string,
  fileContent: string,
  commitSha: string | null,
  branch: string = "main"
): Promise<UploadResult> {
  if (isTestOrFallback(filePath)) {
    return { chunksCreated: 0, chunksSkipped: 0, tokenCost: 0 };
  }

  let chunksCreated = 0;
  let chunksSkipped = 0;
  let totalTokenCost = 0;

  const astChunks = parser.parse(fileContent, filePath);
  const fileSummary = await generateFileLevelSummary(filePath, fileContent, astChunks);
  const fileHash = contentHash(fileSummary);
  const existingFile = await findExistingChunk(projectId, filePath, "architecture");

  if (existingFile?.metadata?.content_hash !== fileHash) {
    await upsertChunk({
      projectId, commitSha, branch,
      memoryType: "architecture",
      content: fileSummary,
      sourcePath: filePath,
      metadata: { level: 1, content_hash: fileHash },
    });
    chunksCreated++;
  } else {
    chunksSkipped++;
  }

  const descriptions: string[] = [];
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
          projectId, commitSha, branch,
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
      } else {
        chunksSkipped++;
      }
    }
  }

  return { chunksCreated, chunksSkipped, tokenCost: totalTokenCost };
}

function isTestOrFallback(filePath: string): boolean {
  return [".test.", ".spec.", "__tests__", "__mocks__", "fallback"]
    .some((e) => filePath.includes(e));
}

async function findExistingChunk(
  projectId: string,
  sourcePath: string,
  memoryType: string,
  entityName?: string
) {
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

async function upsertChunk(params: {
  projectId: string;
  commitSha: string | null;
  branch: string;
  memoryType: string;
  content: string;
  sourcePath: string;
  embedding?: number[];
  metadata: Record<string, any>;
}) {
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
