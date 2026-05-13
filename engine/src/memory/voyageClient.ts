import crypto from "crypto";

const VOYAGE_API = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-code-3";

export interface EmbedResult {
  embedding: number[];
  tokenCount: number;
}

export async function embedTexts(
  texts: string[],
  inputType: "query" | "document" = "document"
): Promise<EmbedResult[]> {
  const response = await fetch(VOYAGE_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: texts,
      input_type: inputType,
      output_dimension: 1024,
      output_dtype: "float",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage AI ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.data.map((item: any, i: number) => ({
    embedding: item.embedding,
    tokenCount: data.usage?.total_tokens
      ? Math.floor(data.usage.total_tokens / texts.length)
      : texts[i].length / 4,
  }));
}

export async function embedSingle(
  text: string,
  inputType: "query" | "document" = "document"
): Promise<number[]> {
  const results = await embedTexts([text], inputType);
  return results[0].embedding;
}

export function contentHash(text: string): string {
  return crypto
    .createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 16);
}
