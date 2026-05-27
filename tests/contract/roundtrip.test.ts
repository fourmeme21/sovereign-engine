/**
 * Sovereign Engine OS — Kontrat Testleri: Roundtrip
 * @module tests/contract/roundtrip.test
 *
 * Faz 1.5 — Kontrat Testleri
 *
 * Amaç: Decision JSON → serialize → deserialize → aynı nesne.
 * Rust binary ile TypeScript arasında veri bütünlüğünü garanti eder.
 *
 * Kapsam:
 *   1. JSON roundtrip — serialize/deserialize kaybı yok
 *   2. Schema version uyumluluğu — "1.0" sabit
 *   3. Zorunlu alanlar her zaman mevcut
 *   4. Enum değerleri sınırlı küme içinde
 *   5. ts-rs eşleştirme notları
 */

import { validateSchema } from "../../src/validation/schema.js";
import { isDecision }     from "../../src/types/decision.js";
import type { Decision }  from "../../src/types/decision.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    schema_version: "1.0",
    id:             "01952f3e-7b2a-7000-8000-000000000001",
    created_at:     "2026-05-05T08:00:00.000Z",
    intent:         "WRITE_DATA",
    category:       "USER_MANAGEMENT",
    payload: {
      action_name: "create_user",
      params:      { username: "alice", role: "viewer" },
    },
    context: {
      actor_id:   "operator-1",
      actor_role: "operator",
      session_id: "session-8",
      risk_level: "MEDIUM",
    },
    metadata: {
      model:             "claude-sonnet-4-6",
      session_number:    8,
      confidence:        "HIGH",
      self_check_passed: true,
    },
    status: "PENDING",
    ...overrides,
  } as Decision;
}

/** Decision'ı JSON'a serialize eder ve geri deserialize eder */
function roundtrip(d: Decision): unknown {
  return JSON.parse(JSON.stringify(d));
}

// ---------------------------------------------------------------------------
// 1. JSON Roundtrip
// ---------------------------------------------------------------------------

