import { create } from "zustand";

export type DecisionStatus =
  | "AUTO_APPROVED"
  | "PENDING_HUMAN"
  | "BLOCKED"
  | "APPROVED"
  | "REJECTED";

export interface DecisionCard {
  id: string;
  status: DecisionStatus;
  riskScore: number;
  affectedArea: string;
  humanLabel: string;
  confidence?: number;
  timestamp: number;
  originalDecision: Record<string, any>;
}

interface JuniorStore {
  decisions: DecisionCard[];
  autoApprovedCount: number;
  approveDecision: (id: string) => void;
  rejectDecision: (id: string) => void;
  addDecision: (d: DecisionCard) => void;
  analyzePrompt: (input: string) => Promise<void>;
}

const ENGINE_URL = import.meta.env.VITE_ENGINE_URL ?? "";

export const useJuniorStore = create<JuniorStore>((set, get) => ({
  decisions: [],
  autoApprovedCount: 0,

  addDecision: (d) => {
    set((s) => {
      if (d.status === "AUTO_APPROVED" && d.riskScore <= 3) {
        return {
          autoApprovedCount: s.autoApprovedCount + 1,
          decisions: [d, ...s.decisions],
        };
      }
      return { decisions: [d, ...s.decisions] };
    });
  },

  approveDecision: (id) => {
    set((s) => ({
      decisions: s.decisions.map((d) =>
        d.id === id ? { ...d, status: "APPROVED" } : d
      ),
    }));
  },

  rejectDecision: (id) => {
    set((s) => ({
      decisions: s.decisions.map((d) =>
        d.id === id ? { ...d, status: "REJECTED" } : d
      ),
    }));
  },

  analyzePrompt: async (input) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ANALYZE_PROMPT", payload: { prompt: input } }),
      });
      const raw = await res.json();

      const riskScore = raw.risk_score ?? 0;
      const status: DecisionStatus =
        raw.verdict === "ASK_HUMAN"    ? "PENDING_HUMAN"  :
        raw.verdict === "DENY"         ? "BLOCKED"        :
        riskScore <= 3                 ? "AUTO_APPROVED"  : "PENDING_HUMAN";

      const card: DecisionCard = {
        id: raw.id ?? crypto.randomUUID(),
        status,
        riskScore,
        affectedArea: raw.target ?? input.slice(0, 60),
        humanLabel: raw.reason ?? "Analiz tamamlandı.",
        confidence: raw.confidence,
        timestamp: Date.now(),
        originalDecision: raw,
      };

      get().addDecision(card);
    } catch (err) {
      console.error("[analyzePrompt]", err);
    }
  },
}));
