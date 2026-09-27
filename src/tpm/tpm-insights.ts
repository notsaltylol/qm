import { TPM_COLUMNS, type TpmColumn, type TpmEdge, type TpmItem } from "./tpm-store.ts";

export const STALE_DOC_DAYS = 30;
export const STALE_WORK_DAYS = 14;
export const BLOCKER_SIGNAL_AT = 0.8;
const DAY_MS = 86_400_000;

type ItemRef = { id: string; title: string; column: TpmColumn };

export interface TpmInsights {
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

const ref = (item: TpmItem): ItemRef => ({ id: item.id, title: item.title, column: item.column });
const isOpen = (item: TpmItem): boolean => item.column !== "done";
const days = (ms: number): number => Math.max(0, Math.floor(ms / DAY_MS));

export function documentLastUpdated(item: TpmItem): number {
  return item.sourceUpdatedAt ?? item.updatedAt;
}

function blockCycles(items: readonly TpmItem[], upstream: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string): void => {
    indices.set(id, index);
    low.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const next of upstream.get(id) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id)!, indices.get(next)!));
      }
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      if (component.length > 1) cycles.push(component.reverse());
    }
  };
  for (const item of items) if (!indices.has(item.id)) visit(item.id);
  return cycles;
}

export function computeInsights(items: readonly TpmItem[], edges: readonly TpmEdge[], now: number): TpmInsights {
  const byId = new Map(items.map((item) => [item.id, item]));
  const confirmed = edges.filter((edge) => edge.state === "confirmed" && byId.has(edge.fromId) && byId.has(edge.toId));
  const blocks = confirmed.filter((edge) => edge.kind === "blocks");
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const edge of blocks) {
    upstream.set(edge.toId, [...(upstream.get(edge.toId) ?? []), edge.fromId]);
    downstream.set(edge.fromId, [...(downstream.get(edge.fromId) ?? []), edge.toId]);
  }
  const openBlockers = (id: string): TpmItem[] =>
    (upstream.get(id) ?? []).map((from) => byId.get(from)!).filter(isOpen);

  const rootBlockers = (id: string): TpmItem[] => {
    const seen = new Set<string>([id]);
    const roots = new Map<string, TpmItem>();
    const pending = openBlockers(id);
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      const further = openBlockers(next.id).filter((item) => !seen.has(item.id));
      if (openBlockers(next.id).length === 0) roots.set(next.id, next);
      pending.push(...further);
    }
    return [...roots.values()];
  };

  const downstreamOpen = (id: string): number => {
    const seen = new Set<string>([id]);
    const pending = [...(downstream.get(id) ?? [])];
    let count = 0;
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const item = byId.get(next);
      if (!item || !isOpen(item)) continue;
      count += 1;
      pending.push(...(downstream.get(next) ?? []));
    }
    return count;
  };

  const counts = Object.fromEntries(TPM_COLUMNS.map((column) => [column, 0])) as Record<TpmColumn, number>;
  for (const item of items) counts[item.column] += 1;

  const blocked: TpmInsights["blocked"] = [];
  const unrecordedBlockers: TpmInsights["unrecordedBlockers"] = [];
  const staleWork: TpmInsights["staleWork"] = [];
  for (const item of items) {
    if (!isOpen(item) || item.kind === "document") continue;
    const blockers = openBlockers(item.id);
    if (item.column === "blocked" || blockers.length > 0) {
      const edgeStarts = blocks
        .filter((edge) => edge.toId === item.id && blockers.some((blocker) => blocker.id === edge.fromId))
        .map((edge) => edge.createdAt);
      const since = item.column === "blocked" ? item.columnChangedAt : Math.min(...edgeStarts);
      blocked.push({
        ...ref(item),
        blockedDays: days(now - since),
        blockers: blockers.map(ref),
        rootBlockers: rootBlockers(item.id).map(ref),
      });
    }
    const signal = item.signals.mentionsBlocker ?? 0;
    if (signal >= BLOCKER_SIGNAL_AT && item.column !== "blocked" && blockers.length === 0) {
      unrecordedBlockers.push({ ...ref(item), probability: signal });
    }
    if (
      (item.column === "in_progress" || item.column === "in_review") &&
      now - item.columnChangedAt >= STALE_WORK_DAYS * DAY_MS
    ) {
      staleWork.push({ ...ref(item), idleDays: days(now - item.columnChangedAt) });
    }
  }
  blocked.sort((a, b) => b.blockedDays - a.blockedDays);
  staleWork.sort((a, b) => b.idleDays - a.idleDays);
  unrecordedBlockers.sort((a, b) => b.probability - a.probability);

  const bottlenecks = items
    .filter(isOpen)
    .map((item) => ({ ...ref(item), downstreamOpen: downstreamOpen(item.id) }))
    .filter((entry) => entry.downstreamOpen >= 2)
    .sort((a, b) => b.downstreamOpen - a.downstreamOpen);

  const customerCoverage: TpmInsights["customerCoverage"] = items
    .filter((item) => item.kind === "customer_issue" && isOpen(item))
    .map((issue) => {
      const tickets = confirmed
        .filter((edge) => edge.kind === "addresses" && edge.toId === issue.id)
        .map((edge) => byId.get(edge.fromId)!);
      let status: "unaddressed" | "in_flight" | "fix_shipped" = "in_flight";
      if (tickets.length === 0) status = "unaddressed";
      else if (tickets.every((ticket) => !isOpen(ticket))) status = "fix_shipped";
      const impact = issue.signals.customerImpact?.score;
      return { ...ref(issue), ...(impact !== undefined ? { impact } : {}), status, tickets: tickets.map(ref) };
    })
    .sort((a, b) => {
      const rank = { unaddressed: 0, fix_shipped: 1, in_flight: 2 } as const;
      return rank[a.status] - rank[b.status] || (b.impact ?? 0) - (a.impact ?? 0);
    });

  const staleDocuments: TpmInsights["staleDocuments"] = [];
  for (const doc of items) {
    if (doc.kind !== "document") continue;
    const lastUpdatedAt = documentLastUpdated(doc);
    const behind = confirmed
      .filter((edge) => edge.kind === "documents" && edge.fromId === doc.id)
      .map((edge) => byId.get(edge.toId)!)
      .filter((item) => item.columnChangedAt > item.createdAt && item.columnChangedAt > lastUpdatedAt);
    const reasons: Array<"old" | "behind_work"> = [];
    if (now - lastUpdatedAt >= STALE_DOC_DAYS * DAY_MS) reasons.push("old");
    if (behind.length > 0) reasons.push("behind_work");
    if (reasons.length) {
      staleDocuments.push({
        ...ref(doc),
        lastUpdatedAt,
        ageDays: days(now - lastUpdatedAt),
        reasons,
        behind: behind.map(ref),
      });
    }
  }
  staleDocuments.sort((a, b) => b.ageDays - a.ageDays);

  return {
    generatedAt: now,
    counts,
    blocked,
    bottlenecks,
    customerCoverage,
    staleDocuments,
    staleWork,
    unrecordedBlockers,
    cycles: blockCycles(items, upstream).map((cycle) => cycle.map((id) => ref(byId.get(id)!))),
    pendingReview: edges.filter((edge) => edge.state === "proposed" && byId.has(edge.fromId) && byId.has(edge.toId))
      .length,
  };
}
