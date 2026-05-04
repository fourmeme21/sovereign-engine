/**
 * Sovereign Engine OS — Tip Sistemi Unit Testleri
 * patch / policy / execution / preflight / execution-token
 * @module tests/types/types.test
 */

import {
  isPatch,
  isConfidenceValid,
  isOperationsValid,
  type Patch,
} from "../../src/types/patch.js";

import {
  isPolicyResult,
  isPermit,
  isBlocking,
  isPriorityValid,
  type PolicyResult,
} from "../../src/types/policy.js";

import {
  isExecutionResult,
  isRollbackConsistent,
  type ExecutionResult,
} from "../../src/types/execution.js";

import {
  isPreFlightResult,
  shouldEscalateToHuman,
  isPreFlightClear,
  MAX_RE_EVALUATE_COUNT,
  type PreFlightResult,
} from "../../src/types/preflight.js";

import {
  isExecutionTokenPayload,
  isTokenExpired,
  isScopeValid,
  isExpiryConsistent,
  EXECUTION_TOKEN_EXPIRY_SECONDS,
  type ExecutionTokenPayload,
} from "../../src/types/execution-token.js";

// ===========================================================================
// PATCH
// ===========================================================================

describe("patch.ts", () => {
  const validPatch: Patch = {
    schema_version: "1.0",
    intent:         "Kullanıcı rolünü güncelle",
    risk_level:     "medium",
    confidence:     0.95,
    patch: {
      file:       "domain/project/config.ts",
      operations: [{ search: "role: \"viewer\"", replace: "role: \"editor\"" }],
    },
  };

  describe("isPatch()", () => {
    test("geçerli Patch → true", () => expect(isPatch(validPatch)).toBe(true));
    test("null → false", () => expect(isPatch(null)).toBe(false));
    test("schema_version eksik → false", () => {
      const p = { ...validPatch } as Record<string, unknown>;
      delete p["schema_version"];
      expect(isPatch(p)).toBe(false);
    });
    test("confidence string → false", () => {
      expect(isPatch({ ...validPatch, confidence: "high" })).toBe(false);
    });
  });

  describe("isConfidenceValid()", () => {
    test("0.0 → geçerli", () => expect(isConfidenceValid(0)).toBe(true));
    test("1.0 → geçerli", () => expect(isConfidenceValid(1)).toBe(true));
    test("0.5 → geçerli", () => expect(isConfidenceValid(0.5)).toBe(true));
    test("-0.1 → geçersiz (REJECT)", () => expect(isConfidenceValid(-0.1)).toBe(false));
    test("1.1 → geçersiz (REJECT)",  () => expect(isConfidenceValid(1.1)).toBe(false));
  });

  describe("isOperationsValid()", () => {
    test("geçerli operations → true", () => expect(isOperationsValid(validPatch)).toBe(true));
    test("boş operations → false (REJECT)", () => {
      const p: Patch = { ...validPatch, patch: { ...validPatch.patch, operations: [] } };
      expect(isOperationsValid(p)).toBe(false);
    });
    test("search boş string → false (REJECT)", () => {
      const p: Patch = {
        ...validPatch,
        patch: { ...validPatch.patch, operations: [{ search: "", replace: "x" }] },
      };
      expect(isOperationsValid(p)).toBe(false);
    });
  });
});

// ===========================================================================
// POLICY
// ===========================================================================

