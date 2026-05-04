/**
 * Sovereign Engine OS — Fixture Entegrasyon Testleri
 * @module tests/validation/fixtures.test
 *
 * decisions.json içindeki 20 fixture'ı ValidationEngine'den geçirir.
 * _valid: true  → PASS beklenir
 * _valid: false → REJECTED veya ASK_HUMAN beklenir
 */

import { createReadStream }       from "fs";
import { readFile }               from "fs/promises";
import { join, dirname }          from "path";
import { fileURLToPath }          from "url";
import { createValidationEngine } from "../../src/validation/engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, "../fixtures/decisions.json");

interface Fixture {
  _fixture_id:    number;
  _valid:         boolean;
  _note?:         string;
  _reject_reason?: string;
  [key: string]:  unknown;
}

describe("decisions.json fixture entegrasyon testleri", () => {
  let fixtures: Fixture[];
  const engine = createValidationEngine();

  beforeAll(async () => {
    const raw = await readFile(FIXTURES_PATH, "utf-8");
    fixtures = JSON.parse(raw) as Fixture[];
  });

  test("fixtures.json 20 fixture içeriyor", () => {
    expect(fixtures).toHaveLength(20);
  });

  test("12 geçerli, 8 geçersiz fixture var", () => {
    const valid   = fixtures.filter(f => f._valid).length;
    const invalid = fixtures.filter(f => !f._valid).length;
    expect(valid).toBe(12);
    expect(invalid).toBe(8);
  });

  describe("Geçerli fixture'lar → PASS", () => {
    const validIds = [1, 2, 3, 4, 5, 6, 7, 8, 19, 20];

    validIds.forEach((id) => {
      test(`Fixture #${id} → PASS`, async () => {
        const fixture = fixtures.find(f => f._fixture_id === id);
        expect(fixture).toBeDefined();

        // Fixture meta alanlarını temizle
        const { _fixture_id, _valid, _note, _reject_reason, ...decision } = fixture!;
        void _fixture_id; void _valid; void _note; void _reject_reason;

        const result = await engine.validate(decision);
        expect(result.status).toBe("PASS");
      });
    });
  });

  describe("Geçersiz fixture'lar → REJECTED veya ASK_HUMAN", () => {
    const invalidIds = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

    invalidIds.forEach((id) => {
      test(`Fixture #${id} → REJECTED`, async () => {
        const fixture = fixtures.find(f => f._fixture_id === id);
        expect(fixture).toBeDefined();

        const { _fixture_id, _valid, _note, _reject_reason, ...decision } = fixture!;
        void _fixture_id; void _valid; void _note; void _reject_reason;

        const result = await engine.validate(decision);
        expect(["REJECTED", "ASK_HUMAN"]).toContain(result.status);
      });
    });
  });

  test("Tüm geçerli fixture'lar PASS döner", async () => {
    const validFixtures = fixtures.filter(f => f._valid);
    for (const fixture of validFixtures) {
      const { _fixture_id, _valid, _note, _reject_reason, ...decision } = fixture;
      void _fixture_id; void _valid; void _note; void _reject_reason;
      const result = await engine.validate(decision);
      expect(result.status).toBe("PASS");
    }
  });

  test("Tüm geçersiz fixture'lar REJECTED/ASK_HUMAN döner", async () => {
    const invalidFixtures = fixtures.filter(f => !f._valid);
    for (const fixture of invalidFixtures) {
      const { _fixture_id, _valid, _note, _reject_reason, ...decision } = fixture;
      void _fixture_id; void _valid; void _note; void _reject_reason;
      const result = await engine.validate(decision);
      expect(["REJECTED", "ASK_HUMAN"]).toContain(result.status);
    }
  });
});
