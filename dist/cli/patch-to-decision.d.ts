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
import type { Decision } from "../types/decision.js";
import type { Patch } from "../types/patch.js";
/** CLI actor bilgisi — env'den veya default */
export interface CliActor {
    actor_id: string;
    actor_role: string;
    session_id: string;
}
/**
 * Patch JSON'ı Decision Object'e dönüştürür.
 * status: "PENDING" — Katman 1'in görevi.
 *
 * SAP-08: intent artık intentFromPatch(patch.risk_level) ile türetilir.
 *   Önceki: intent: "WRITE_DATA"  (hardcoded — yanlış)
 *   Şimdi:  intent: intentFromPatch(patch.risk_level)  (dinamik — doğru)
 */
export declare function patchToDecision(patch: Patch, actor: CliActor): Decision;
/** Ortam değişkenlerinden CLI actor bilgisini okur */
export declare function getCliActor(): CliActor;
//# sourceMappingURL=patch-to-decision.d.ts.map