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

import { randomUUID }        from "crypto";
import type { Decision,
              Intent }       from "../types/decision.js";
import type { Patch,
              PatchRiskLevel } from "../types/patch.js";

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------

/** CLI actor bilgisi — env'den veya default */
export interface CliActor {
  actor_id:   string;
  actor_role: string;
  session_id: string;
}

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
function intentFromPatch(riskLevel: PatchRiskLevel): Intent {
  const map: Record<PatchRiskLevel, Intent> = {
    low:    "READ_DATA",
    medium: "WRITE_DATA",
    high:   "EXECUTE_ACTION",
  };
  return map[riskLevel] ?? "WRITE_DATA";
}

// ---------------------------------------------------------------------------
// Risk Level Dönüşümü
// ---------------------------------------------------------------------------

function riskLevelMap(patch: Patch): Decision["context"]["risk_level"] {
  const map: Record<PatchRiskLevel, Decision["context"]["risk_level"]> = {
    low:    "LOW",
    medium: "MEDIUM",
    high:   "HIGH",
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
export function patchToDecision(patch: Patch, actor: CliActor): Decision {
  return {
    schema_version: "1.0",
    id:             randomUUID(),
    created_at:     new Date().toISOString(),
    intent:         intentFromPatch(patch.risk_level),  // SAP-08 Fix
    category:       "PATCH_APPLY",
    payload: {
      action_name: patch.patch.file
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase()
        .replace(/_{2,}/g, "_")
        .slice(0, 50),
      params: {
        file:       patch.patch.file,
        operations: patch.patch.operations,
        intent:     patch.intent,
      },
    },
    context: {
      actor_id:   actor.actor_id,
      actor_role: actor.actor_role,
      session_id: actor.session_id,
      risk_level: riskLevelMap(patch),
    },
    metadata: {
      model:             "cli-operator",
      session_number:    1,
      confidence:        patch.confidence >= 0.8 ? "HIGH" : patch.confidence >= 0.5 ? "MEDIUM" : "LOW",
      self_check_passed: patch.confidence >= 0.5,
    },
    status: "PENDING",
  };
}

/** Ortam değişkenlerinden CLI actor bilgisini okur */
export function getCliActor(): CliActor {
  return {
    actor_id:   process.env["SOVEREIGN_ACTOR_ID"]   ?? "cli-operator",
    actor_role: process.env["SOVEREIGN_ACTOR_ROLE"] ?? "operator",
    session_id: process.env["SOVEREIGN_SESSION_ID"] ?? `cli-${Date.now()}`,
  };
}
