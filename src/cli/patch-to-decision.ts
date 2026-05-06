/**
 * Sovereign Engine OS — Patch → Decision Dönüştürücü
 * @module src/cli/patch-to-decision
 *
 * CLI'ın patch.json'ı Decision Object'e dönüştürdüğü yardımcı.
 * ARCHITECTURE.md §4 — CLI akışı Adım 2.
 */

import { randomUUID } from "crypto";
import type { Decision } from "../types/decision.js";
import type { Patch }    from "../types/patch.js";

/** CLI actor bilgisi — env'den veya default */
export interface CliActor {
  actor_id:   string;
  actor_role: string;
  session_id: string;
}

function riskLevelMap(patch: Patch): Decision["context"]["risk_level"] {
  const map: Record<string, Decision["context"]["risk_level"]> = {
    low:    "LOW",
    medium: "MEDIUM",
    high:   "HIGH",
  };
  return map[patch.risk_level] ?? "MEDIUM";
}

/**
 * Patch JSON'ı Decision Object'e dönüştürür.
 * status: "PENDING" — Katman 1'in görevi.
 */
export function patchToDecision(patch: Patch, actor: CliActor): Decision {
  return {
    schema_version: "1.0",
    id:             randomUUID(),
    created_at:     new Date().toISOString(),
    intent:         "WRITE_DATA",   // Patch her zaman WRITE_DATA — Faz 5'te domain adapter override eder
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
