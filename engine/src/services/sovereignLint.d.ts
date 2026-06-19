export interface LintViolation {
    rule: string;
    severity: 'FAIL' | 'WARN';
    file?: string;
    line?: number;
    message: string;
}
export interface LintResult {
    score: number;
    maxScore: number;
    passed: boolean;
    violations: LintViolation[];
    warns: LintViolation[];
    summary: string;
}
export declare function runSovereignLint(code: string, filename?: string): LintResult;
//# sourceMappingURL=sovereignLint.d.ts.map