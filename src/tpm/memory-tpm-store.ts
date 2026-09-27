import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import {
  canClassifierOverwrite,
  type CreateTpmItemInput,
  type TpmEdge,
  type TpmEdgeState,
  type TpmEvent,
  type TpmItem,
  type TpmItemPatch,
  type TpmRubric,
  type TpmStore,
  type UpsertTpmEdgeInput,
} from "./tpm-store.ts";
import { applyItemPatch, itemChangeEvents } from "./tpm-item-patch.ts";

export function createMemoryTpmStore(opts: { now?: () => number } = {}): TpmStore {
  const now = opts.now ?? (() => Date.now());
  const items = new Map<string, TpmItem>();
  const edges = new Map<string, TpmEdge>();
  const rubrics = new Map<ScopeId, TpmRubric>();
  const events: TpmEvent[] = [];
  let nextEventId = 1;

  const clone = <T>(value: T): T => structuredClone(value);

  function record(event: Omit<TpmEvent, "id" | "createdAt">, at: number): void {
    events.push({ ...event, id: String(nextEventId++), createdAt: at });
  }

  function edgeKey(input: Pick<TpmEdge, "scopeId" | "kind" | "fromId" | "toId">): string {
    return `${input.scopeId}\u0000${input.kind}\u0000${input.fromId}\u0000${input.toId}`;
  }

  function findEdge(input: Pick<TpmEdge, "scopeId" | "kind" | "fromId" | "toId">): TpmEdge | undefined {
    const key = edgeKey(input);
    for (const edge of edges.values()) if (edgeKey(edge) === key) return edge;
    return undefined;
  }

  return {
    async createItem(input: CreateTpmItemInput): Promise<TpmItem> {
      if (input.externalRef !== undefined) {
        for (const item of items.values()) {
          if (item.scopeId === input.scopeId && item.externalRef === input.externalRef) {
            throw new Error(`tpm item with ref ${input.externalRef} already exists`);
          }
        }
      }
      const at = now();
      const item: TpmItem = {
        id: randomUUID(),
        scopeId: input.scopeId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? "",
        column: input.column,
        ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
        ...(input.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: input.sourceUpdatedAt } : {}),
        signals: input.signals ?? {},
        createdBy: input.actorId,
        createdAt: at,
        updatedAt: at,
        columnChangedAt: at,
      };
      items.set(item.id, item);
      record(
        { scopeId: item.scopeId, itemId: item.id, type: "item_created", toValue: item.column, actorId: input.actorId },
        at,
      );
      return clone(item);
    },

    async getItem(id) {
      const item = items.get(id);
      return item ? clone(item) : null;
    },

    async listItems(scopeId) {
      return [...items.values()]
        .filter((item) => item.scopeId === scopeId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map(clone);
    },

    async updateItem(id: string, patch: TpmItemPatch, actorId: string) {
      const current = items.get(id);
      if (!current) return null;
      if (patch.externalRef) {
        for (const item of items.values()) {
          if (item.id !== id && item.scopeId === current.scopeId && item.externalRef === patch.externalRef) {
            throw new Error(`tpm item with ref ${patch.externalRef} already exists`);
          }
        }
      }
      const at = now();
      const next = applyItemPatch(current, patch, at);
      items.set(id, next);
      for (const event of itemChangeEvents(current, next, actorId, patch.placement === true)) record(event, at);
      return clone(next);
    },

    async deleteItem(id, actorId) {
      const item = items.get(id);
      if (!item) return false;
      items.delete(id);
      for (const [edgeId, edge] of edges) if (edge.fromId === id || edge.toId === id) edges.delete(edgeId);
      record({ scopeId: item.scopeId, itemId: id, type: "item_deleted", fromValue: item.column, actorId }, now());
      return true;
    },

    async upsertEdge(input: UpsertTpmEdgeInput): Promise<TpmEdge> {
      const at = now();
      const existing = findEdge(input);
      const decided = input.origin !== "classifier";
      if (!existing) {
        const edge: TpmEdge = {
          id: randomUUID(),
          scopeId: input.scopeId,
          kind: input.kind,
          fromId: input.fromId,
          toId: input.toId,
          state: input.state,
          origin: input.origin,
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(decided ? { decidedBy: input.actorId, decidedAt: at } : {}),
          createdAt: at,
          updatedAt: at,
        };
        edges.set(edge.id, edge);
        record(
          { scopeId: edge.scopeId, edgeId: edge.id, type: "edge_added", toValue: edge.state, actorId: input.actorId },
          at,
        );
        return clone(edge);
      }
      if (!decided && !canClassifierOverwrite(existing)) return clone(existing);
      const next: TpmEdge = {
        ...existing,
        state: input.state,
        origin: input.origin,
        updatedAt: at,
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(decided ? { decidedBy: input.actorId, decidedAt: at } : {}),
      };
      edges.set(existing.id, next);
      if (next.state !== existing.state) {
        record(
          {
            scopeId: next.scopeId,
            edgeId: next.id,
            type: "edge_decided",
            fromValue: existing.state,
            toValue: next.state,
            actorId: input.actorId,
          },
          at,
        );
      }
      return clone(next);
    },

    async decideEdge(id: string, state: TpmEdgeState, actorId: string) {
      const existing = edges.get(id);
      if (!existing) return null;
      const at = now();
      const next: TpmEdge = { ...existing, state, decidedBy: actorId, decidedAt: at, updatedAt: at };
      edges.set(id, next);
      record(
        { scopeId: next.scopeId, edgeId: id, type: "edge_decided", fromValue: existing.state, toValue: state, actorId },
        at,
      );
      return clone(next);
    },

    async listEdges(scopeId) {
      return [...edges.values()]
        .filter((edge) => edge.scopeId === scopeId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map(clone);
    },

    async listEvents(scopeId, filter = {}) {
      const matching = events.filter(
        (event) => event.scopeId === scopeId && (filter.itemId === undefined || event.itemId === filter.itemId),
      );
      const limited = filter.limit !== undefined ? matching.slice(-filter.limit) : matching;
      return limited.map(clone);
    },

    async listScopes() {
      const counts = new Map<ScopeId, number>();
      for (const item of items.values()) counts.set(item.scopeId, (counts.get(item.scopeId) ?? 0) + 1);
      return [...counts]
        .map(([scopeId, itemCount]) => ({ scopeId, itemCount }))
        .sort((a, b) => a.scopeId.localeCompare(b.scopeId));
    },

    async getRubric(scopeId) {
      const rubric = rubrics.get(scopeId);
      return rubric ? clone(rubric) : null;
    },

    async setRubric(scopeId, questions, actorId) {
      const at = now();
      const rubric: TpmRubric = { scopeId, questions: clone(questions), updatedBy: actorId, updatedAt: at };
      rubrics.set(scopeId, rubric);
      record({ scopeId, type: "rubric_changed", toValue: String(questions.length), actorId }, at);
      return clone(rubric);
    },
  };
}
