import { v4 as uuid } from "uuid";
import { ASTParser } from "./astParser.js";
const parser = new ASTParser();
export function generateSemanticDiff(projectId, filePath, beforeContent, afterContent, options = {}) {
    const traceId = options.traceId || uuid();
    const beforeChunks = beforeContent ? parser.parse(beforeContent, filePath) : [];
    const afterChunks = parser.parse(afterContent, filePath);
    const beforeMap = new Map(beforeChunks.map((c) => [c.name, c]));
    const afterMap = new Map(afterChunks.map((c) => [c.name, c]));
    const symbolsAdded = [];
    const symbolsRemoved = [];
    const symbolsModified = [];
    for (const [name, chunk] of afterMap) {
        if (!beforeMap.has(name)) {
            symbolsAdded.push(toSymbolDelta(chunk, "ADD_FUNCTION"));
        }
        else {
            const prev = beforeMap.get(name);
            if (prev.body !== chunk.body) {
                symbolsModified.push({
                    ...toSymbolDelta(chunk, "MODIFY_FUNCTION"),
                    linesBefore: prev.endLine - prev.startLine,
                    linesAfter: chunk.endLine - chunk.startLine,
                });
            }
        }
    }
    for (const [name, chunk] of beforeMap) {
        if (!afterMap.has(name)) {
            symbolsRemoved.push(toSymbolDelta(chunk, "DELETE_FUNCTION"));
        }
    }
    const beforeImports = new Set(beforeChunks[0]?.imports || []);
    const afterImports = new Set(afterChunks[0]?.imports || []);
    const importsAdded = [...afterImports].filter((i) => !beforeImports.has(i));
    const importsRemoved = [...beforeImports].filter((i) => !afterImports.has(i));
    const beforeLines = beforeContent.split("\n").length;
    const afterLines = afterContent.split("\n").length;
    const linesAdded = Math.max(0, afterLines - beforeLines);
    const linesRemoved = Math.max(0, beforeLines - afterLines);
    const riskFactors = computeRiskFactors(filePath, symbolsRemoved, symbolsModified, importsAdded, linesAdded + linesRemoved);
    const riskScore = computeRiskScore(riskFactors, symbolsAdded, symbolsRemoved, symbolsModified);
    return {
        id: uuid(),
        project_id: projectId,
        file_path: filePath,
        commit_sha: options.commitSha,
        branch: options.branch || "main",
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        net_change: afterLines - beforeLines,
        symbols_added: symbolsAdded,
        symbols_removed: symbolsRemoved,
        symbols_modified: symbolsModified,
        imports_added: importsAdded,
        imports_removed: importsRemoved,
        risk_factors: riskFactors,
        risk_score: riskScore,
        trace_id: traceId,
        generated_at: new Date().toISOString(),
    };
}
function toSymbolDelta(chunk, intent) {
    return {
        name: chunk.name,
        type: chunk.type,
        intent,
        linesAfter: chunk.endLine - chunk.startLine,
    };
}
function computeRiskFactors(filePath, symbolsRemoved, symbolsModified, importsAdded, totalLineChange) {
    const p = filePath.toLowerCase();
    return {
        touches_auth: /auth|login|session|token|password/.test(p),
        touches_payment: /payment|billing|stripe|invoice|subscription/.test(p),
        touches_security: /security|middleware|policy|guard|permission/.test(p),
        deletes_symbols: symbolsRemoved.length > 0,
        modifies_exports: symbolsModified.some((s) => s.name[0] !== "_"),
        large_change: totalLineChange > 50,
        adds_imports: importsAdded.length > 0,
    };
}
function computeRiskScore(factors, added, removed, modified) {
    let score = 0;
    if (factors.touches_auth)
        score += 4;
    if (factors.touches_payment)
        score += 4;
    if (factors.touches_security)
        score += 3;
    if (factors.deletes_symbols)
        score += 3;
    if (factors.modifies_exports)
        score += 2;
    if (factors.large_change)
        score += 2;
    if (factors.adds_imports)
        score += 1;
    if (removed.length > 3)
        score += 2;
    if (modified.length > 5)
        score += 1;
    return Math.min(10, Math.round(score));
}
//# sourceMappingURL=diffEngine.js.map