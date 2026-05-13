import { v4 as uuid } from "uuid";

export interface TraceContext {
  trace_id: string;
  started_at: number;
  project_id: string;
  stage: PipelineStage;
}

export type PipelineStage =
  | "REQUEST_RECEIVED"
  | "DIFF_GENERATED"
  | "RISK_CALCULATED"
  | "POLICY_EVALUATED"
  | "EXECUTION_APPLIED"
  | "AUDIT_WRITTEN";

export function createTrace(projectId: string): TraceContext {
  return {
    trace_id: uuid(),
    started_at: Date.now(),
    project_id: projectId,
    stage: "REQUEST_RECEIVED",
  };
}

export function advanceTrace(ctx: TraceContext, stage: PipelineStage): TraceContext {
  return { ...ctx, stage };
}

export function traceElapsed(ctx: TraceContext): number {
  return Date.now() - ctx.started_at;
}
