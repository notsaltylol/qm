import type { TpmEvent, TpmItem, TpmItemPatch } from "./tpm-store.ts";

export function applyItemPatch(current: TpmItem, patch: TpmItemPatch, at: number): TpmItem {
  const next: TpmItem = { ...current, updatedAt: at };
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.body !== undefined) next.body = patch.body;
  if (patch.signals !== undefined) next.signals = patch.signals;
  if (patch.column !== undefined && patch.column !== current.column) {
    next.column = patch.column;
    next.columnChangedAt = patch.placement ? current.createdAt : at;
  }
  if (patch.externalRef === null) delete next.externalRef;
  else if (patch.externalRef !== undefined) next.externalRef = patch.externalRef;
  if (patch.assignee === null) delete next.assignee;
  else if (patch.assignee !== undefined) next.assignee = patch.assignee;
  if (patch.sourceUpdatedAt === null) delete next.sourceUpdatedAt;
  else if (patch.sourceUpdatedAt !== undefined) next.sourceUpdatedAt = patch.sourceUpdatedAt;
  return next;
}

export function itemChangeEvents(
  before: TpmItem,
  after: TpmItem,
  actorId: string,
  placement = false,
): Array<Omit<TpmEvent, "id" | "createdAt">> {
  const base = { scopeId: after.scopeId, itemId: after.id, actorId };
  const events: Array<Omit<TpmEvent, "id" | "createdAt">> = [];
  if (before.column !== after.column) {
    events.push({
      ...base,
      type: placement ? "placed" : "column_changed",
      fromValue: before.column,
      toValue: after.column,
    });
  }
  const contentChanged =
    before.kind !== after.kind ||
    before.title !== after.title ||
    before.body !== after.body ||
    before.externalRef !== after.externalRef ||
    before.assignee !== after.assignee ||
    before.sourceUpdatedAt !== after.sourceUpdatedAt;
  if (contentChanged) events.push({ ...base, type: "item_updated" });
  if (JSON.stringify(before.signals) !== JSON.stringify(after.signals)) {
    events.push({ ...base, type: "classified", ...(after.signals.model ? { toValue: after.signals.model } : {}) });
  }
  return events;
}
