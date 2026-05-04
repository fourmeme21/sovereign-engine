/**
 * Sovereign Engine OS — Validation Engine Unit Testleri
 * @module tests/validation/validation.test
 *
 * Kapsam:
 *   - schema.ts    → validateSchema()
 *   - rules.ts     → validateBusinessRules(), runRule()
 *   - engine.ts    → ValidationEngine.validate()
 */

import { validateSchema, CATEGORY_REGEX, ACTION_NAME_REGEX } from "../../src/validation/schema.js";
import { validateBusinessRules, runRule }                    from "../../src/validation/rules.js";
import { createValidationEngine }                            from "../../src/validation/engine.js";
import type { Decision }                                     from "../../src/types/decision.js";
import type { PreFlightResult }                              from "../../src/types/preflight.js";

// ===========================================================================
// TEST HELPERS
// ===========================================================================

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  const base: Decision = {
    schema_version: "1.0",
    id:             "01952f3e-7b2a-7000-8000-000000000001",
    created_at:     "2026-05-04T08:00:00.000Z",
    intent:         "WRITE_DATA",
    category:       "USER_MANAGEMENT",
    payload: {
      action_name: "create_user",
      params:      { username: "alice", role: "viewer" },
    },
    context: {
      actor_id:   "operator-1",
      actor_role: "operator",
      session_id: "session-6",
      risk_level: "MEDIUM",
    },
    metadata: {
      model:             "claude-sonnet-4-6",
      session_number:    6,
      confidence:        "HIGH",
      self_check_passed: true,
    },
    status: "PENDING",
  };
  return { ...base, ...overrides } as Decision;
}

// ===========================================================================
// SCHEMA VALIDATOR
// ===========================================================================

describe("validateSchema()", () => {

  describe("Geçerli Decision", () => {
    test("tam geçerli Decision → valid: true, errors: []", () => {
      const result = validateSchema(makeDecision());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("hierarchy_path ile → valid: true", () => {
      const d = makeDecision({
        context: {
          actor_id: "op-1", actor_role: "operator", session_id: "s",
          risk_level: "LOW", hierarchy_path: ["org", "team"],
        },
      });
      expect(validateSchema(d).valid).toBe(true);
    });
  });

  describe("schema_version", () => {
    test("eksik → MISSING_FIELD", () => {
      const d = { ...makeDecision() } as Record<string, unknown>;
      delete d["schema_version"];
      const r = validateSchema(d);
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.field === "schema_version" && e.code === "MISSING_FIELD")).toBe(true);
    });

    test("'2.0' → INVALID_VERSION", () => {
      const d = { ...makeDecision(), schema_version: "2.0" as "1.0" };
      const r = validateSchema(d);
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.code === "INVALID_VERSION")).toBe(true);
    });
  });

  describe("category regex", () => {
    test("/^[A-Z_]+$/ geçerli → valid", () => {
      expect(CATEGORY_REGEX.test("USER_MANAGEMENT")).toBe(true);
      expect(CATEGORY_REGEX.test("PAYMENT")).toBe(true);
    });

    test("küçük harf → INVALID_FORMAT", () => {
      const d = makeDecision({ category: "user_management" });
      const r = validateSchema(d);
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.field === "category" && e.code === "INVALID_FORMAT")).toBe(true);
    });

    test("tire içeriyor → INVALID_FORMAT", () => {
      const d = makeDecision({ category: "USER-MANAGEMENT" });
      expect(validateSchema(d).valid).toBe(false);
    });
  });

  describe("action_name regex", () => {
    test("/^[a-z_]+$/ geçerli → valid", () => {
      expect(ACTION_NAME_REGEX.test("create_user")).toBe(true);
      expect(ACTION_NAME_REGEX.test("send_email")).toBe(true);
    });

    test("büyük harf → INVALID_FORMAT", () => {
      const d = makeDecision({
        payload: { action_name: "CreateUser", params: {} },
      });
      const r = validateSchema(d);
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.field === "payload.action_name" && e.code === "INVALID_FORMAT")).toBe(true);
    });
  });

  describe("session_number", () => {
    test("0 → NON_POSITIVE_VALUE", () => {
      const d = makeDecision({
        metadata: { model: "m", session_number: 0, confidence: "HIGH", self_check_passed: true },
      });
      const r = validateSchema(d);
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.code === "NON_POSITIVE_VALUE")).toBe(true);
    });

    test("-5 → NON_POSITIVE_VALUE", () => {
      const d = makeDecision({
        metadata: { model: "m", session_number: -5, confidence: "HIGH", self_check_passed: true },
      });
      expect(validateSchema(d).valid).toBe(false);
    });

    test("1 → geçerli", () => {
      const d = makeDecision({
        metadata: { model: "m", session_number: 1, confidence: "HIGH", self_check_passed: true },
      });
      expect(validateSchema(d).valid).toBe(true);
    });
  });

  describe("null / primitif girdi", () => {
    test("null → INVALID_TYPE", () => {
      expect(validateSchema(null).valid).toBe(false);
    });
    test("string → INVALID_TYPE", () => {
      expect(validateSchema("hello").valid).toBe(false);
    });
    test("boş nesne → birden fazla hata", () => {
      const r = validateSchema({});
      expect(r.valid).toBe(false);
      expect(r.errors.length).toBeGreaterThan(3);
    });
  });
});

