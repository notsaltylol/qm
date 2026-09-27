import { test } from "node:test";
import assert from "node:assert/strict";
import type { JevClient } from "../src/classify/jev-client.ts";
import { createMemoryTpmStore } from "../src/tpm/memory-tpm-store.ts";
import { computeMetrics } from "../src/tpm/tpm-metrics.ts";
import { createTpmService } from "../src/tpm/tpm-service.ts";

const DAY = 86_400_000;
const scope = "channel:C1" as const;

function setup() {
  const clock = { now: 100 * DAY };
  const store = createMemoryTpmStore({ now: () => clock.now });
  const service = createTpmService({ store, now: () => clock.now });
  return { clock, store, service };
}

test("cycle time, blocked time, and throughput come from column moves", async () => {
  const { clock, service } = setup();
  assert.ok((await service.ingest(scope, "a", [{ title: "Build importer", ref: "T1", kind: "ticket" }])).ok);
  clock.now += 2 * DAY;
  await service.update(scope, "a", "T1", { column: "in_progress" });
  clock.now += 3 * DAY;
  await service.update(scope, "a", "T1", { column: "blocked" });
  clock.now += 4 * DAY;
  await service.update(scope, "a", "T1", { column: "in_review" });
  clock.now += 1 * DAY;
  await service.update(scope, "a", "T1", { column: "done" });
  clock.now += 1 * DAY;
  const { metrics } = await service.board(scope, { windowDays: 14 });
  assert.deepEqual(
    metrics.cycleTimes.map((entry) => [entry.days, entry.blockedDays]),
    [[8, 4]],
  );
  assert.equal(metrics.kpis.medianCycleDays, 8);
  assert.equal(metrics.kpis.blockedDaysInWindow, 4);
  assert.deepEqual(
    metrics.throughput.map((week) => week.done),
    [0, 1],
  );
  assert.equal(metrics.kpis.doneThisWeek, 1);
  assert.equal(metrics.flow.length, 15);
  assert.equal(metrics.flow.at(-1)!.counts.done, 1);
  assert.equal(metrics.flow[0]!.counts.backlog, 0);
});

test("items imported already started or done do not count as completed work", async () => {
  const { clock, service } = setup();
  await service.ingest(scope, "a", [
    { title: "Imported and finished", ref: "D", kind: "ticket", column: "done" },
    { title: "Imported mid-flight", ref: "W", kind: "ticket", column: "in_progress" },
  ]);
  clock.now += 20 * DAY;
  const { metrics } = await service.board(scope, { windowDays: 42 });
  assert.deepEqual(metrics.cycleTimes, []);
  assert.equal(
    metrics.throughput.reduce((sum, week) => sum + week.done, 0),
    0,
  );
  assert.deepEqual(
    metrics.aging.map((entry) => [entry.title, entry.ageDays, entry.inColumnDays]),
    [["Imported mid-flight", 20, 20]],
  );
  assert.equal(metrics.kpis.wip, 1);
});

test("a classifier's first placement is logged as placed, not as a move", async () => {
  const clock = { now: 50 * DAY };
  const store = createMemoryTpmStore({ now: () => clock.now });
  const jev: JevClient = {
    model: "jev-test",
    async evaluate(_state, questions) {
      const answers = Object.fromEntries(
        Object.entries(questions).map(([key, question]) => {
          if (key === "column")
            return [key, { type: "choice", choice: "done", confidence: 0.95, probabilities: { done: 0.95 } }];
          if (key === "kind")
            return [key, { type: "choice", choice: "ticket", confidence: 0.95, probabilities: { ticket: 0.95 } }];
          if (question.type === "score")
            return [key, { type: "score", score: 0, confidence: 0.9, probabilities: { "0": 0.9 } }];
          return [key, { type: "noul", noul: 0.01 }];
        }),
      );
      return { model: "jev-test", answers, usage: { inputTokens: 1, outputTokens: 1 } } as Awaited<
        ReturnType<JevClient["evaluate"]>
      >;
    },
  };
  const service = createTpmService({ store, classifier: jev, now: () => clock.now });
  assert.ok((await service.ingest(scope, "a", [{ title: "Shipped last quarter" }])).ok);
  const events = await store.listEvents(scope);
  assert.deepEqual(
    events.map((event) => event.type),
    ["item_created", "placed", "classified"],
  );
  clock.now += DAY;
  const { metrics } = await service.board(scope, { windowDays: 14 });
  assert.equal(metrics.kpis.doneThisWeek, 0);
  assert.equal(metrics.flow.at(-1)!.counts.done, 1);
});

