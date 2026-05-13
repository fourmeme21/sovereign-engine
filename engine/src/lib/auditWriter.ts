import { supabase } from "./supabase.js";
import { TraceContext, traceElapsed } from "./traceContext.js";

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

export async function writeAudit(
  ctx: TraceContext,
  entry: Omit<AuditEntry, "trace_id" | "project_id" | "elapsed_ms">
): Promise<void> {
  try {
    await supabase.from("audit_records").insert({
      trace_id:   ctx.trace_id,
      project_id: ctx.project_id,
      elapsed_ms: traceElapsed(ctx),
      ...entry,
    });
  } catch (err) {
    // Denetim hatası asıl akışı durdurmasın
    console.error("[audit] Yazılamadı:", err);
  }
}
