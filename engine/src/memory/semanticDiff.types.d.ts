export type ChangeIntent = "ADD_FUNCTION" | "DELETE_FUNCTION" | "MODIFY_FUNCTION" | "ADD_CLASS" | "DELETE_CLASS" | "ADD_INTERFACE" | "RENAME_SYMBOL" | "RESTRUCTURE" | "IMPORT_CHANGE";
export interface SymbolDelta {
    name: string;
    type: "function" | "class" | "interface" | "type" | "constant";
    intent: ChangeIntent;
    linesBefore?: number;
    linesAfter?: number;
}
export interface RiskFactors {
    touches_auth: boolean;
    touches_payment: boolean;
    touches_security: boolean;
    deletes_symbols: boolean;
    modifies_exports: boolean;
    large_change: boolean;
    adds_imports: boolean;
}
export interface SemanticDiff {
    id: string;
    project_id: string;
    file_path: string;
    commit_sha?: string;
    branch: string;
    lines_added: number;
    lines_removed: number;
    net_change: number;
    symbols_added: SymbolDelta[];
    symbols_removed: SymbolDelta[];
    symbols_modified: SymbolDelta[];
    imports_added: string[];
    imports_removed: string[];
    risk_factors: RiskFactors;
    risk_score: number;
    trace_id: string;
    generated_at: string;
    semantic_summary?: string;
}
//# sourceMappingURL=semanticDiff.types.d.ts.map