import { TraceContext } from "./traceContext.js";
export interface AuditEntry {
    trace_id: string;
    project_id: string;
    session_id?: string;
    stage: string;
    decision: "PERMIT" | "DENY" | "ASK_HUMAN" | "AUTO_APPROVED";
    reason: string;
    diff_id?: string;
    risk_score?: number;
    elapsed_ms?: number;
    metadata?: Record<string, unknown>;
}
export declare function writeAudit(ctx: TraceContext, entry: Omit<AuditEntry, "trace_id" | "project_id" | "elapsed_ms">): Promise<void>;
//# sourceMappingURL=auditWriter.d.ts.map