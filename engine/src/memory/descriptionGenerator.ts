import Anthropic from "@anthropic-ai/sdk";
import { ASTChunk } from "./astParser";

const client = new Anthropic();

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
