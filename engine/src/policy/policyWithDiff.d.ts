import { SemanticDiff } from "../memory/semanticDiff.types.js";
export type PolicyVerdict = "PERMIT" | "DENY" | "ASK_HUMAN" | "AUTO_APPROVED";
export interface PolicyResult {
    verdict: PolicyVerdict;
    reason: string;
    policy_id: string;
    requires_human: boolean;
}
export declare function evaluateDiffPolicy(diff: SemanticDiff, projectId: string): Promise<PolicyResult>;
//# sourceMappingURL=policyWithDiff.d.ts.map