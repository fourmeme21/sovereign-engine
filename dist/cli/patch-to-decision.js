/**
 * Sovereign Engine OS — Patch → Decision Dönüştürücü
 * @module src/cli/patch-to-decision
 *
 * CLI'ın patch.json'ı Decision Object'e dönüştürdüğü yardımcı.
 * ARCHITECTURE.md §4 — CLI akışı Adım 2.
 *
 * SAP-08 Fix: intent artık hardcoded "WRITE_DATA" değil.
 *   intentFromPatch() ile patch.risk_level'dan türetilir:
 *     low    → READ_DATA
 *     medium → WRITE_DATA
 *     high   → EXECUTE_ACTION
 *   decision.ts kuralıyla tutarlı:
 *     MODIFY_STATE → risk_level CRITICAL zorunlu (bu dönüştürücü CRITICAL üretmez)
 */
import { randomUUID } from "crypto";
// ---------------------------------------------------------------------------
// SAP-08: Intent Türetme
// ---------------------------------------------------------------------------
/**
 * patch.risk_level → Decision Intent dönüşümü.
 *
 * decision.ts kurallarına göre:
 *   low    → READ_DATA       (veri okuma — LOW risk)
 *   medium → WRITE_DATA      (kayıt oluşturma — MEDIUM risk)
 *   high   → EXECUTE_ACTION  (iş akışı tetikleme — HIGH risk)
 *
 * MODIFY_STATE ve TRIGGER_EVENT bu katmandan üretilmez.
 * MODIFY_STATE için risk_level CRITICAL zorunlu — Patch şeması bunu desteklemiyor.
 * Domain adapter bu kararı override edebilir (Faz 5).
 */
function intentFromPatch(riskLevel) {
    const map = {
        low: "READ_DATA",
        medium: "WRITE_DATA",
        high: "EXECUTE_ACTION",
    };
    return map[riskLevel] ?? "WRITE_DATA";
}
// ---------------------------------------------------------------------------
// Risk Level Dönüşümü
// ---------------------------------------------------------------------------
function riskLevelMap(patch) {
    const map = {
        low: "LOW",
        medium: "MEDIUM",
        high: "HIGH",
    };
    return map[patch.risk_level] ?? "MEDIUM";
}
// ---------------------------------------------------------------------------
// Ana Dönüştürücü
// ---------------------------------------------------------------------------
/**
 * Patch JSON'ı Decision Object'e dönüştürür.
 * status: "PENDING" — Katman 1'in görevi.
 *
 * SAP-08: intent artık intentFromPatch(patch.risk_level) ile türetilir.
 *   Önceki: intent: "WRITE_DATA"  (hardcoded — yanlış)
 *   Şimdi:  intent: intentFromPatch(patch.risk_level)  (dinamik — doğru)
 */
export function patchToDecision(patch, actor) {
    return {
        schema_version: "1.0",
        id: randomUUID(),
        created_at: new Date().toISOString(),
        intent: intentFromPatch(patch.risk_level), // SAP-08 Fix
        category: "PATCH_APPLY",
        payload: {
            action_name: patch.patch.file
                .replace(/[^a-z0-9]/gi, "_")
                .toLowerCase()
                .replace(/_{2,}/g, "_")
                .slice(0, 50),
            params: {
                file: patch.patch.file,
                operations: patch.patch.operations,
                intent: patch.intent,
            },
        },
        context: {
            actor_id: actor.actor_id,
            actor_role: actor.actor_role,
            session_id: actor.session_id,
            risk_level: riskLevelMap(patch),
        },
        metadata: {
            model: "cli-operator",
            session_number: 1,
            confidence: patch.confidence >= 0.8 ? "HIGH" : patch.confidence >= 0.5 ? "MEDIUM" : "LOW",
            self_check_passed: patch.confidence >= 0.5,
        },
        status: "PENDING",
    };
}
/** Ortam değişkenlerinden CLI actor bilgisini okur */
export function getCliActor() {
    return {
        actor_id: process.env["SOVEREIGN_ACTOR_ID"] ?? "cli-operator",
        actor_role: process.env["SOVEREIGN_ACTOR_ROLE"] ?? "operator",
        session_id: process.env["SOVEREIGN_SESSION_ID"] ?? `cli-${Date.now()}`,
    };
}
//# sourceMappingURL=patch-to-decision.js.map