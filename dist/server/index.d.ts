export type Verdict = 'PERMIT' | 'DENY' | 'ASK_HUMAN';
export type Criticality = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export interface Decision {
    id: string;
    action: string;
    criticality: Criticality;
    verdict: Verdict;
    policy: string;
    reason: string;
    token: string | null;
    time: string;
    latency: string;
}
export interface WsMessage {
    type: 'init' | 'decision' | 'ping';
    decisions?: Decision[];
    decision?: Decision;
}
//# sourceMappingURL=index.d.ts.map