describe("policy.ts", () => {
  const permitResult: PolicyResult = {
    decision:        "PERMIT",
    priority:        10,
    execution_token: "eyJhbGciOiJIUzI1NiJ9.test.sig",
  };

  const denyResult: PolicyResult = {
    decision:   "DENY",
    priority:   1,
    error_code: "NOT_RESOURCE_OWNER",
    redirect:   "Kaynak sahibiyle iletişime geçin.",
  };

  describe("isPolicyResult()", () => {
    test("PERMIT → true", () => expect(isPolicyResult(permitResult)).toBe(true));
    test("DENY → true",   () => expect(isPolicyResult(denyResult)).toBe(true));
    test("null → false",  () => expect(isPolicyResult(null)).toBe(false));
    test("priority eksik → false", () => {
      const r = { decision: "PERMIT" };
      expect(isPolicyResult(r)).toBe(false);
    });
  });

  describe("isPermit()", () => {
    test("PERMIT + token → true",    () => expect(isPermit(permitResult)).toBe(true));
    test("PERMIT + token yok → false", () => {
      expect(isPermit({ decision: "PERMIT", priority: 5 })).toBe(false);
    });
    test("DENY → false", () => expect(isPermit(denyResult)).toBe(false));
  });

  describe("isBlocking()", () => {
    test("DENY + redirect → true",  () => expect(isBlocking(denyResult)).toBe(true));
    test("BLOCK + redirect → true", () => {
      const r: PolicyResult = { decision: "BLOCK", priority: 1, redirect: "Yasak." };
      expect(isBlocking(r)).toBe(true);
    });
    test("DENY + redirect yok → false (REJECT)", () => {
      expect(isBlocking({ decision: "DENY", priority: 1 })).toBe(false);
    });
    test("PERMIT → false", () => expect(isBlocking(permitResult)).toBe(false));
  });

  describe("isPriorityValid()", () => {
    test("1 → geçerli",  () => expect(isPriorityValid(1)).toBe(true));
    test("0 → geçersiz (NON_POSITIVE_VALUE)", () => expect(isPriorityValid(0)).toBe(false));
    test("-1 → geçersiz", () => expect(isPriorityValid(-1)).toBe(false));
  });
});

// ===========================================================================
// EXECUTION
// ===========================================================================

describe("execution.ts", () => {
  const successResult: ExecutionResult = {
    bundle_id:   "01952f3e-7b2a-7000-8000-000000000099",
    decision_id: "01952f3e-7b2a-7000-8000-000000000001",
    success:     true,
    audit_hash:  "sha256:abc123",
    timestamp:   "2026-05-04T08:30:00.000Z",
  };

  const failResult: ExecutionResult = {
    bundle_id:   "01952f3e-7b2a-7000-8000-000000000100",
    decision_id: "01952f3e-7b2a-7000-8000-000000000001",
    success:     false,
    rolled_back: true,
    audit_hash:  "sha256:def456",
    timestamp:   "2026-05-04T08:30:05.000Z",
    error:       "WRITE_FAIL",
  };

  describe("isExecutionResult()", () => {
    test("başarılı result → true", () => expect(isExecutionResult(successResult)).toBe(true));
    test("başarısız result → true", () => expect(isExecutionResult(failResult)).toBe(true));
    test("null → false", () => expect(isExecutionResult(null)).toBe(false));
    test("audit_hash eksik → false", () => {
      const r = { ...successResult } as Record<string, unknown>;
      delete r["audit_hash"];
      expect(isExecutionResult(r)).toBe(false);
    });
  });

  describe("isRollbackConsistent()", () => {
    test("success=true → tutarlı", () => expect(isRollbackConsistent(successResult)).toBe(true));
    test("success=false + rolled_back=true → tutarlı", () => expect(isRollbackConsistent(failResult)).toBe(true));
    test("success=false + rolled_back=false → tutarsız", () => {
      const r: ExecutionResult = { ...failResult, rolled_back: false };
      expect(isRollbackConsistent(r)).toBe(false);
    });
    test("success=false + rolled_back yok → tutarsız", () => {
      const r: ExecutionResult = { ...successResult, success: false };
      expect(isRollbackConsistent(r)).toBe(false);
    });
  });
});

// ===========================================================================
// PREFLIGHT
// ===========================================================================

