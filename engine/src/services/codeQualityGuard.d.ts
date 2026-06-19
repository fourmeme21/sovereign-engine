import Anthropic from '@anthropic-ai/sdk';
import { LintResult } from './sovereignLint.js';
export interface JudgeVerdict {
    passed: boolean;
    score: number;
    confidence: number;
    failed_checks: string[];
    todos: string[];
}
export interface QualityGuardResult {
    code: string;
    lintResult: LintResult;
    judgeVerdict: JudgeVerdict | null;
    iterations: number;
    passed: boolean;
    escalated: boolean;
}
export interface GuardContext {
    client: Anthropic;
    originalPrompt: string;
    rawReply: string;
    filename?: string;
}
export declare function runCodeQualityGuard(ctx: GuardContext): Promise<QualityGuardResult>;
//# sourceMappingURL=codeQualityGuard.d.ts.map