import { v4 as uuid } from "uuid";
export function createTrace(projectId) {
    return {
        trace_id: uuid(),
        started_at: Date.now(),
        project_id: projectId,
        stage: "REQUEST_RECEIVED",
    };
}
export function advanceTrace(ctx, stage) {
    return { ...ctx, stage };
}
export function traceElapsed(ctx) {
    return Date.now() - ctx.started_at;
}
//# sourceMappingURL=traceContext.js.map