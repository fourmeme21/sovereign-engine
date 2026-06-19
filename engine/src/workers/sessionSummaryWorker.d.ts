export interface SessionSummaryInput {
    sessionId: string;
    projectId: string;
    conversationLog: {
        role: "user" | "assistant";
        content: string;
    }[];
    filesEdited: string[];
}
export declare function runSessionClose(input: SessionSummaryInput): Promise<void>;
//# sourceMappingURL=sessionSummaryWorker.d.ts.map