test("customer issues report fix status and age; documents report freshness", async () => {
  const { clock, service } = setup();
  await service.ingest(scope, "a", [
    { title: "Acme export fails", ref: "C1", kind: "customer_issue", column: "backlog" },
    { title: "Globex double charge", ref: "C2", kind: "customer_issue", column: "backlog" },
    { title: "Fix double charge", ref: "T2", kind: "ticket", column: "in_progress" },
    { title: "Export design", ref: "D1", kind: "document", column: "done", updatedAt: 100 * DAY - 40 * DAY },
  ]);
  await service.link(scope, "a", { kind: "addresses", from: "T2", to: "C2" }, "agent");
  clock.now += 5 * DAY;
  await service.update(scope, "a", "T2", { column: "done" });
  clock.now += 2 * DAY;
  const { metrics } = await service.board(scope, { windowDays: 14 });
  assert.deepEqual(
    metrics.customerIssues.map((entry) => [entry.title, entry.status, entry.days]),
    [
      ["Acme export fails", "unaddressed", 7],
      ["Globex double charge", "fix_shipped", 7],
    ],
  );
  assert.equal(metrics.kpis.unaddressedCustomerIssues, 1);
  assert.deepEqual(metrics.documents, [
    { id: metrics.documents[0]!.id, title: "Export design", ageDays: 47, stale: true },
  ]);
});

test("a truncated event log starts each item in the column its first remaining move left", async () => {
  const { clock, store, service } = setup();
  await service.ingest(scope, "a", [{ title: "Long runner", ref: "T1", kind: "ticket", column: "in_progress" }]);
  clock.now += 30 * DAY;
  await service.update(scope, "a", "T1", { column: "blocked" });
  clock.now += 2 * DAY;
  const events = (await store.listEvents(scope)).filter((event) => event.type !== "item_created");
  const metrics = computeMetrics(await store.listItems(scope), [], events, clock.now, 42, 30);
  assert.equal(metrics.kpis.blockedDaysInWindow, 2);
  assert.deepEqual(
    metrics.aging.map((entry) => [entry.ageDays, entry.blockedDays]),
    [[32, 2]],
  );
});

test("work created in progress counts toward cycle time; reopened work restarts its clock", async () => {
  const { clock, service } = setup();
  await service.ingest(scope, "a", [
    { title: "Started on arrival", ref: "S", kind: "ticket", column: "in_progress" },
    { title: "Reopened", ref: "R", kind: "ticket" },
  ]);
  await service.update(scope, "a", "R", { column: "in_progress" });
  clock.now += 3 * DAY;
  await service.update(scope, "a", "S", { column: "done" });
  await service.update(scope, "a", "R", { column: "done" });
  clock.now += 5 * DAY;
  await service.update(scope, "a", "R", { column: "in_progress" });
  clock.now += 1 * DAY;
  const { metrics } = await service.board(scope, { windowDays: 14 });
  assert.deepEqual(
    metrics.cycleTimes.map((entry) => [entry.title, entry.days]),
    [["Started on arrival", 3]],
  );
  assert.deepEqual(
    metrics.aging.map((entry) => [entry.title, entry.ageDays]),
    [["Reopened", 1]],
  );
});

test("documents do not count as blocked work", async () => {
  const { clock, service } = setup();
  await service.ingest(scope, "a", [{ title: "Runbook", ref: "D", kind: "document", column: "blocked" }]);
  clock.now += 3 * DAY;
  const { metrics } = await service.board(scope, { windowDays: 14 });
  assert.equal(metrics.kpis.blockedNow, 0);
  assert.equal(metrics.kpis.blockedDaysInWindow, 0);
});
