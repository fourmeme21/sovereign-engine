import { supabase } from "../lib/supabase.js";
export async function evaluateDiffPolicy(diff, projectId) {
    // HARD LOCK 1: Kritik dosyalarda sembol silme → ASK_HUMAN
    if (diff.risk_factors.touches_auth && diff.risk_factors.deletes_symbols) {
        return {
            verdict: "ASK_HUMAN",
            reason: `Auth modülünde fonksiyon siliniyor: ${diff.symbols_removed.map(s => s.name).join(", ")}`,
            policy_id: "POL-DIFF-001",
            requires_human: true,
        };
    }
    // HARD LOCK 2: Payment + büyük değişiklik → ASK_HUMAN
    if (diff.risk_factors.touches_payment && diff.risk_factors.large_change) {
        return {
            verdict: "ASK_HUMAN",
            reason: `Ödeme modülünde ${diff.net_change > 0 ? "+" : ""}${diff.net_change} satır değişiklik`,
            policy_id: "POL-DIFF-002",
            requires_human: true,
        };
    }
    // SOFT LOCK: Son 1 saatte aynı dosyaya çok fazla değişiklik
    const recentCount = await getRecentDiffCount(projectId, diff.file_path, 60);
    if (recentCount >= 5) {
        return {
            verdict: "ASK_HUMAN",
            reason: `${diff.file_path} son 1 saatte ${recentCount}. kez değişiyor — inceleme gerekiyor`,
            policy_id: "POL-DIFF-003",
            requires_human: true,
        };
    }
    // Risk skoru bazlı karar
    if (diff.risk_score >= 7) {
        return {
            verdict: "ASK_HUMAN",
            reason: `Yüksek risk (${diff.risk_score}/10): ${describeRisk(diff)}`,
            policy_id: "POL-DIFF-004",
            requires_human: true,
        };
    }
    if (diff.risk_score >= 4) {
        return {
            verdict: "PERMIT",
            reason: `Orta risk (${diff.risk_score}/10) — onay önerilir`,
            policy_id: "POL-DIFF-005",
            requires_human: false,
        };
    }
    // Risk 0–3: Sessiz geçiş
    return {
        verdict: "AUTO_APPROVED",
        reason: `Düşük risk (${diff.risk_score}/10) — otomatik onay`,
        policy_id: "POL-DIFF-006",
        requires_human: false,
    };
}
async function getRecentDiffCount(projectId, filePath, minutes) {
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const { count } = await supabase
        .from("semantic_diffs")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId)
        .eq("file_path", filePath)
        .gte("generated_at", since);
    return count || 0;
}
function describeRisk(diff) {
    const reasons = [];
    if (diff.risk_factors.touches_auth)
        reasons.push("auth dosyası");
    if (diff.risk_factors.touches_security)
        reasons.push("güvenlik dosyası");
    if (diff.risk_factors.deletes_symbols)
        reasons.push("sembol silme");
    if (diff.risk_factors.large_change)
        reasons.push("büyük değişiklik");
    return reasons.join(", ");
}
//# sourceMappingURL=policyWithDiff.js.map