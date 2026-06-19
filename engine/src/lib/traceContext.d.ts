export interface TraceContext {
    trace_id: string;
    started_at: number;
    project_id: string;
    stage: PipelineStage;
}
export type PipelineStage = "REQUEST_RECEIVED" | "DIFF_GENERATED" | "RISK_CALCULATED" | "POLICY_EVALUATED" | "EXECUTION_APPLIED" | "AUDIT_WRITTEN";
export declare function createTrace(projectId: string): TraceContext;
export declare function advanceTrace(ctx: TraceContext, stage: PipelineStage): TraceContext;
export declare function traceElapsed(ctx: TraceContext): number;
//# sourceMappingURL=traceContext.d.ts.map