// ===========================================================================
// BUSINESS RULES VALIDATOR
// ===========================================================================

describe("validateBusinessRules()", () => {

  test("geçerli Decision → PASS", () => {
    expect(validateBusinessRules(makeDecision()).status).toBe("PASS");
  });

  describe("R1 — confidence=HIGH + self_check_passed=false", () => {
    test("→ REJECTED, CONFIDENCE_SELF_CHECK_CONFLICT", () => {
      const d = makeDecision({
        metadata: { model: "m", session_number: 1, confidence: "HIGH", self_check_passed: false },
      });
      const r = validateBusinessRules(d);
      expect(r.status).toBe("REJECTED");
      expect(r.error_code).toBe("CONFIDENCE_SELF_CHECK_CONFLICT");
      expect(r.rule).toBe("R1");
    });

    test("confidence=MEDIUM + self_check_passed=false → PASS (R1 tetiklenmez)", () => {
      const d = makeDecision({
        metadata: { model: "m", session_number: 1, confidence: "MEDIUM", self_check_passed: false },
      });
      expect(validateBusinessRules(d).status).toBe("PASS");
    });
  });

  describe("R2 — risk_level=CRITICAL + confidence=HIGH", () => {
    test("→ REJECTED, CRITICAL_HIGH_CONFIDENCE", () => {
      const d = makeDecision({
        intent:   "MODIFY_STATE",
        context:  { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "CRITICAL" },
        metadata: { model: "m", session_number: 1, confidence: "HIGH", self_check_passed: true },
      });
      const r = validateBusinessRules(d);
      expect(r.status).toBe("REJECTED");
      expect(r.error_code).toBe("CRITICAL_HIGH_CONFIDENCE");
    });
  });

  describe("R3 — intent=MODIFY_STATE + risk_level≠CRITICAL", () => {
    test("MODIFY_STATE + HIGH → REJECTED, MODIFY_STATE_NOT_CRITICAL", () => {
      const d = makeDecision({
        intent:  "MODIFY_STATE",
        context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "HIGH" },
      });
      const r = validateBusinessRules(d);
      expect(r.status).toBe("REJECTED");
      expect(r.error_code).toBe("MODIFY_STATE_NOT_CRITICAL");
    });

    test("MODIFY_STATE + MEDIUM → REJECTED", () => {
      const d = makeDecision({ intent: "MODIFY_STATE" });
      expect(validateBusinessRules(d).status).toBe("REJECTED");
    });
  });

  describe("R4 — assumed_state + geçersiz intent", () => {
    test("assumed_state + WRITE_DATA → REJECTED, ASSUMED_STATE_INVALID_INTENT", () => {
      const d = makeDecision({
        payload: { action_name: "create_user", params: {}, assumed_state: { count: 5 } },
      });
      const r = validateBusinessRules(d);
      expect(r.status).toBe("REJECTED");
      expect(r.error_code).toBe("ASSUMED_STATE_INVALID_INTENT");
    });

    test("assumed_state + EXECUTE_ACTION → PASS", () => {
      const d = makeDecision({
        intent:  "EXECUTE_ACTION",
        payload: { action_name: "run_job", params: {}, assumed_state: { status: "IDLE" } },
        context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "HIGH" },
      });
      expect(validateBusinessRules(d).status).toBe("PASS");
    });
  });

  describe("R5 — RE_EVALUATE limit", () => {
    test("_re_evaluate_count=3 → ASK_HUMAN", () => {
      const d = makeDecision({
        payload: { action_name: "do_thing", params: { _re_evaluate_count: 3 } },
      });
      const r = validateBusinessRules(d);
      expect(r.status).toBe("ASK_HUMAN");
      expect(r.error_code).toBe("RE_EVALUATE_LIMIT_REACHED");
    });

    test("_re_evaluate_count=2 → PASS", () => {
      const d = makeDecision({
        payload: { action_name: "do_thing", params: { _re_evaluate_count: 2 } },
      });
      expect(validateBusinessRules(d).status).toBe("PASS");
    });
  });

  describe("R6 — IMMUTABLE_STATE", () => {
    test("status=COMPLETED → REJECTED, IMMUTABLE_STATE", () => {
      const d = makeDecision({ status: "COMPLETED" });
      const r = validateBusinessRules(d);
      expect(r.status).toBe("REJECTED");
      expect(r.error_code).toBe("IMMUTABLE_STATE");
    });

    test("status=BLOCKED → REJECTED", () => {
      expect(validateBusinessRules(makeDecision({ status: "BLOCKED" })).status).toBe("REJECTED");
    });

    test("status=REJECTED → REJECTED", () => {
      expect(validateBusinessRules(makeDecision({ status: "REJECTED" })).status).toBe("REJECTED");
    });
  });

  describe("R7 — INVALID_ENTRY_STATUS", () => {
    test("status=VALIDATED → REJECTED, INVALID_ENTRY_STATUS", () => {
      const d = makeDecision({ status: "VALIDATED" });
      const r = validateBusinessRules(d);
      expect(r.status).toBe("REJECTED");
      expect(r.error_code).toBe("INVALID_ENTRY_STATUS");
    });

    test("status=PENDING → PASS (R7 tetiklenmez)", () => {
      expect(validateBusinessRules(makeDecision()).status).toBe("PASS");
    });
  });

  describe("R8 — EMPTY_ACTOR_ID", () => {
    test("actor_id boş string → REJECTED", () => {
      const d = makeDecision({
        context: { actor_id: "  ", actor_role: "op", session_id: "s", risk_level: "LOW" },
      });
      const r = validateBusinessRules(d);
      expect(r.status).toBe("REJECTED");
      expect(r.error_code).toBe("EMPTY_ACTOR_ID");
    });
  });

  describe("R9 — INVALID_HIERARCHY_PATH", () => {
    test("hierarchy_path boş string içeriyor → REJECTED", () => {
      const d = makeDecision({
        context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "LOW", hierarchy_path: ["org", ""] },
      });
      expect(validateBusinessRules(d).status).toBe("REJECTED");
    });

    test("geçerli hierarchy_path → PASS", () => {
      const d = makeDecision({
        context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "LOW", hierarchy_path: ["org", "team"] },
      });
      expect(validateBusinessRules(d).status).toBe("PASS");
    });
  });

  describe("runRule() — tekil kural çalıştırma", () => {
    test("runRule('R1', d) doğrudan R1 çalıştırır", () => {
      const d = makeDecision({
        metadata: { model: "m", session_number: 1, confidence: "HIGH", self_check_passed: false },
      });
      const r = runRule("R1", d);
      expect(r).not.toBeNull();
      expect(r?.rule).toBe("R1");
    });

    test("tanımsız kural adı → null", () => {
      expect(runRule("R99", makeDecision())).toBeNull();
    });
  });
});

