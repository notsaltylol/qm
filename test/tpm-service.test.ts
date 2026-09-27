import { test } from "node:test";
import assert from "node:assert/strict";
import type { JevAnswer, JevClient, JevQuestion } from "../src/classify/jev-client.ts";
import { createMemoryTpmStore } from "../src/tpm/memory-tpm-store.ts";
import { createTpmService, validateRubric } from "../src/tpm/tpm-service.ts";

const scope = "channel:C1" as const;

type Rule = (
  key: string,
  question: JevQuestion,
  state: { item: { title: string }; candidates: Array<{ title: string }> },
) => JevAnswer | undefined;

function fakeJev(rule: Rule): JevClient & { calls: Array<{ state: unknown; keys: string[] }> } {
  const calls: Array<{ state: unknown; keys: string[] }> = [];
  return {
    model: "jev-test",
    calls,
    async evaluate(state, questions) {
      calls.push({ state, keys: Object.keys(questions) });
      const answers: Record<string, JevAnswer> = {};
      for (const [key, question] of Object.entries(questions)) {
        const given = rule(key, question, state as never);
        if (given) answers[key] = given;
        else if (question.type === "noul") answers[key] = { type: "noul", noul: 0.02 };
        else if (question.type === "choice") {
          const first = Object.keys(question.criteria)[0]!;
          answers[key] = { type: "choice", choice: first, confidence: 0.1, probabilities: { [first]: 0.3 } };
        } else answers[key] = { type: "score", score: 0, confidence: 0.9, probabilities: { "0": 0.95 } };
      }
      return { model: "jev-test", answers, usage: { inputTokens: 10, outputTokens: 2 } };
    },
  };
}

const choice = (value: string, confidence = 0.9): JevAnswer => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: { [value]: 0.95 },
});

test("ingest classifies kind and column and applies confident links", async () => {
  const jev = fakeJev((key, _question, state) => {
    const title = state.item.title;
    if (key === "kind") return choice(title.startsWith("Acme") ? "customer_issue" : "ticket");
    if (key === "column") return choice(title.startsWith("Acme") ? "backlog" : "in_progress");
    const index = Number(key.split("_").at(-1));
    const candidate = state.candidates[index]?.title ?? "";
    if (key.startsWith("candidate_fixes_") && title.startsWith("Acme") && candidate.includes("export"))
      return { type: "noul", noul: 0.93 };
    if (key.startsWith("blocked_by_") && title.includes("export") && candidate.includes("queue"))
      return { type: "noul", noul: 0.65 };
    return undefined;
  });
  const service = createTpmService({ store: createMemoryTpmStore(), classifier: jev });
  const result = await service.ingest(scope, "alice", [
    { title: "Move export jobs to the job queue", body: "Queue migration for export jobs", ref: "ENG-1" },
    {
      title: "Stream CSV export for large accounts",
      body: "export jobs need the job queue before streaming works",
      ref: "ENG-2",
    },
    {
      title: "Acme: CSV export times out",
      body: "Acme cannot export their accounts; export jobs time out",
      ref: "ZD-7",
    },
  ]);
  assert.ok(result.ok);
  const byRef = new Map(result.value.created.map((item) => [item.externalRef, item]));
  assert.equal(byRef.get("ZD-7")?.kind, "customer_issue");
  assert.equal(byRef.get("ENG-2")?.column, "in_progress");
  const board = await service.board(scope);
  const edge = (kind: string, from: string, to: string) =>
    board.edges.find(
      (candidate) =>
        candidate.kind === kind && candidate.fromId === byRef.get(from)!.id && candidate.toId === byRef.get(to)!.id,
    );
  assert.equal(edge("addresses", "ENG-2", "ZD-7")?.state, "confirmed");
  assert.equal(edge("blocks", "ENG-1", "ENG-2")?.state, "proposed");
  assert.equal(board.insights.customerCoverage[0]?.status, "in_flight");
  assert.equal(board.insights.pendingReview, 1);
  assert.ok(result.value.usage.questions > 0);
  assert.equal(jev.calls.length, 3);
  assert.deepEqual((jev.calls[0]!.state as { candidates: unknown[] }).candidates, []);
});

test("explicit kind and column skip those questions; a low-confidence guess is kept and flagged", async () => {
  const jev = fakeJev((key) => (key === "column" ? choice("done", 0.3) : undefined));
  const service = createTpmService({ store: createMemoryTpmStore(), classifier: jev });
  const result = await service.ingest(scope, "alice", [
    { title: "Billing v2 design", kind: "document", updatedAt: 1_000 },
  ]);
  assert.ok(result.ok);
  assert.ok(!jev.calls[0]!.keys.includes("kind"));
  assert.equal(result.value.created[0]!.kind, "document");
  assert.equal(result.value.created[0]!.column, "done");
  assert.deepEqual(result.value.lowConfidence, [{ itemId: result.value.created[0]!.id, fields: ["column"] }]);
});

