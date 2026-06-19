import { supabase } from "./supabase.js";
import { traceElapsed } from "./traceContext.js";
export async function writeAudit(ctx, entry) {
    try {
        await supabase.from("audit_records").insert({
            trace_id: ctx.trace_id,
            project_id: ctx.project_id,
            elapsed_ms: traceElapsed(ctx),
            ...entry,
        });
    }
    catch (err) {
        // Denetim hatası asıl akışı durdurmasın
        console.error("[audit] Yazılamadı:", err);
    }
}
//# sourceMappingURL=auditWriter.js.map