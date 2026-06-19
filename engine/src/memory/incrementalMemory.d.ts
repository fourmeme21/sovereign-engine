export type DecisionAction = "APPROVE" | "REJECT" | "AUTO_APPROVED";
export interface DecisionEventParams {
    projectId: string;
    filePath: string;
    riskScore: number;
    traceId?: string;
    action: DecisionAction;
    reason: string;
    policyId?: string;
    phase?: string;
    taskCard?: string;
}
export declare function writeDecisionEvent(params: DecisionEventParams): Promise<void>;
//# sourceMappingURL=incrementalMemory.d.ts.map