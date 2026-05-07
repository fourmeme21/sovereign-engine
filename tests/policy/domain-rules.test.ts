/**
 * Sovereign Engine OS — Domain Rules Unit Testleri
 * @module tests/policy/domain-rules.test
 */

import {
  PolicyRegistry,
  registerPolicy,
  globalPolicyRegistry,
} from "../../src/policy/domain-rules.js";
import type { Decision } from "../../src/types/decision.js";

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    schema_version: "1.0",
    id:             "test-id-1",
    created_at:     "2026-05-06T08:00:00.000Z",
    intent:         "WRITE_DATA",
    category:       "USER_MANAGEMENT",
    payload:        { action_name: "create_user", params: {} },
    context:        { actor_id: "op-1", actor_role: "operator", session_id: "s", risk_level: "MEDIUM" },
    metadata:       { model: "claude-sonnet-4-6", session_number: 8, confidence: "HIGH", self_check_passed: true },
    status:         "VALIDATED",
    ...overrides,
  } as Decision;
}

describe("PolicyRegistry", () => {
  let registry: PolicyRegistry;

  beforeEach(() => { registry = new PolicyRegistry(); });

  // ── Temel kayıt ────────────────────────────────────────────
  test("kural kayıt edilir", () => {
    registry.registerPolicy({
      name:     "test_rule",
      priority: 10,
      evaluate: () => "PERMIT",
      redirect: "Test redirect",
    });
    expect(registry.count).toBe(1);
  });

  test("priority ≤ 0 → hata fırlatır", () => {
    expect(() => registry.registerPolicy({
      name: "bad", priority: 0, evaluate: () => "PERMIT", redirect: "",
    })).toThrow("NON_POSITIVE_VALUE");
  });

  test("aynı isim → güncellenir", () => {
    registry.registerPolicy({ name: "r1", priority: 10, evaluate: () => "PERMIT", redirect: "" });
    registry.registerPolicy({ name: "r1", priority: 20, evaluate: () => "DENY",   redirect: "redirect" });
    expect(registry.count).toBe(1);
    const result = registry.evaluate(makeDecision());
    expect(result.outcome).toBe("DENY");
  });

  // ── Öncelik sırası ─────────────────────────────────────────
  test("yüksek priority önce değerlendirilir", () => {
    registry.registerPolicy({ name: "low",  priority: 5,  evaluate: () => "DENY",   redirect: "low" });
    registry.registerPolicy({ name: "high", priority: 10, evaluate: () => "PERMIT", redirect: "high" });
    const result = registry.evaluate(makeDecision());
    expect(result.outcome).toBe("PERMIT");
    expect(result.rule).toBe("high");
  });

  test("önce yüksek priority çalışır — eşit priority kayıt sırasına göre", () => {
    const called: string[] = [];
    registry.registerPolicy({ name: "r1", priority: 10, evaluate: () => { called.push("r1"); return null; }, redirect: "" });
    registry.registerPolicy({ name: "r2", priority: 10, evaluate: () => { called.push("r2"); return null; }, redirect: "" });
    registry.evaluate(makeDecision());
    expect(called).toEqual(["r1", "r2"]);
  });

  // ── Filtreler ──────────────────────────────────────────────
  test("category filtresi — eşleşmiyor → atlanır", () => {
    registry.registerPolicy({
      name:       "only_payment",
      priority:   10,
      categories: ["PAYMENT"],
      evaluate:   () => "PERMIT",
      redirect:   "",
    });
    const result = registry.evaluate(makeDecision({ category: "USER_MANAGEMENT" }));
    expect(result.matched).toBe(false);
    expect(result.outcome).toBe("DENY"); // default DENY
  });

  test("category filtresi — eşleşiyor → çalışır", () => {
    registry.registerPolicy({
      name:       "payment_rule",
      priority:   10,
      categories: ["PAYMENT"],
      evaluate:   () => "PERMIT",
      redirect:   "",
    });
    const result = registry.evaluate(makeDecision({ category: "PAYMENT" }));
    expect(result.matched).toBe(true);
    expect(result.outcome).toBe("PERMIT");
  });

  test("intent filtresi — eşleşmiyor → atlanır", () => {
    registry.registerPolicy({
      name:    "read_only",
      priority: 10,
      intents: ["READ_DATA"],
      evaluate: () => "PERMIT",
      redirect: "",
    });
    const result = registry.evaluate(makeDecision({ intent: "WRITE_DATA" }));
    expect(result.matched).toBe(false);
  });

  // ── Default DENY ───────────────────────────────────────────
  test("kural yok → default DENY", () => {
    const result = registry.evaluate(makeDecision());
    expect(result.outcome).toBe("DENY");
    expect(result.matched).toBe(false);
    expect(result.redirect).toBeTruthy();
  });

  test("tüm kurallar null döner → default DENY", () => {
    registry.registerPolicy({ name: "r", priority: 10, evaluate: () => null, redirect: "" });
    const result = registry.evaluate(makeDecision());
    expect(result.outcome).toBe("DENY");
    expect(result.matched).toBe(false);
  });

  // ── İlk eşleşmede dur ─────────────────────────────────────
  test("PERMIT sonrası diğer kurallar çalışmaz", () => {
    let secondCalled = false;
    registry.registerPolicy({ name: "first",  priority: 10, evaluate: () => "PERMIT", redirect: "" });
    registry.registerPolicy({ name: "second", priority: 5,  evaluate: () => { secondCalled = true; return "DENY"; }, redirect: "" });
    registry.evaluate(makeDecision());
    expect(secondCalled).toBe(false);
  });

  // ── Soft steer ────────────────────────────────────────────
  test("DENY → redirect dolu olmalı", () => {
    registry.registerPolicy({
      name:     "deny_rule",
      priority: 10,
      evaluate: () => "DENY",
      redirect: "Bu işlem için yetkiniz yok.",
    });
    const result = registry.evaluate(makeDecision());
    expect(result.outcome).toBe("DENY");
    expect(result.redirect).toBe("Bu işlem için yetkiniz yok.");
  });

  test("PERMIT → redirect yok", () => {
    registry.registerPolicy({ name: "permit", priority: 10, evaluate: () => "PERMIT", redirect: "" });
    const result = registry.evaluate(makeDecision());
    expect(result.outcome).toBe("PERMIT");
    expect(result.redirect).toBeUndefined();
  });

  // ── ASK_HUMAN ─────────────────────────────────────────────
  test("ASK_HUMAN outcome destekleniyor", () => {
    registry.registerPolicy({
      name:     "human_needed",
      priority: 10,
      evaluate: (d) => d.context.risk_level === "HIGH" ? "ASK_HUMAN" : null,
      redirect: "Yüksek riskli işlem — insan onayı gerekli.",
    });
    const result = registry.evaluate(makeDecision({ context: { actor_id: "op", actor_role: "op", session_id: "s", risk_level: "HIGH" } }));
    expect(result.outcome).toBe("ASK_HUMAN");
  });

  // ── clear() ───────────────────────────────────────────────
  test("clear() tüm kuralları temizler", () => {
    registry.registerPolicy({ name: "r", priority: 10, evaluate: () => "PERMIT", redirect: "" });
    registry.clear();
    expect(registry.count).toBe(0);
  });
});

// ── registerPolicy global test ───────────────────────────────
describe("registerPolicy() global registry", () => {
  afterEach(() => { globalPolicyRegistry.clear(); });

  test("global registry'e kayıt edilir", () => {
    const before = globalPolicyRegistry.count;
    registerPolicy({ name: "global_test", priority: 10, evaluate: () => "PERMIT", redirect: "" });
    expect(globalPolicyRegistry.count).toBe(before + 1);
    globalPolicyRegistry.clear();
  });
});
