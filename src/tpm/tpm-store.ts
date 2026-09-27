import type { ScopeId } from "../types.ts";

export const TPM_KINDS = ["ticket", "customer_issue", "document", "milestone"] as const;
export const TPM_COLUMNS = ["backlog", "ready", "in_progress", "blocked", "in_review", "done"] as const;
export const TPM_EDGE_KINDS = ["blocks", "addresses", "documents"] as const;
export const TPM_EDGE_STATES = ["confirmed", "proposed", "rejected"] as const;
export const TPM_EDGE_ORIGINS = ["classifier", "agent", "person"] as const;
export const TPM_EVENT_TYPES = [
  "item_created",
  "item_updated",
  "column_changed",
  "placed",
  "item_deleted",
  "edge_added",
  "edge_decided",
  "classified",
  "rubric_changed",
] as const;

export type TpmKind = (typeof TPM_KINDS)[number];
export type TpmColumn = (typeof TPM_COLUMNS)[number];
export type TpmEdgeKind = (typeof TPM_EDGE_KINDS)[number];
export type TpmEdgeState = (typeof TPM_EDGE_STATES)[number];
export type TpmEdgeOrigin = (typeof TPM_EDGE_ORIGINS)[number];
export type TpmEventType = (typeof TPM_EVENT_TYPES)[number];

export interface TpmJudgment {
  type: "noul" | "choice" | "score";
  value: number | string;
  confidence?: number;
}

export interface TpmSignals {
  mentionsBlocker?: number;
  customerImpact?: { score: number; confidence: number };
  lowConfidence?: string[];
  custom?: Record<string, TpmJudgment>;
  classifiedAt?: number;
  model?: string;
}

export interface TpmItem {
  id: string;
  scopeId: ScopeId;
  kind: TpmKind;
  title: string;
  body: string;
  column: TpmColumn;
  externalRef?: string;
  assignee?: string;
  sourceUpdatedAt?: number;
  signals: TpmSignals;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  columnChangedAt: number;
}

export interface TpmEdge {
  id: string;
  scopeId: ScopeId;
  kind: TpmEdgeKind;
  fromId: string;
  toId: string;
  state: TpmEdgeState;
  origin: TpmEdgeOrigin;
  confidence?: number;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TpmEvent {
  id: string;
  scopeId: ScopeId;
  itemId?: string;
  edgeId?: string;
  type: TpmEventType;
  fromValue?: string;
  toValue?: string;
  actorId: string;
  createdAt: number;
}

export interface TpmRubricQuestion {
  key: string;
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
  appliesTo?: TpmKind[];
}

export interface TpmRubric {
  scopeId: ScopeId;
  questions: TpmRubricQuestion[];
  updatedBy: string;
  updatedAt: number;
}

export interface CreateTpmItemInput {
  scopeId: ScopeId;
  kind: TpmKind;
  title: string;
  body?: string;
  column: TpmColumn;
  externalRef?: string;
  assignee?: string;
  sourceUpdatedAt?: number;
  signals?: TpmSignals;
  actorId: string;
}

export interface TpmItemPatch {
  kind?: TpmKind;
  title?: string;
  body?: string;
  column?: TpmColumn;
  externalRef?: string | null;
  assignee?: string | null;
  sourceUpdatedAt?: number | null;
  signals?: TpmSignals;
  placement?: boolean;
}

export interface UpsertTpmEdgeInput {
  scopeId: ScopeId;
  kind: TpmEdgeKind;
  fromId: string;
  toId: string;
  state: TpmEdgeState;
  origin: TpmEdgeOrigin;
  confidence?: number;
  actorId: string;
}

export interface TpmStore {
  createItem(input: CreateTpmItemInput): Promise<TpmItem>;
  getItem(id: string): Promise<TpmItem | null>;
  listItems(scopeId: ScopeId): Promise<TpmItem[]>;
  updateItem(id: string, patch: TpmItemPatch, actorId: string): Promise<TpmItem | null>;
  deleteItem(id: string, actorId: string): Promise<boolean>;
  upsertEdge(input: UpsertTpmEdgeInput): Promise<TpmEdge>;
  decideEdge(id: string, state: TpmEdgeState, actorId: string): Promise<TpmEdge | null>;
  listEdges(scopeId: ScopeId): Promise<TpmEdge[]>;
  listEvents(scopeId: ScopeId, opts?: { itemId?: string; limit?: number }): Promise<TpmEvent[]>;
  listScopes(): Promise<Array<{ scopeId: ScopeId; itemCount: number }>>;
  getRubric(scopeId: ScopeId): Promise<TpmRubric | null>;
  setRubric(scopeId: ScopeId, questions: TpmRubricQuestion[], actorId: string): Promise<TpmRubric>;
  close?(): Promise<void>;
}

export function isTpmKind(value: unknown): value is TpmKind {
  return typeof value === "string" && (TPM_KINDS as readonly string[]).includes(value);
}

export function isTpmColumn(value: unknown): value is TpmColumn {
  return typeof value === "string" && (TPM_COLUMNS as readonly string[]).includes(value);
}

export function isTpmEdgeKind(value: unknown): value is TpmEdgeKind {
  return typeof value === "string" && (TPM_EDGE_KINDS as readonly string[]).includes(value);
}

export function canClassifierOverwrite(edge: Pick<TpmEdge, "decidedBy">): boolean {
  return edge.decidedBy === undefined;
}
