import Anthropic from "@anthropic-ai/sdk";
import { ASTChunk } from "./astParser.js";

const client = new Anthropic();

// TEK VE DOĞRU TANIM – SADECE BURADA
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
      content: `Aşağıdaki ${chunk.type} için kısa, aranabilir açıklama yaz.

Dosya: ${chunk.filePath}
${chunk.enclosingClass ? `Sınıf: ${chunk.enclosingClass}` : ""}
İlgili importlar: ${chunk.imports.slice(0, 3).join(", ")}

Kod:
${chunk.body.slice(0, 500)}

Açıklama (2-3 cümle):`,
    }],
  });
  return (response.content[0] as any).text;
}
