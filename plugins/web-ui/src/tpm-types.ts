export const TPM_COLUMNS = ["backlog", "ready", "in_progress", "blocked", "in_review", "done"] as const;
export type TpmColumn = (typeof TPM_COLUMNS)[number];
export type TpmKind = "ticket" | "customer_issue" | "document" | "milestone";
export type TpmTab = "kanban" | "graph" | "insights";

export interface TpmJudgment {
  type: "noul" | "choice" | "score";
  value: number | string;
  confidence?: number;
}

export interface TpmItemView {
  id: string;
  scopeId: string;
  kind: TpmKind;
  title: string;
  body: string;
  column: TpmColumn;
  externalRef?: string;
  assignee?: string;
  sourceUpdatedAt?: number;
  signals: {
    mentionsBlocker?: number;
    customerImpact?: { score: number; confidence: number };
    lowConfidence?: string[];
    custom?: Record<string, TpmJudgment>;
    classifiedAt?: number;
    model?: string;
  };
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  columnChangedAt: number;
}

export interface TpmEdgeView {
  id: string;
  scopeId: string;
  kind: "blocks" | "addresses" | "documents";
  fromId: string;
  toId: string;
  state: "confirmed" | "proposed" | "rejected";
  origin: "classifier" | "agent" | "person";
  confidence?: number;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ItemRef = { id: string; title: string; column: TpmColumn };

export interface TpmInsightsView {
  generatedAt: number;
  counts: Record<TpmColumn, number>;
  blocked: Array<ItemRef & { blockedDays: number; blockers: ItemRef[]; rootBlockers: ItemRef[] }>;
  bottlenecks: Array<ItemRef & { downstreamOpen: number }>;
  customerCoverage: Array<
    ItemRef & { impact?: number; status: "unaddressed" | "in_flight" | "fix_shipped"; tickets: ItemRef[] }
  >;
  staleDocuments: Array<
    ItemRef & { lastUpdatedAt: number; ageDays: number; reasons: Array<"old" | "behind_work">; behind: ItemRef[] }
  >;
  staleWork: Array<ItemRef & { idleDays: number }>;
  unrecordedBlockers: Array<ItemRef & { probability: number }>;
  cycles: ItemRef[][];
  pendingReview: number;
}

export interface TpmBoardWire {
  scopeId: string;
  items: TpmItemView[];
  edges: TpmEdgeView[];
  insights: TpmInsightsView;
  metrics: TpmMetricsView;
  rubric: Array<{
    key: string;
    type: "noul" | "choice" | "score";
    instructions: string;
    criteria?: Record<string, string> | string[];
    appliesTo?: TpmKind[];
  }>;
  classifier: { available: boolean; model?: string };
}

export const COLUMN_LABEL: Record<TpmColumn, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  done: "Done",
};

export const KIND_LABEL: Record<TpmKind, string> = {
  ticket: "Ticket",
  customer_issue: "Customer issue",
  document: "Doc",
  milestone: "Milestone",
};

export function itemHandle(item: Pick<TpmItemView, "id" | "externalRef">): string {
  return item.externalRef ?? item.id.slice(0, 8);
}

export type CoverageStatus = "unaddressed" | "in_flight" | "fix_shipped" | "resolved";

export interface TpmMetricsView {
  windowDays: number;
  staleDocDays: number;
  generatedAt: number;
  kpis: {
    doneThisWeek: number;
    donePreviousWeek: number;
    medianCycleDays: number | null;
    wip: number;
    blockedNow: number;
    blockedDaysInWindow: number;
    openCustomerIssues: number;
    unaddressedCustomerIssues: number;
    staleDocuments: number;
  };
  flow: Array<{ at: number; counts: Record<TpmColumn, number> }>;
  throughput: Array<{ weekStart: number; done: number }>;
  cycleTimes: Array<{ id: string; title: string; kind: TpmKind; days: number; doneAt: number; blockedDays: number }>;
  aging: Array<{
    id: string;
    title: string;
    kind: TpmKind;
    column: TpmColumn;
    ageDays: number;
    inColumnDays: number;
    blockedDays: number;
  }>;
  customerIssues: Array<{ id: string; title: string; status: CoverageStatus; days: number; impact?: number }>;
  documents: Array<{ id: string; title: string; ageDays: number; stale: boolean }>;
}

export const METRIC_WINDOWS = [14, 42, 84] as const;
