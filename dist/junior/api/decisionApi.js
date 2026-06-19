const ENGINE_URL = import.meta.env.VITE_ENGINE_URL ?? "";
export async function sendDecisionResponse(decisionId, action) {
    await fetch(`${ENGINE_URL}/api/decisions/${decisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
    });
}
//# sourceMappingURL=decisionApi.js.map