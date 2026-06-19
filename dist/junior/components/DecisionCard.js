import { useState } from "react";
import { useJuniorStore } from "../../stores/juniorStore";
import { sendDecisionResponse } from "../api/decisionApi";
import { timeAgo } from "../utils/timeAgo";
import RiskDetail from "./RiskDetail";
export default function DecisionCard({ decision }) {
    const [showDetail, setShowDetail] = useState(false);
    const approve = useJuniorStore((s) => s.approveDecision);
    const reject = useJuniorStore((s) => s.rejectDecision);
    const isPending = decision.status === "PENDING_HUMAN";
    const cardClass = isPending ? "card-yellow" : "card-red";
    const handleApprove = async () => {
        approve(decision.id);
        await sendDecisionResponse(decision.id, "approve");
    };
    const handleReject = async () => {
        reject(decision.id);
        await sendDecisionResponse(decision.id, "reject");
    };
    return (<div className={`decision-card ${cardClass}`}>
      <div className="card-header">
        <span className="card-status">
          {isPending ? "🟡 Onayın lazım" : "🔴 Durduruldu"}
        </span>
        <span className="card-score">Risk: {decision.riskScore}/10</span>
      </div>

      <div className="card-body">
        <p className="card-area">{decision.affectedArea}</p>
        <p className="card-label">{decision.humanLabel}</p>
      </div>

      <div className="card-actions">
        {isPending && (<>
            <button className="btn-approve" onClick={handleApprove}>✅ Onayla</button>
            <button className="btn-reject" onClick={handleReject}>❌ Reddet</button>
          </>)}
        <button className="btn-why" onClick={() => setShowDetail(!showDetail)}>
          {showDetail ? "▲ Kapat" : "? Neden bu skor"}
        </button>
      </div>

      {showDetail && (<div className="card-detail">
          <RiskDetail decision={decision}/>
        </div>)}

      <div className="card-time">{timeAgo(decision.timestamp)}</div>
    </div>);
}
//# sourceMappingURL=DecisionCard.js.map