test("re-adding a ref updates in place and a rejected link stays rejected", async () => {
  const jev = fakeJev((key, _question, state) => {
    if (key.startsWith("blocked_by_") && state.candidates.length) return { type: "noul", noul: 0.99 };
    return key === "kind" ? choice("ticket") : undefined;
  });
  const service = createTpmService({ store: createMemoryTpmStore(), classifier: jev });
  await service.ingest(scope, "a", [{ title: "Upgrade Postgres", ref: "OPS-1", kind: "ticket" }]);
  const first = await service.ingest(scope, "a", [
    { title: "Ship Postgres failover", body: "waits on Upgrade Postgres", ref: "OPS-2", kind: "ticket" },
  ]);
  assert.ok(first.ok);
  const [edge] = first.value.confirmedEdges;
  assert.ok(edge);
  const decided = await service.decide(scope, "person", edge.id.slice(0, 8), false);
  assert.ok(decided.ok);
  const again = await service.ingest(scope, "a", [
    { title: "Ship Postgres failover", body: "still waits on Upgrade Postgres", ref: "OPS-2" },
  ]);
  assert.ok(again.ok);
  assert.equal(again.value.created.length, 0);
  assert.equal(again.value.updated.length, 1);
  const board = await service.board(scope);
  assert.equal(board.items.length, 2);
  assert.equal(board.edges.length, 0);
});

test("a classifier outage keeps items and reports the failure", async () => {
  const jev: JevClient = {
    model: "jev-test",
    evaluate: async () => {
      throw new Error("Jev returned HTTP 503");
    },
  };
  const service = createTpmService({ store: createMemoryTpmStore(), classifier: jev });
  const result = await service.ingest(scope, "a", [{ title: "Anything" }]);
  assert.ok(result.ok);
  assert.equal(result.value.classifier, "failed");
  assert.match(result.value.failure ?? "", /503/);
  assert.equal((await service.board(scope)).items.length, 1);
});

test("without a classifier, agent links still build the graph and insights", async () => {
  let now = 1_000;
  const service = createTpmService({ store: createMemoryTpmStore({ now: () => now }), now: () => now });
  const added = await service.ingest(scope, "a", [
    { title: "Vendor contract", ref: "M-1", kind: "milestone", column: "blocked" },
    { title: "SSO rollout", ref: "T-1", kind: "ticket", column: "ready" },
    { title: "Audit logging", ref: "T-2", kind: "ticket", column: "ready" },
    { title: "Rollout plan", ref: "D-1", kind: "document", column: "done", updatedAt: 1_000 },
  ]);
  assert.ok(added.ok);
  assert.equal(added.value.classifier, "unavailable");
  for (const [from, to] of [
    ["M-1", "T-1"],
    ["T-1", "T-2"],
  ] as const) {
    assert.ok((await service.link(scope, "a", { kind: "blocks", from, to }, "agent")).ok);
  }
  assert.ok((await service.link(scope, "a", { kind: "documents", from: "D-1", to: "T-1" }, "agent")).ok);
  now = 1_000 + 40 * 86_400_000;
  assert.ok((await service.update(scope, "a", "T-1", { column: "in_progress" })).ok);
  const insights = (await service.board(scope)).insights;
  const blockedT2 = insights.blocked.find((entry) => entry.title === "Audit logging");
  assert.deepEqual(
    blockedT2?.rootBlockers.map((entry) => entry.title),
    ["Vendor contract"],
  );
  assert.equal(insights.bottlenecks[0]?.title, "Vendor contract");
  assert.deepEqual(insights.staleDocuments[0]?.reasons, ["old", "behind_work"]);
  assert.equal((await service.link(scope, "a", { kind: "blocks", from: "T-1", to: "T-1" }, "agent")).ok, false);
});

test("rubric validation rejects malformed questions and accepts well-formed ones", () => {
  assert.equal(validateRubric([{ key: "Bad Key", type: "noul", instructions: "x" }]).ok, false);
  assert.equal(
    validateRubric([{ key: "tier", type: "choice", instructions: "Which tier?", criteria: { a: "A" } }]).ok,
    false,
  );
  assert.equal(validateRubric([{ key: "risk", type: "score", instructions: "Risk?", criteria: ["low"] }]).ok, false);
  const ok = validateRubric([
    { key: "has_owner", type: "noul", instructions: "Does `item` name a single owner?", appliesTo: ["ticket"] },
    { key: "area", type: "choice", instructions: "Which area?", criteria: { billing: "Billing", auth: "Auth" } },
  ]);
  assert.ok(ok.ok);
  assert.equal(ok.value.length, 2);
});

