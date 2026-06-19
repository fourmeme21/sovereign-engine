export interface EmbedResult {
    embedding: number[];
    tokenCount: number;
}
export declare function embedTexts(texts: string[], inputType?: "query" | "document"): Promise<EmbedResult[]>;
export declare function embedSingle(text: string, inputType?: "query" | "document"): Promise<number[]>;
export declare function contentHash(text: string): string;
//# sourceMappingURL=voyageClient.d.ts.map