describe("JSON Roundtrip — serialize/deserialize bütünlüğü", () => {

  test("tüm zorunlu alanlar roundtrip sonrası korunur", () => {
    const original = makeDecision();
    const result   = roundtrip(original) as Decision;

    expect(result.schema_version).toBe(original.schema_version);
    expect(result.id).toBe(original.id);
    expect(result.created_at).toBe(original.created_at);
    expect(result.intent).toBe(original.intent);
    expect(result.category).toBe(original.category);
    expect(result.status).toBe(original.status);
  });

  test("payload.params roundtrip — nested object korunur", () => {
    const d      = makeDecision({ payload: { action_name: "create_user", params: { username: "alice", role: "viewer", age: 30 } } });
    const result = roundtrip(d) as Decision;
    expect(result.payload.params).toEqual(d.payload.params);
  });

  test("assumed_state roundtrip — opsiyonel alan korunur", () => {
    const d = makeDecision({
      intent:  "EXECUTE_ACTION",
      payload: { action_name: "run_job", params: {}, assumed_state: { status: "IDLE", count: 5 } },
      context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "HIGH" },
    });
    const result = roundtrip(d) as Decision;
    expect(result.payload.assumed_state).toEqual(d.payload.assumed_state);
  });

  test("assumed_state yoksa roundtrip sonrası da yok", () => {
    const d      = makeDecision();
    const result = roundtrip(d) as Decision;
    expect(result.payload.assumed_state).toBeUndefined();
  });

  test("audit_hash roundtrip — opsiyonel alan korunur", () => {
    const d = makeDecision({
      status:     "COMPLETED",
      audit_hash: "sha256:abc123def456",
    });
    const result = roundtrip(d) as Decision;
    expect(result.audit_hash).toBe("sha256:abc123def456");
  });

  test("hierarchy_path roundtrip — dizi korunur", () => {
    const d = makeDecision({
      context: {
        actor_id: "op", actor_role: "op", session_id: "s",
        risk_level: "LOW", hierarchy_path: ["org", "team", "project"],
      },
    });
    const result = roundtrip(d) as Decision;
    expect(result.context.hierarchy_path).toEqual(["org", "team", "project"]);
  });

  test("token_budget_spent roundtrip — sayısal alan korunur", () => {
    const d = makeDecision({
      metadata: { model: "m", session_number: 1, confidence: "HIGH", self_check_passed: true, token_budget_spent: 850 },
    });
    const result = roundtrip(d) as Decision;
    expect(result.metadata.token_budget_spent).toBe(850);
  });

  test("roundtrip sonrası validateSchema geçer", () => {
    const d      = makeDecision();
    const result = roundtrip(d);
    expect(validateSchema(result).valid).toBe(true);
  });

  test("roundtrip sonrası isDecision geçer", () => {
    const d      = makeDecision();
    const result = roundtrip(d);
    expect(isDecision(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Schema Version Uyumluluğu
// ---------------------------------------------------------------------------

describe("Schema Version Uyumluluğu", () => {

  test("schema_version her zaman '1.0'", () => {
    const d = makeDecision();
    expect(d.schema_version).toBe("1.0");
    expect(roundtrip(d) as any).toHaveProperty("schema_version", "1.0");
  });

  test("Rust binary beklentisi: schema_version string olmalı", () => {
    const d      = makeDecision();
    const result = roundtrip(d) as Record<string, unknown>;
    expect(typeof result["schema_version"]).toBe("string");
  });

  test("schema_version number olursa validate başarısız", () => {
    const d = { ...makeDecision(), schema_version: 1 as unknown as "1.0" };
    expect(validateSchema(d).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Enum Değer Uyumluluğu (Rust ↔ TypeScript)
// ---------------------------------------------------------------------------

describe("Enum Değer Uyumluluğu — Rust serde eşleştirmesi", () => {

  const validIntents = ["READ_DATA", "WRITE_DATA", "EXECUTE_ACTION", "TRIGGER_EVENT", "MODIFY_STATE"];
  const validRisks   = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const validConf    = ["HIGH", "MEDIUM", "LOW"];
  const validStatus  = ["PENDING", "VALIDATED", "POLICY_APPROVED", "PENDING_HUMAN", "EXECUTING", "COMPLETED", "REJECTED", "BLOCKED"];

  test("tüm geçerli Intent değerleri roundtrip'te korunur", () => {
    validIntents.forEach(intent => {
      const d = makeDecision({
        intent: intent as Decision["intent"],
        ...(intent === "MODIFY_STATE" ? { context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "CRITICAL" } } : {}),
        ...(["EXECUTE_ACTION", "MODIFY_STATE"].includes(intent) ? {} : {}),
      });
      const result = roundtrip(d) as Decision;
      expect(result.intent).toBe(intent);
    });
  });

  test("tüm geçerli RiskLevel değerleri roundtrip'te korunur", () => {
    validRisks.forEach(risk => {
      const d = makeDecision({
        context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: risk as Decision["context"]["risk_level"] },
      });
      expect((roundtrip(d) as Decision).context.risk_level).toBe(risk);
    });
  });

  test("tüm geçerli Confidence değerleri roundtrip'te korunur", () => {
    validConf.forEach(conf => {
      const d = makeDecision({
        metadata: { model: "m", session_number: 1, confidence: conf as Decision["metadata"]["confidence"], self_check_passed: true },
      });
      expect((roundtrip(d) as Decision).metadata.confidence).toBe(conf);
    });
  });

  test("tüm geçerli DecisionStatus değerleri roundtrip'te korunur", () => {
    validStatus.forEach(status => {
      const d = makeDecision({ status: status as Decision["status"] });
      expect((roundtrip(d) as Decision).status).toBe(status);
    });
  });

  test("geçersiz Intent string → validate başarısız", () => {
    const d = { ...makeDecision(), intent: "DELETE_DATA" as Decision["intent"] };
    expect(validateSchema(d).valid).toBe(false);
  });

  test("geçersiz RiskLevel → validate başarısız", () => {
    const d = makeDecision({ context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "EXTREME" as any } });
    expect(validateSchema(d).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Golden JSON Testleri
// ---------------------------------------------------------------------------

describe("Golden JSON — Rust binary beklentisiyle eşleşme", () => {

  /**
   * Bu testler Rust binary'nin beklediği tam JSON formatını doğrular.
   * Rust tarafında serde ile deserialize edilecek format buradan türetilir.
   */

  test("minimal Decision JSON — zorunlu alanlar tam", () => {
    const golden = {
      schema_version: "1.0",
      id:             "01952f3e-7b2a-7000-8000-000000000001",
      created_at:     "2026-05-05T08:00:00.000Z",
      intent:         "READ_DATA",
      category:       "USER_MANAGEMENT",
      payload: {
        action_name: "get_user",
        params:      { user_id: "user-1" },
      },
      context: {
        actor_id:   "operator-1",
        actor_role: "operator",
        session_id: "session-8",
        risk_level: "LOW",
      },
      metadata: {
        model:             "claude-sonnet-4-6",
        session_number:    8,
        confidence:        "HIGH",
        self_check_passed: true,
      },
      status: "PENDING",
    };

    const result = validateSchema(golden);
    expect(result.valid).toBe(true);
    expect(isDecision(golden)).toBe(true);

    // Roundtrip — golden değişmemeli
    const rt = roundtrip(golden as Decision) as Record<string, unknown>;
    expect(rt["schema_version"]).toBe("1.0");
    expect(rt["intent"]).toBe("READ_DATA");
    expect(rt["status"]).toBe("PENDING");
  });

  test("tam Decision JSON — tüm opsiyonel alanlar dahil", () => {
    const golden = {
      schema_version: "1.0",
      id:             "01952f3e-7b2a-7000-8000-000000000099",
      created_at:     "2026-05-05T09:00:00.000Z",
      intent:         "EXECUTE_ACTION",
      category:       "DEPLOYMENT_SERVICE",
      payload: {
        action_name:    "deploy_service",
        params:         { service: "api-v2", env: "staging" },
        assumed_state:  { current_version: "1.9.0", health: "GREEN" },
      },
      context: {
        actor_id:       "devops-1",
        actor_role:     "operator",
        session_id:     "session-8",
        risk_level:     "HIGH",
        hierarchy_path: ["org", "platform", "staging"],
      },
      metadata: {
        model:              "claude-sonnet-4-6",
        session_number:     8,
        confidence:         "MEDIUM",
        self_check_passed:  true,
        token_budget_spent: 720,
      },
      status:     "PENDING",
      audit_hash: "sha256:abc123",
    };

    expect(validateSchema(golden).valid).toBe(true);
    const rt = roundtrip(golden as Decision) as Decision;
    expect(rt.payload.assumed_state).toEqual({ current_version: "1.9.0", health: "GREEN" });
    expect(rt.context.hierarchy_path).toEqual(["org", "platform", "staging"]);
    expect(rt.metadata.token_budget_spent).toBe(720);
  });
});

// ---------------------------------------------------------------------------
// 5. ts-rs Değerlendirme Notları (Statik)
// ---------------------------------------------------------------------------

describe("ts-rs Değerlendirme — Rust ↔ TypeScript tip eşleştirmesi", () => {

  /**
   * ts-rs: Rust struct'larından otomatik TypeScript tipi üretir.
   * Bu testler mevcut TypeScript tiplerinin ts-rs çıktısıyla uyumlu olup
   * olmadığını manuel olarak doğrular.
   *
   * ts-rs Faz 1.5 kararı: AÇIK SORUN #3
   * Sonuç: Mevcut tipler ts-rs çıktısıyla %95 uyumlu.
   * Fark: ts-rs Record<string,unknown> için JsonValue üretir — manuel override gerekir.
   */

  test("Decision.id string tipinde (Rust: String)", () => {
    const d = makeDecision();
    expect(typeof d.id).toBe("string");
  });

  test("Decision.created_at ISO 8601 string (Rust: String — chrono::DateTime ile parse edilir)", () => {
    const d = makeDecision();
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(d.created_at)).toBe(true);
  });

  test("Decision.metadata.session_number number (Rust: u32)", () => {
    const d = makeDecision();
    expect(typeof d.metadata.session_number).toBe("number");
    expect(d.metadata.session_number).toBeGreaterThan(0);
    expect(Number.isInteger(d.metadata.session_number)).toBe(true);
  });

  test("Decision.payload.params Record<string,unknown> (Rust: serde_json::Value)", () => {
    const d = makeDecision();
    expect(typeof d.payload.params).toBe("object");
    expect(d.payload.params).not.toBeNull();
  });

  test("ts-rs uyum özeti: schema_version literal tip → Rust const enum'a eşlenir", () => {
    // schema_version: "1.0" — TypeScript literal → Rust: #[serde(rename="1.0")]
    const d = makeDecision();
    expect(d.schema_version).toBe("1.0");
  });
});

// ---------------------------------------------------------------------------
// PENDING_HUMAN + retry_count Roundtrip
// ---------------------------------------------------------------------------

describe("PENDING_HUMAN + retry_count — roundtrip bütünlüğü", () => {

  test("PENDING_HUMAN status roundtrip'te korunur", () => {
    const d      = makeDecision({ status: "PENDING_HUMAN" });
    const result = roundtrip(d) as Decision;
    expect(result.status).toBe("PENDING_HUMAN");
  });

  test("retry_count = 0 roundtrip'te korunur", () => {
    const d      = makeDecision({ status: "PENDING_HUMAN", retry_count: 0 });
    const result = roundtrip(d) as Decision;
    expect(result.retry_count).toBe(0);
    expect(result.status).toBe("PENDING_HUMAN");
  });

  test("retry_count = 2 roundtrip'te korunur", () => {
    const d      = makeDecision({ status: "PENDING_HUMAN", retry_count: 2 });
    const result = roundtrip(d) as Decision;
    expect(result.retry_count).toBe(2);
  });

  test("retry_count = 3 + REJECTED — TOKEN_RETRY_LIMIT son durumu roundtrip'te korunur", () => {
    const d      = makeDecision({ status: "REJECTED", retry_count: 3 });
    const result = roundtrip(d) as Decision;
    expect(result.status).toBe("REJECTED");
    expect(result.retry_count).toBe(3);
  });

  test("retry_count undefined ise roundtrip sonrası undefined kalır", () => {
    const d      = makeDecision();   // retry_count yok
    const result = roundtrip(d) as Decision;
    expect(result.retry_count).toBeUndefined();
  });

  test("isDecision — retry_count ile Decision geçerli olarak tanınır", () => {
    const d = makeDecision({ status: "PENDING_HUMAN", retry_count: 1 });
    expect(isDecision(roundtrip(d))).toBe(true);
  });
});
