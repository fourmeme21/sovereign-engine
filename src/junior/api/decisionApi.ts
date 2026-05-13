const ENGINE_URL = import.meta.env.VITE_ENGINE_URL ?? "";

export async function sendDecisionResponse(
  decisionId: string,
  action: "approve" | "reject"
): Promise<void> {
  await fetch(`${ENGINE_URL}/api/decisions/${decisionId}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}
