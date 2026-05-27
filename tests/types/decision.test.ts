/**
 * Sovereign Engine OS — Decision Type Unit Tests
 * @module tests/types/decision.test
 */

import {
  type Decision,
  type DecisionStatus,
  isDecision,
  isImmutableStatus,
  isModifyStateValid,
  isAssumedStateValid,
} from "../../src/types/decision.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  const base: Decision = {
    schema_version:  "1.0",
    id:              "01952f3e-7b2a-7000-8000-000000000001",
    created_at:      "2026-05-04T08:00:00.000Z",
    intent:          "WRITE_DATA",
    category:        "USER_MANAGEMENT",
    payload: {
      action_name: "create_user",
      params:      { username: "alice", role: "viewer" },
    },
    context: {
      actor_id:   "operator-1",
      actor_role: "operator",
      session_id: "session-5",
      risk_level: "MEDIUM",
    },
    metadata: {
      model:             "claude-sonnet-4-6",
      session_number:    5,
      confidence:        "HIGH",
      self_check_passed: true,
    },
    status: "PENDING",
  };
  return { ...base, ...overrides } as Decision;
}

// ---------------------------------------------------------------------------
// isDecision
// ---------------------------------------------------------------------------

describe("isDecision()", () => {
  test("geçerli Decision → true döner", () => {
    expect(isDecision(makeDecision())).toBe(true);
  });

  test("null → false döner", () => {
    expect(isDecision(null)).toBe(false);
  });

  test("schema_version eksik → false döner", () => {
    const d = makeDecision() as Record<string, unknown>;
    delete d["schema_version"];
    expect(isDecision(d)).toBe(false);
  });

  test("schema_version '2.0' → false döner", () => {
    expect(isDecision({ ...makeDecision(), schema_version: "2.0" as "1.0" })).toBe(false);
  });

  test("id eksik → false döner", () => {
    const d = makeDecision() as Record<string, unknown>;
    delete d["id"];
    expect(isDecision(d)).toBe(false);
  });

  test("status eksik → false döner", () => {
    const d = makeDecision() as Record<string, unknown>;
    delete d["status"];
    expect(isDecision(d)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isImmutableStatus
// ---------------------------------------------------------------------------

describe("isImmutableStatus()", () => {
  const immutable: DecisionStatus[] = ["COMPLETED", "REJECTED", "BLOCKED"];
  const mutable: DecisionStatus[]   = ["PENDING", "VALIDATED", "POLICY_APPROVED", "PENDING_HUMAN", "EXECUTING"];

  immutable.forEach((status) => {
    test(`${status} → true (kilitli)`, () => {
      expect(isImmutableStatus(status)).toBe(true);
    });
  });

  mutable.forEach((status) => {
    test(`${status} → false (değiştirilebilir)`, () => {
      expect(isImmutableStatus(status)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// retry_count — ARCHITECTURE §2.1 + §3.3 + §3.4
// ---------------------------------------------------------------------------

describe("Decision.retry_count", () => {
  test("retry_count belirtilmemişse Decision geçerlidir", () => {
    const d = makeDecision();
    expect(d.retry_count).toBeUndefined();
    expect(isDecision(d)).toBe(true);
  });

  test("retry_count = 0 ile PENDING_HUMAN Decision geçerlidir", () => {
    const d = makeDecision({ status: "PENDING_HUMAN", retry_count: 0 });
    expect(isDecision(d)).toBe(true);
    expect(d.retry_count).toBe(0);
  });

  test("retry_count = 2 (sınırın altı) — hâlâ PENDING_HUMAN", () => {
    const d = makeDecision({ status: "PENDING_HUMAN", retry_count: 2 });
    expect(d.status).toBe("PENDING_HUMAN");
    expect(d.retry_count).toBe(2);
  });

  test("retry_count = 3 ile status REJECTED olmak zorundadır (TOKEN_RETRY_LIMIT)", () => {
    // Orchestration katmanının üretmesi beklenen son durum
    const d = makeDecision({ status: "REJECTED", retry_count: 3 });
    expect(d.status).toBe("REJECTED");
    expect(d.retry_count).toBe(3);
  });

  test("PENDING_HUMAN — isImmutableStatus false döner (geçiş yapılabilir)", () => {
    expect(isImmutableStatus("PENDING_HUMAN")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isModifyStateValid — ARCHITECTURE §2.1 kısıtı
// ---------------------------------------------------------------------------

describe("isModifyStateValid()", () => {
  test("MODIFY_STATE + CRITICAL → geçerli", () => {
    const d = makeDecision({
      intent:  "MODIFY_STATE",
      context: { actor_id: "op", actor_role: "operator", session_id: "s", risk_level: "CRITICAL" },
    });
    expect(isModifyStateValid(d)).toBe(true);
  });

  test("MODIFY_STATE + HIGH → geçersiz (REJECT)", () => {
    const d = makeDecision({
      intent:  "MODIFY_STATE",
      context: { actor_id: "op", actor_role: "operator", session_id: "s", risk_level: "HIGH" },
    });
    expect(isModifyStateValid(d)).toBe(false);
  });

  test("MODIFY_STATE + MEDIUM → geçersiz (REJECT)", () => {
    const d = makeDecision({
      intent:  "MODIFY_STATE",
      context: { actor_id: "op", actor_role: "operator", session_id: "s", risk_level: "MEDIUM" },
    });
    expect(isModifyStateValid(d)).toBe(false);
  });

  test("WRITE_DATA + MEDIUM → geçerli (MODIFY_STATE değil)", () => {
    expect(isModifyStateValid(makeDecision())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAssumedStateValid — ARCHITECTURE §2.1 kısıtı
// ---------------------------------------------------------------------------

describe("isAssumedStateValid()", () => {
  test("assumed_state yok → her zaman geçerli", () => {
    expect(isAssumedStateValid(makeDecision())).toBe(true);
  });

  test("assumed_state + EXECUTE_ACTION → geçerli", () => {
    const d = makeDecision({
      intent:  "EXECUTE_ACTION",
      payload: { action_name: "run_job", params: {}, assumed_state: { status: "IDLE" } },
    });
    expect(isAssumedStateValid(d)).toBe(true);
  });

  test("assumed_state + MODIFY_STATE → geçerli", () => {
    const d = makeDecision({
      intent:  "MODIFY_STATE",
      payload: { action_name: "update_config", params: {}, assumed_state: { enabled: true } },
      context: { actor_id: "op", actor_role: "operator", session_id: "s", risk_level: "CRITICAL" },
    });
    expect(isAssumedStateValid(d)).toBe(true);
  });

  test("assumed_state + WRITE_DATA → geçersiz (REJECT)", () => {
    const d = makeDecision({
      intent:  "WRITE_DATA",
      payload: { action_name: "create_user", params: {}, assumed_state: { count: 5 } },
    });
    expect(isAssumedStateValid(d)).toBe(false);
  });

  test("assumed_state + READ_DATA → geçersiz (REJECT)", () => {
    const d = makeDecision({
      intent:  "READ_DATA",
      payload: { action_name: "get_user", params: {}, assumed_state: { active: true } },
    });
    expect(isAssumedStateValid(d)).toBe(false);
  });
});
