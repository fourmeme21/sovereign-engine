export interface UploadResult {
    chunksCreated: number;
    chunksSkipped: number;
    tokenCost: number;
    traceId: string;
    riskScore: number;
    semanticDiffId: string | null;
}
export declare function processFileUpload(projectId: string, filePath: string, fileContent: string, commitSha: string | null, branch?: string, beforeContent?: string, traceId?: string): Promise<UploadResult>;
//# sourceMappingURL=chunkPipeline.d.ts.map