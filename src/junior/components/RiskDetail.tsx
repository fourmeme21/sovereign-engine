import { DecisionCard } from "../../stores/juniorStore";

interface Props {
  decision: DecisionCard;
}

const FACTORS = [
  { key: "security_issues",    label: "Güvenlik sorunları",    weight: 35 },
  { key: "hallucination_risk", label: "Var olmayan paket/API", weight: 25 },
  { key: "dependency_risk",    label: "Bağımlılık riski",      weight: 15 },
  { key: "diff_impact",        label: "Etkilenen alan",        weight: 10 },
  { key: "mcp_permission",     label: "MCP izin riski",        weight: 10 },
  { key: "git_impact",         label: "Git etkisi",            weight: 5  },
];

export default function RiskDetail({ decision }: Props) {
  const scores = decision.originalDecision?.risk_breakdown || {};

  return (
    <div className="risk-detail">
      <p className="detail-title">Risk faktörleri:</p>
      {FACTORS.map((f) => {
        const score      = scores[f.key] ?? 0;
        const normalized = Math.round(score * 10);
        return (
          <div key={f.key} className="factor-row">
            <span className="factor-label">{f.label}</span>
            <div className="factor-bar-wrap">
              <div
                className="factor-bar"
                style={{
                  width: `${normalized * 10}%`,
                  background: normalized > 6 ? "var(--danger)" : "var(--warning)",
                }}
              />
            </div>
            <span className="factor-score">{normalized}/10</span>
          </div>
        );
      })}
    </div>
  );
}
