import { TPM_COLUMNS, type TpmColumn, type TpmEdge, type TpmEvent, type TpmItem, type TpmKind } from "./tpm-store.ts";
import { documentLastUpdated } from "./tpm-insights.ts";

const DAY_MS = 86_400_000;
const STARTED = new Set<TpmColumn>(["in_progress", "blocked", "in_review"]);

export const METRIC_WINDOWS = [14, 42, 84] as const;
export const DEFAULT_METRIC_WINDOW = 42;

interface Segment {
  column: TpmColumn;
  from: number;
  to: number;
}

interface Timeline {
  item: TpmItem;
  segments: Segment[];
  startedAt?: number;
  doneAt?: number;
}

type CoverageStatus = "unaddressed" | "in_flight" | "fix_shipped" | "resolved";

export interface TpmMetrics {
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

const round1 = (value: number): number => Math.round(value * 10) / 10;

function timelines(items: readonly TpmItem[], events: readonly TpmEvent[], now: number): Map<string, Timeline> {
  const byItem = new Map<string, TpmEvent[]>();
  for (const event of events) {
    if (!event.itemId) continue;
    const list = byItem.get(event.itemId);
    if (list) list.push(event);
    else byItem.set(event.itemId, [event]);
  }
  const out = new Map<string, Timeline>();
  for (const item of items) {
    const history = (byItem.get(item.id) ?? []).sort(
      (a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id),
    );
    const created = history.find((event) => event.type === "item_created");
    const firstMove = history.find((event) => event.type === "column_changed" && event.fromValue);
    let column = (created?.toValue ?? firstMove?.fromValue ?? item.column) as TpmColumn;
    let since = item.createdAt;
    const segments: Segment[] = [];
    let startedAt = STARTED.has(column) ? item.createdAt : undefined;
    let doneAt: number | undefined;
    for (const event of history) {
      if (event.type === "placed" && event.toValue) {
        column = event.toValue as TpmColumn;
        startedAt = STARTED.has(column) ? item.createdAt : undefined;
        continue;
      }
      if (event.type !== "column_changed" || !event.toValue) continue;
      const next = event.toValue as TpmColumn;
      segments.push({ column, from: since, to: event.createdAt });
      if (column === "done" && next !== "done") {
        startedAt = undefined;
        doneAt = undefined;
      }
      if (STARTED.has(next)) startedAt ??= event.createdAt;
      if (next === "done" && column !== "done") doneAt = event.createdAt;
      column = next;
      since = event.createdAt;
    }
    segments.push({ column, from: since, to: now });
    out.set(item.id, {
      item,
      segments,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(doneAt !== undefined && item.column === "done" ? { doneAt } : {}),
    });
  }
  return out;
}

function columnAt(timeline: Timeline, at: number): TpmColumn | null {
  if (timeline.item.createdAt > at) return null;
  for (const segment of timeline.segments) if (segment.from <= at && at < segment.to) return segment.column;
  return timeline.segments.at(-1)!.column;
}

function blockedMs(timeline: Timeline, from: number, to: number): number {
  return timeline.segments
    .filter((segment) => segment.column === "blocked")
    .reduce((sum, segment) => sum + Math.max(0, Math.min(segment.to, to) - Math.max(segment.from, from)), 0);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function coverage(issue: TpmItem, byId: Map<string, TpmItem>, edges: readonly TpmEdge[]): CoverageStatus {
  if (issue.column === "done") return "resolved";
  const fixes = edges
    .filter((edge) => edge.kind === "addresses" && edge.state === "confirmed" && edge.toId === issue.id)
    .map((edge) => byId.get(edge.fromId))
    .filter((item): item is TpmItem => item !== undefined);
  if (!fixes.length) return "unaddressed";
  return fixes.every((fix) => fix.column === "done") ? "fix_shipped" : "in_flight";
}

export function computeMetrics(
  items: readonly TpmItem[],
  edges: readonly TpmEdge[],
  events: readonly TpmEvent[],
  now: number,
  windowDays: number,
  staleDocDays: number,
): TpmMetrics {
  const windowStart = now - windowDays * DAY_MS;
  const lines = timelines(items, events, now);
  const byId = new Map(items.map((item) => [item.id, item]));
  const all = [...lines.values()];

  const flow = Array.from({ length: windowDays + 1 }, (_, index) => {
    const at = windowStart + index * DAY_MS;
    const counts = Object.fromEntries(TPM_COLUMNS.map((column) => [column, 0])) as Record<TpmColumn, number>;
    for (const line of all) {
      const column = columnAt(line, at);
      if (column) counts[column] += 1;
    }
    return { at, counts };
  });

  const doneEvents = events.filter(
    (event) =>
      event.type === "column_changed" &&
      event.toValue === "done" &&
      event.fromValue !== "done" &&
      event.itemId &&
      byId.has(event.itemId),
  );
  const weeks = Math.ceil(windowDays / 7);
  const throughput = Array.from({ length: weeks }, (_, index) => {
    const weekStart = now - (weeks - index) * 7 * DAY_MS;
    return {
      weekStart,
      done: doneEvents.filter((event) => event.createdAt >= weekStart && event.createdAt < weekStart + 7 * DAY_MS)
        .length,
    };
  });

  const cycleTimes = all
    .filter((line) => line.startedAt !== undefined && line.doneAt !== undefined && line.doneAt >= windowStart)
    .map((line) => ({
      id: line.item.id,
      title: line.item.title,
      kind: line.item.kind,
      days: round1((line.doneAt! - line.startedAt!) / DAY_MS),
      doneAt: line.doneAt!,
      blockedDays: round1(blockedMs(line, line.startedAt!, line.doneAt!) / DAY_MS),
    }))
    .sort((a, b) => a.doneAt - b.doneAt || a.title.localeCompare(b.title));

  const aging = all
    .filter((line) => STARTED.has(line.item.column) && line.item.kind !== "document")
    .map((line) => ({
      id: line.item.id,
      title: line.item.title,
      kind: line.item.kind,
      column: line.item.column,
      ageDays: round1((now - (line.startedAt ?? line.item.createdAt)) / DAY_MS),
      inColumnDays: round1((now - line.segments.at(-1)!.from) / DAY_MS),
      blockedDays: round1(blockedMs(line, 0, now) / DAY_MS),
    }))
    .sort((a, b) => b.ageDays - a.ageDays || a.title.localeCompare(b.title));

  const customerIssues = items
    .filter((item) => item.kind === "customer_issue")
    .flatMap((issue) => {
      const status = coverage(issue, byId, edges);
      const resolvedAt = lines.get(issue.id)!.doneAt ?? issue.columnChangedAt;
      if (status === "resolved" && resolvedAt < windowStart) return [];
      const impact = issue.signals.customerImpact?.score;
      return [
        {
          id: issue.id,
          title: issue.title,
          status,
          days: round1(((status === "resolved" ? resolvedAt : now) - issue.createdAt) / DAY_MS),
          ...(impact !== undefined ? { impact } : {}),
        },
      ];
    })
    .sort((a, b) => b.days - a.days || a.title.localeCompare(b.title));

  const documents = items
    .filter((item) => item.kind === "document")
    .map((doc) => {
      const ageDays = round1((now - documentLastUpdated(doc)) / DAY_MS);
      return { id: doc.id, title: doc.title, ageDays, stale: ageDays >= staleDocDays };
    })
    .sort((a, b) => b.ageDays - a.ageDays || a.title.localeCompare(b.title));

  const openIssues = customerIssues.filter((entry) => entry.status !== "resolved");
  return {
    windowDays,
    staleDocDays,
    generatedAt: now,
    kpis: {
      doneThisWeek: throughput.at(-1)?.done ?? 0,
      donePreviousWeek: throughput.at(-2)?.done ?? 0,
      medianCycleDays: median(cycleTimes.map((entry) => entry.days)),
      wip: items.filter((item) => STARTED.has(item.column) && item.kind !== "document").length,
      blockedNow: items.filter((item) => item.column === "blocked" && item.kind !== "document").length,
      blockedDaysInWindow: round1(
        all
          .filter((line) => line.item.kind !== "document")
          .reduce((sum, line) => sum + blockedMs(line, windowStart, now), 0) / DAY_MS,
      ),
      openCustomerIssues: openIssues.length,
      unaddressedCustomerIssues: openIssues.filter((entry) => entry.status === "unaddressed").length,
      staleDocuments: documents.filter((doc) => doc.stale).length,
    },
    flow,
    throughput,
    cycleTimes,
    aging,
    customerIssues,
    documents,
  };
}
