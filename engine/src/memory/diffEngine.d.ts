import { SemanticDiff } from "./semanticDiff.types.js";
export declare function generateSemanticDiff(projectId: string, filePath: string, beforeContent: string, afterContent: string, options?: {
    commitSha?: string;
    branch?: string;
    traceId?: string;
}): SemanticDiff;
//# sourceMappingURL=diffEngine.d.ts.map