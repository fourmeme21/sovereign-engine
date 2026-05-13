import Anthropic from "@anthropic-ai/sdk";
import { ASTChunk } from "./astParser.js";

const client = new Anthropic();

export async function generateFileLevelSummary(
  filePath: string,
  fileContent: string,
  astChunks: ASTChunk[]
): Promise<string> {
  const totalLines = fileContent.split("\n").length;
  const functionCount = astChunks.filter((c) => c.type === "function").length;
  const classCount = astChunks.filter((c) => c.type === "class").length;
  const todoCount = astChunks.filter((c) => c.hasToDoFixMe).length;
  return `${filePath} (${totalLines} satır, ${functionCount} fonksiyon, ${classCount} sınıf, ${todoCount} TODO/FIXME)`;
}

export async function generateChunkDescription(chunk: ASTChunk): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `Açıklama: ${chunk.type} ${chunk.name} ...`,
    }],
  });
  return (response.content[0] as any).text;
}
