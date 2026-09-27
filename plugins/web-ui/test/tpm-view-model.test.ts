import { test } from "node:test";
import assert from "node:assert/strict";
import { agingRows, cycleRows, flowRows, formatDays, throughputRows } from "../src/tpm-chart-data.ts";
import { buildFlow, connectedIds } from "../src/tpm-graph-model.ts";
import type { TpmBoardWire, TpmEdgeView, TpmItemView, TpmMetricsView } from "../src/tpm-types.ts";

const DAY = 86_400_000;

function metrics(overrides: Partial<TpmMetricsView> = {}): TpmMetricsView {
  return {
    windowDays: 14,
    staleDocDays: 30,
    generatedAt: 0,
    kpis: {
      doneThisWeek: 0,
      donePreviousWeek: 0,
      medianCycleDays: null,
      wip: 0,
      blockedNow: 0,
      blockedDaysInWindow: 0,
      openCustomerIssues: 0,
      unaddressedCustomerIssues: 0,
      staleDocuments: 0,
    },
    flow: [],
    throughput: [],
    cycleTimes: [],
    aging: [],
    customerIssues: [],
    documents: [],
    ...overrides,
  };
}

function item(id: string, column: TpmItemView["column"] = "in_progress"): TpmItemView {
  return {
    id,
    scopeId: "s",
    kind: "ticket",
    title: `Item ${id}`,
    body: "",
    column,
    signals: {},
    createdBy: "u",
    createdAt: 0,
    updatedAt: 0,
    columnChangedAt: 0,
  };
}

function edge(id: string, fromId: string, toId: string, state: TpmEdgeView["state"] = "confirmed"): TpmEdgeView {
  return { id, scopeId: "s", kind: "blocks", fromId, toId, state, origin: "classifier", createdAt: 0, updatedAt: 0 };
}

function board(items: TpmItemView[], edges: TpmEdgeView[]): TpmBoardWire {
  return {
    scopeId: "s",
    items,
    edges,
    insights: {
      generatedAt: 0,
      counts: { backlog: 0, ready: 0, in_progress: 0, blocked: 0, in_review: 0, done: 0 },
      blocked: [{ id: "b", title: "Item b", column: "blocked", blockedDays: 2, blockers: [], rootBlockers: [] }],
      bottlenecks: [],
      customerCoverage: [],
      staleDocuments: [],
      staleWork: [],
      unrecordedBlockers: [],
      cycles: [],
      pendingReview: 0,
    },
    metrics: metrics(),
    rubric: [],
    classifier: { available: false },
  };
}

test("cycle times fall into exclusive day buckets", () => {
  const cycleTimes = [0.5, 1, 2.9, 3, 13.9, 14, 40].map((days, index) => ({
    id: String(index),
    title: `T${index}`,
    kind: "ticket" as const,
    days,
    doneAt: 0,
    blockedDays: 0,
  }));
  const rows = cycleRows(metrics({ cycleTimes }));
  assert.deepEqual(
    rows.map((row) => row.count),
    [1, 2, 1, 1, 2],
  );
  assert.deepEqual(rows[4]!.titles, ["T5", "T6"]);
});

test("aging splits moving and blocked time and rounds whichever segment ends the bar", () => {
  const rows = agingRows(
    metrics({
      aging: [
        {
          id: "a",
          title: "Moving only",
          kind: "ticket",
          column: "in_progress",
          ageDays: 5,
          inColumnDays: 2,
          blockedDays: 0,
        },
        {
          id: "b",
          title: "Was blocked",
          kind: "ticket",
          column: "blocked",
          ageDays: 10,
          inColumnDays: 4,
          blockedDays: 12,
        },
      ],
    }),
  );
  assert.equal(rows[0]!.workingToEnd, 5);
  assert.equal(rows[0]!.workingBeforeBlock, 0);
  assert.equal(rows[0]!.blocked, 0);
  assert.ok(rows[0]!.blockedBar > 0 && rows[0]!.blockedBar < 0.01);
  assert.equal(rows[1]!.blocked, 10);
  assert.equal(rows[1]!.working, 0);
  assert.equal(rows[1]!.workingToEnd, 0);
  assert.equal(rows[1]!.total, 10);
  assert.equal(rows[1]!.column, "Blocked");
});

test("flow and throughput rows carry every column and a readable label", () => {
  const at = Date.UTC(2026, 8, 1, 12);
  const counts = { backlog: 1, ready: 2, in_progress: 3, blocked: 0, in_review: 1, done: 4 };
  const flow = flowRows(metrics({ flow: [{ at, counts }] }));
  assert.equal(flow[0]!.done, 4);
  assert.equal(typeof flow[0]!.label, "string");
  const weeks = throughputRows(metrics({ throughput: [{ weekStart: at, done: 3 }] }));
  assert.match(weeks[0]!.label, /^Week of /);
  assert.equal(weeks[0]!.done, 3);
});

test("durations read as hours under a day and tenths of days above", () => {
  assert.equal(formatDays(null), "–");
  assert.equal(formatDays(0.25), "6h");
  assert.equal(formatDays(3.14159), "3.1d");
  assert.equal(formatDays((DAY * 2) / DAY), "2d");
});

test("connected ids follow links both upstream and downstream", () => {
  const edges = [edge("1", "a", "b"), edge("2", "b", "c"), edge("3", "x", "y")];
  assert.deepEqual([...connectedIds(edges, "b")].sort(), ["a", "b", "c"]);
});

test("graph omits unlinked items, rejected links, and done work when hidden", () => {
  const items = [item("a"), item("b", "blocked"), item("c", "done"), item("lonely"), item("r")];
  const edges = [edge("1", "a", "b"), edge("2", "c", "b"), edge("3", "a", "r", "rejected")];
  const all = buildFlow(board(items, edges), { hideDone: false, focusId: null });
  assert.deepEqual(all.nodes.map((node) => node.id).sort(), ["a", "b", "c"]);
  assert.deepEqual(all.edges.map((entry) => entry.id).sort(), ["1", "2"]);
  assert.equal(all.hiddenCount, 2);
  assert.equal(all.nodes.find((node) => node.id === "b")!.data.blocked, true);

  const open = buildFlow(board(items, edges), { hideDone: true, focusId: null });
  assert.deepEqual(open.nodes.map((node) => node.id).sort(), ["a", "b"]);
  const [a, b] = ["a", "b"].map((id) => open.nodes.find((node) => node.id === id)!);
  assert.ok(a!.position.x < b!.position.x);
});

test("focusing an item dims everything outside its dependency chain", () => {
  const items = [item("a"), item("b"), item("c"), item("d")];
  const edges = [edge("1", "a", "b"), edge("2", "c", "d")];
  const flow = buildFlow(board(items, edges), { hideDone: false, focusId: "a" });
  const dimmed = Object.fromEntries(flow.nodes.map((node) => [node.id, node.data.dimmed]));
  assert.deepEqual(dimmed, { a: false, b: false, c: true, d: true });
  assert.equal(flow.nodes.find((node) => node.id === "a")!.data.focused, true);
  assert.equal(flow.edges.find((entry) => entry.id === "2")!.data.dimmed, true);
});