describe("preflight.ts", () => {
  const clearResult: PreFlightResult   = { clear: true };
  const staleResult: PreFlightResult   = { clear: false, reason: "RE_EVALUATE", retry_count: 1 };
  const maxedResult: PreFlightResult   = { clear: false, reason: "RE_EVALUATE", retry_count: MAX_RE_EVALUATE_COUNT };

  describe("isPreFlightResult()", () => {
    test("clear=true → true",  () => expect(isPreFlightResult(clearResult)).toBe(true));
    test("clear=false → true", () => expect(isPreFlightResult(staleResult)).toBe(true));
    test("null → false",       () => expect(isPreFlightResult(null)).toBe(false));
    test("clear eksik → false", () => expect(isPreFlightResult({})).toBe(false));
  });

  describe("isPreFlightClear()", () => {
    test("clear=true → true",  () => expect(isPreFlightClear(clearResult)).toBe(true));
    test("clear=false → false", () => expect(isPreFlightClear(staleResult)).toBe(false));
  });

  describe("shouldEscalateToHuman()", () => {
    test(`retry_count=${MAX_RE_EVALUATE_COUNT} → ASK_HUMAN tetiklenir`, () => {
      expect(shouldEscalateToHuman(maxedResult)).toBe(true);
    });
    test("retry_count=1 → henüz tetiklenmez", () => {
      expect(shouldEscalateToHuman(staleResult)).toBe(false);
    });
    test("clear=true → tetiklenmez", () => {
      expect(shouldEscalateToHuman(clearResult)).toBe(false);
    });
    test("reason=ENTITY_INACTIVE → tetiklenmez", () => {
      const r: PreFlightResult = { clear: false, reason: "ENTITY_INACTIVE", retry_count: 5 };
      expect(shouldEscalateToHuman(r)).toBe(false);
    });
  });
});

// ===========================================================================
// EXECUTION TOKEN
// ===========================================================================

describe("execution-token.ts", () => {
  const NOW = 1746345600;
  const validPayload: ExecutionTokenPayload = {
    decision_id: "01952f3e-7b2a-7000-8000-000000000001",
    policy_hash: "sha256:abc123def456",
    actor_id:    "operator-1",
    action_name: "create_user",
    issued_at:   NOW,
    expires_at:  NOW + EXECUTION_TOKEN_EXPIRY_SECONDS,
    scope:       "USER_MANAGEMENT:create_user",
  };

  describe("isExecutionTokenPayload()", () => {
    test("geçerli payload → true", () => expect(isExecutionTokenPayload(validPayload)).toBe(true));
    test("null → false", () => expect(isExecutionTokenPayload(null)).toBe(false));
    test("expires_at string → false", () => {
      expect(isExecutionTokenPayload({ ...validPayload, expires_at: "2026-05-04" })).toBe(false);
    });
  });

  describe("isTokenExpired()", () => {
    test("now < expires_at → geçerli", () => {
      expect(isTokenExpired(validPayload, NOW + 10)).toBe(false);
    });
    test("now === expires_at → süresi dolmuş (TOCTOU)", () => {
      expect(isTokenExpired(validPayload, NOW + EXECUTION_TOKEN_EXPIRY_SECONDS)).toBe(true);
    });
    test("now > expires_at → süresi dolmuş", () => {
      expect(isTokenExpired(validPayload, NOW + 60)).toBe(true);
    });
  });

  describe("isScopeValid()", () => {
    test("scope eşleşiyor → true", () => {
      expect(isScopeValid(validPayload, "USER_MANAGEMENT", "create_user")).toBe(true);
    });
    test("category yanlış → false", () => {
      expect(isScopeValid(validPayload, "FINANCIAL", "create_user")).toBe(false);
    });
    test("action_name yanlış → false", () => {
      expect(isScopeValid(validPayload, "USER_MANAGEMENT", "delete_user")).toBe(false);
    });
  });

  describe("isExpiryConsistent()", () => {
    test("expires_at = issued_at + 30 → tutarlı", () => {
      expect(isExpiryConsistent(validPayload)).toBe(true);
    });
    test("expires_at = issued_at + 60 → tutarsız", () => {
      const p: ExecutionTokenPayload = { ...validPayload, expires_at: NOW + 60 };
      expect(isExpiryConsistent(p)).toBe(false);
    });
  });
});