test("custom rubric questions are asked and kept only for matching kinds", async () => {
  const answers: Record<string, JevAnswer> = { kind: choice("ticket"), custom_has_owner: { type: "noul", noul: 0.9 } };
  const jev = fakeJev((key) => answers[key]);
  const service = createTpmService({ store: createMemoryTpmStore(), classifier: jev });
  assert.ok(
    (
      await service.setRubric(scope, "a", [
        { key: "has_owner", type: "noul", instructions: "Does `item` name one owner?", appliesTo: ["ticket"] },
        {
          key: "is_contractual",
          type: "noul",
          instructions: "Is `item` a contractual commitment?",
          appliesTo: ["customer_issue"],
        },
      ])
    ).ok,
  );
  const result = await service.ingest(scope, "a", [{ title: "Owner: Dana — fix retries" }]);
  assert.ok(result.ok);
  assert.ok(jev.calls[0]!.keys.includes("custom_is_contractual"));
  assert.deepEqual(Object.keys(result.value.created[0]!.signals.custom ?? {}), ["has_owner"]);
});

test("the classifier's first placement of a new item is not counted as the work moving", async () => {
  let now = 10_000;
  const answers: Record<string, JevAnswer> = { column: choice("in_progress"), kind: choice("ticket") };
  const jev = fakeJev((key) => answers[key]);
  const service = createTpmService({
    store: createMemoryTpmStore({ now: () => now }),
    classifier: jev,
    now: () => now,
  });
  const doc = await service.ingest(scope, "a", [
    { title: "Runbook", kind: "document", column: "done", ref: "D", updatedAt: 5_000 },
  ]);
  assert.ok(doc.ok);
  now = 20_000;
  const work = await service.ingest(scope, "a", [{ title: "Launch", ref: "L" }]);
  assert.ok(work.ok);
  assert.equal(work.value.created[0]!.column, "in_progress");
  assert.equal(work.value.created[0]!.columnChangedAt, work.value.created[0]!.createdAt);
  assert.ok((await service.link(scope, "a", { kind: "documents", from: "D", to: "L" }, "agent")).ok);
  assert.deepEqual((await service.board(scope)).insights.staleDocuments, []);
  now = 30_000;
  assert.ok((await service.update(scope, "a", "L", { column: "done" })).ok);
  assert.deepEqual(
    (await service.board(scope)).insights.staleDocuments.map((entry) => entry.reasons),
    [["behind_work"]],
  );
});

test("links from an item whose kind is uncertain are only proposed", async () => {
  const jev = fakeJev((key, _question, state) => {
    if (key === "kind")
      return choice(
        state.item.title.startsWith("Spec") ? "document" : "ticket",
        state.item.title.startsWith("Spec") ? 0.4 : 0.95,
      );
    if (key.startsWith("item_describes_") && state.candidates.length) return { type: "noul", noul: 0.97 };
    return undefined;
  });
  const service = createTpmService({ store: createMemoryTpmStore(), classifier: jev });
  assert.ok((await service.ingest(scope, "a", [{ title: "Build the importer", ref: "T" }])).ok);
  const result = await service.ingest(scope, "a", [{ title: "Spec for the importer", ref: "S" }]);
  assert.ok(result.ok);
  assert.equal(result.value.created[0]!.kind, "document");
  assert.ok(result.value.lowConfidence[0]?.fields.includes("kind"));
  assert.equal(result.value.confirmedEdges.length, 0);
  assert.equal(result.value.proposedEdges[0]?.kind, "documents");
});

test("links between batch-mates use their final kinds, not the placeholder kind", async () => {
  const jev = fakeJev((key, _question, state) => {
    if (key === "kind") return choice(state.item.title.startsWith("Customer") ? "customer_issue" : "milestone");
    if (/^(blocked_by|blocks)_/.test(key)) return { type: "noul", noul: 0.99 };
    return undefined;
  });
  const service = createTpmService({ store: createMemoryTpmStore(), classifier: jev });
  const result = await service.ingest(scope, "a", [
    { title: "Customer says launch page is down", ref: "C" },
    { title: "Launch milestone", ref: "M" },
  ]);
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.created.map((item) => item.kind),
    ["customer_issue", "milestone"],
  );
  assert.deepEqual((await service.board(scope)).edges, []);
});
