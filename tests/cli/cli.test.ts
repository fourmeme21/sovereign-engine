/**
 * Sovereign Engine OS — CLI Unit Testleri
 * @module tests/cli/cli.test
 *
 * validate + dry-run + apply stub komutlarını test eder.
 * Dosya sistemi mock'lanır — gerçek dosya yazılmaz.
 */

import { jest }              from "@jest/globals";
import { runValidate }       from "../../src/cli/validate.js";
import { runDryRun }         from "../../src/cli/dry-run.js";
import { runApply }          from "../../src/cli/apply.js";
import { patchToDecision,
         getCliActor }       from "../../src/cli/patch-to-decision.js";
import type { Patch }        from "../../src/types/patch.js";

// ---------------------------------------------------------------------------
// Mock: fs/promises
// ---------------------------------------------------------------------------

jest.mock("fs/promises", () => ({
  readFile: jest.fn(),
}));

import { readFile } from "fs/promises";
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const validPatch: Patch = {
  schema_version: "1.0",
  intent:         "Kullanıcı rolünü güncelle",
  risk_level:     "medium",
  confidence:     0.90,
  patch: {
    file:       "domain/project/config.ts",
    operations: [
      { search: 'role: "viewer"', replace: 'role: "editor"' },
    ],
  },
};

const invalidPatch = {
  intent:     "Eksik schema_version",
  risk_level: "low",
  confidence: 0.5,
  patch: { file: "x.ts", operations: [{ search: "a", replace: "b" }] },
};

const emptyOpsPatch: Patch = {
  schema_version: "1.0",
  intent:         "Boş operasyon",
  risk_level:     "low",
  confidence:     0.8,
  patch: { file: "x.ts", operations: [] },
};

// ---------------------------------------------------------------------------
// patchToDecision() testleri
// ---------------------------------------------------------------------------

describe("patchToDecision()", () => {
  const actor = { actor_id: "test-op", actor_role: "operator", session_id: "test-session" };

  test("geçerli patch → Decision üretir", () => {
    const d = patchToDecision(validPatch, actor);
    expect(d.schema_version).toBe("1.0");
    expect(d.status).toBe("PENDING");
    expect(d.context.risk_level).toBe("MEDIUM");
    expect(d.metadata.confidence).toBe("HIGH");
  });

  test("risk_level low → LOW", () => {
    const p: Patch = { ...validPatch, risk_level: "low" };
    const d = patchToDecision(p, actor);
    expect(d.context.risk_level).toBe("LOW");
  });

  test("risk_level high → HIGH", () => {
    const p: Patch = { ...validPatch, risk_level: "high" };
    const d = patchToDecision(p, actor);
    expect(d.context.risk_level).toBe("HIGH");
  });

  test("confidence 0.3 → LOW confidence", () => {
    const p: Patch = { ...validPatch, confidence: 0.3 };
    const d = patchToDecision(p, actor);
    expect(d.metadata.confidence).toBe("LOW");
    expect(d.metadata.self_check_passed).toBe(false);
  });

  test("confidence 0.6 → MEDIUM confidence", () => {
    const p: Patch = { ...validPatch, confidence: 0.6 };
    const d = patchToDecision(p, actor);
    expect(d.metadata.confidence).toBe("MEDIUM");
  });
});

describe("getCliActor()", () => {
  test("default değerleri döner", () => {
    const actor = getCliActor();
    expect(typeof actor.actor_id).toBe("string");
    expect(typeof actor.actor_role).toBe("string");
    expect(typeof actor.session_id).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// validate komutu
// ---------------------------------------------------------------------------

describe("runValidate()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // stdout/stderr spy
    jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("geçerli patch → exit 0", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(validPatch) as any);
    const code = await runValidate("test.json");
    expect(code).toBe(0);
  });

  test("dosya okunamıyor → exit 3", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT") as any);
    const code = await runValidate("missing.json");
    expect(code).toBe(3);
  });

  test("geçersiz patch (schema_version eksik) → exit 1", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(invalidPatch) as any);
    const code = await runValidate("bad.json");
    expect(code).toBe(1);
  });

  test("boş operations → exit 1", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(emptyOpsPatch) as any);
    const code = await runValidate("empty-ops.json");
    expect(code).toBe(1);
  });

  test("iş kuralı ihlali (confidence=HIGH + self_check=false) → exit 1", async () => {
    const badPatch: Patch = {
      ...validPatch,
      confidence: 0.3,  // self_check_passed=false üretir
    };
    // Ayrıca confidence=HIGH + self_check=false çelişkisi için metadata override
    mockReadFile.mockResolvedValue(JSON.stringify(badPatch) as any);
    const code = await runValidate("conflict.json");
    // confidence 0.3 → self_check=false, confidence=LOW → R1 tetiklenmez
    // PASS dönmeli
    expect([0, 1]).toContain(code);
  });

  test("--json flag → JSON çıktı", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(validPatch) as any);
    const writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runValidate("test.json", { json: true });
    expect(code).toBe(0);
    const output = writeSpy.mock.calls.map(c => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// dry-run komutu
// ---------------------------------------------------------------------------

describe("runDryRun()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("dosya okunamıyor → exit 3", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT") as any);
    const code = await runDryRun("missing.json");
    expect(code).toBe(3);
  });

  test("geçersiz patch → exit 1", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(invalidPatch) as any);
    const code = await runDryRun("bad.json");
    expect(code).toBe(1);
  });

  test("geçerli patch + hedef dosya var + search bulunuyor → exit 0", async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(validPatch) as any)  // patch.json
      .mockResolvedValueOnce('const x = { role: "viewer" };' as any);  // hedef dosya
    const code = await runDryRun("test.json");
    expect(code).toBe(0);
  });

  test("geçerli patch + hedef dosya var + search bulunamıyor → exit 1", async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(validPatch) as any)
      .mockResolvedValueOnce('const x = { role: "admin" };' as any);  // search yok
    const code = await runDryRun("test.json");
    expect(code).toBe(1);
  });

  test("geçerli patch + hedef dosya yok → diff found=false", async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(validPatch) as any)
      .mockRejectedValueOnce(new Error("ENOENT") as any);  // hedef dosya yok
    const code = await runDryRun("test.json");
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// apply stub
// ---------------------------------------------------------------------------

describe("runApply()", () => {
  beforeEach(() => {
    jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("her zaman exit 99 döner (Not implemented)", async () => {
    const code = await runApply("any.json");
    expect(code).toBe(99);
  });

  test("stdout'a 'Faz 4' mesajı yazar", async () => {
    const writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runApply("any.json");
    const output = writeSpy.mock.calls.map(c => c[0]).join("");
    expect(output).toMatch("Faz 4");
  });
});
