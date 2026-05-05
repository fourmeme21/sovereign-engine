/**
 * Sovereign Engine OS — Validation Error Formatı Unit Testleri
 * @module tests/validation/errors.test
 */

import { makeError, formatError, formatErrors, toLogEntry } from "../../src/validation/errors.js";

describe("makeError()", () => {
  test("katalogdaki kod → doğru mesaj ve redirect döner", () => {
    const e = makeError("MODIFY_STATE_NOT_CRITICAL", { rule: "R3" });
    expect(e.code).toBe("MODIFY_STATE_NOT_CRITICAL");
    expect(e.rule).toBe("R3");
    expect(e.severity).toBe("ERROR");
    expect(e.redirect.length).toBeGreaterThan(0);
    expect(e.hint.length).toBeGreaterThan(0);
  });

  test("override message → özel mesaj kullanılır", () => {
    const e = makeError("MISSING_FIELD", { field: "context.actor_id", message: "actor_id zorunludur" });
    expect(e.message).toBe("actor_id zorunludur");
    expect(e.field).toBe("context.actor_id");
  });

  test("RE_EVALUATE_LIMIT_REACHED → severity WARNING", () => {
    const e = makeError("RE_EVALUATE_LIMIT_REACHED");
    expect(e.severity).toBe("WARNING");
  });

  test("tüm hata kodları katalogda mevcut", () => {
    const codes = [
      "MISSING_FIELD", "INVALID_VERSION", "INVALID_FORMAT", "INVALID_TYPE",
      "NON_POSITIVE_VALUE", "CONFIDENCE_SELF_CHECK_CONFLICT", "CRITICAL_HIGH_CONFIDENCE",
      "MODIFY_STATE_NOT_CRITICAL", "ASSUMED_STATE_INVALID_INTENT", "RE_EVALUATE_LIMIT_REACHED",
      "IMMUTABLE_STATE", "INVALID_ENTRY_STATUS", "EMPTY_ACTOR_ID", "INVALID_HIERARCHY_PATH",
      "PRE_FLIGHT_STALE", "PRE_FLIGHT_ENTITY_INACTIVE", "UNKNOWN",
    ] as const;
    codes.forEach(code => {
      const e = makeError(code);
      expect(e.message.length).toBeGreaterThan(0);
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.redirect.length).toBeGreaterThan(0);
    });
  });
});

describe("formatError()", () => {
  test("ERROR → ✗ prefix ile başlar", () => {
    const e = makeError("MISSING_FIELD", { field: "id" });
    expect(formatError(e)).toMatch("✗");
  });

  test("WARNING → ⚠ prefix ile başlar", () => {
    const e = makeError("RE_EVALUATE_LIMIT_REACHED");
    expect(formatError(e)).toMatch("⚠");
  });

  test("rule varsa [R3] formatında gösterilir", () => {
    const e = makeError("MODIFY_STATE_NOT_CRITICAL", { rule: "R3" });
    expect(formatError(e)).toMatch("[R3]");
  });

  test("field varsa 'Alan' satırı gösterilir", () => {
    const e = makeError("MISSING_FIELD", { field: "context.actor_id" });
    expect(formatError(e)).toMatch("context.actor_id");
  });

  test("Öneri ve Referans satırları her zaman gösterilir", () => {
    const e = makeError("IMMUTABLE_STATE");
    const output = formatError(e);
    expect(output).toMatch("Öneri");
    expect(output).toMatch("Referans");
  });
});

describe("formatErrors()", () => {
  test("birden fazla hata — hepsi birleştirilir", () => {
    const errors = [
      makeError("MISSING_FIELD", { field: "id" }),
      makeError("INVALID_VERSION"),
    ];
    const output = formatErrors(errors);
    expect(output).toMatch("MISSING_FIELD");
    expect(output).toMatch("INVALID_VERSION");
  });

  test("boş dizi → boş string", () => {
    expect(formatErrors([])).toBe("");
  });
});

describe("toLogEntry()", () => {
  test("JSON serileştirilebilir log üretir", () => {
    const e     = makeError("MODIFY_STATE_NOT_CRITICAL", { rule: "R3" });
    const entry = toLogEntry(e, "decision-id-1");
    expect(entry["decision_id"]).toBe("decision-id-1");
    expect(entry["code"]).toBe("MODIFY_STATE_NOT_CRITICAL");
    expect(entry["rule"]).toBe("R3");
    expect(typeof entry["timestamp"]).toBe("string");
    expect(() => JSON.stringify(entry)).not.toThrow();
  });

  test("decision_id verilmezse null", () => {
    const e     = makeError("UNKNOWN");
    const entry = toLogEntry(e);
    expect(entry["decision_id"]).toBeNull();
  });
});