// ===========================================================================
// VALIDATION ENGINE — TAM AKIŞ
// ===========================================================================

describe("ValidationEngine.validate()", () => {
  const engine = createValidationEngine();

  test("geçerli Decision → PASS, status=VALIDATED", async () => {
    const result = await engine.validate(makeDecision());
    expect(result.status).toBe("PASS");
    expect(result.data?.status).toBe("VALIDATED");
  });

  test("şema hatası → REJECTED (iş kuralları çalışmaz)", async () => {
    const bad = { ...makeDecision(), schema_version: "2.0" as "1.0" };
    const result = await engine.validate(bad);
    expect(result.status).toBe("REJECTED");
    expect(result.reason).toMatch(/Şema hatası/);
  });

  test("iş kuralı ihlali → REJECTED", async () => {
    const d = makeDecision({
      metadata: { model: "m", session_number: 1, confidence: "HIGH", self_check_passed: false },
    });
    const result = await engine.validate(d);
    expect(result.status).toBe("REJECTED");
  });

  test("null girdi → REJECTED", async () => {
    const result = await engine.validate(null);
    expect(result.status).toBe("REJECTED");
  });

  describe("preFlightRead entegrasyonu", () => {
    test("provider yok + assumed_state var → PASS (pre-flight atlanır)", async () => {
      const d = makeDecision({
        intent:  "EXECUTE_ACTION",
        payload: { action_name: "run_job", params: {}, assumed_state: { status: "IDLE" } },
        context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "HIGH" },
      });
      const result = await engine.validate(d);
      expect(result.status).toBe("PASS");
    });

    test("provider clear=false → REJECTED", async () => {
      const staleProvider = {
        preFlightRead: async (): Promise<PreFlightResult> => ({
          clear:        false,
          reason:       "STATE_CHANGED",
          stale_fields: ["status"],
        }),
      };
      const engineWithProvider = createValidationEngine(staleProvider);
      const d = makeDecision({
        intent:  "EXECUTE_ACTION",
        payload: { action_name: "run_job", params: {}, assumed_state: { status: "IDLE" } },
        context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "HIGH" },
      });
      const result = await engineWithProvider.validate(d);
      expect(result.status).toBe("REJECTED");
      expect(result.reason).toMatch(/Pre-flight/);
    });

    test("provider RE_EVALUATE limit aşıldı → ASK_HUMAN", async () => {
      const maxedProvider = {
        preFlightRead: async (): Promise<PreFlightResult> => ({
          clear:       false,
          reason:      "RE_EVALUATE",
          retry_count: 3,
        }),
      };
      const engineWithProvider = createValidationEngine(maxedProvider);
      const d = makeDecision({
        intent:  "EXECUTE_ACTION",
        payload: { action_name: "run_job", params: {}, assumed_state: { status: "IDLE" } },
        context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "HIGH" },
      });
      const result = await engineWithProvider.validate(d);
      expect(result.status).toBe("ASK_HUMAN");
    });

    test("assumed_state yok → pre-flight çalışmaz, PASS", async () => {
      const calledProvider = {
        called: false,
        preFlightRead: async function(): Promise<PreFlightResult> {
          this.called = true;
          return { clear: true };
        },
      };
      const engineWithProvider = createValidationEngine(calledProvider);
      await engineWithProvider.validate(makeDecision());
      expect(calledProvider.called).toBe(false);
    });
  });
});
