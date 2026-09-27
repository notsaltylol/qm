import { test } from "node:test";
import assert from "node:assert/strict";
import type { TpmStore } from "../../src/tpm/tpm-store.ts";

export function tpmStoreContract(
  name: string,
  make: (now: () => number) => TpmStore | Promise<TpmStore>,
  skip: string | false = false,
) {
  const scope = `channel:C-${Math.random().toString(36).slice(2)}` as const;

  test(`${name}: items record column changes as events`, { skip }, async () => {
    let at = 1_000;
    const store = await make(() => at);
    const item = await store.createItem({
      scopeId: scope,
      kind: "ticket",
      title: "Fix login",
      column: "backlog",
      externalRef: "ENG-1",
      actorId: "alice",
    });
    at = 2_000;
    const moved = await store.updateItem(item.id, { column: "in_progress" }, "bob");
    assert.equal(moved?.column, "in_progress");
    assert.equal(moved?.columnChangedAt, 2_000);
    at = 3_000;
    const renamed = await store.updateItem(item.id, { title: "Fix SSO login" }, "bob");
    assert.equal(renamed?.columnChangedAt, 2_000);
    const events = await store.listEvents(scope, { itemId: item.id });
    assert.deepEqual(
      events.map((event) => [event.type, event.fromValue ?? null, event.toValue ?? null, event.actorId]),
      [
        ["item_created", null, "backlog", "alice"],
        ["column_changed", "backlog", "in_progress", "bob"],
        ["item_updated", null, null, "bob"],
      ],
    );
    await store.close?.();
  });

  test(`${name}: refs are unique within a scope`, { skip }, async () => {
    const store = await make(() => 1);
    await store.createItem({
      scopeId: scope,
      kind: "ticket",
      title: "A",
      column: "backlog",
      externalRef: "REF-9",
      actorId: "a",
    });
    await assert.rejects(
      store.createItem({
        scopeId: scope,
        kind: "ticket",
        title: "B",
        column: "backlog",
        externalRef: "REF-9",
        actorId: "a",
      }),
      /already exists/,
    );
    const other = await store.createItem({
      scopeId: `${scope}-other` as never,
      kind: "ticket",
      title: "C",
      column: "backlog",
      externalRef: "REF-9",
      actorId: "a",
    });
    assert.equal(other.externalRef, "REF-9");
    await store.close?.();
  });

  test(`${name}: classifier cannot overwrite a decided edge`, { skip }, async () => {
    const store = await make(() => 5);
    const a = await store.createItem({ scopeId: scope, kind: "ticket", title: "A", column: "backlog", actorId: "u" });
    const b = await store.createItem({ scopeId: scope, kind: "ticket", title: "B", column: "backlog", actorId: "u" });
    const proposed = await store.upsertEdge({
      scopeId: scope,
      kind: "blocks",
      fromId: a.id,
      toId: b.id,
      state: "proposed",
      origin: "classifier",
      confidence: 0.6,
      actorId: "u",
    });
    assert.equal(proposed.decidedBy, undefined);
    const rejected = await store.decideEdge(proposed.id, "rejected", "carol");
    assert.equal(rejected?.state, "rejected");
    const again = await store.upsertEdge({
      scopeId: scope,
      kind: "blocks",
      fromId: a.id,
      toId: b.id,
      state: "confirmed",
      origin: "classifier",
      confidence: 0.99,
      actorId: "u",
    });
    assert.equal(again.state, "rejected");
    assert.equal(again.id, proposed.id);
    const agent = await store.upsertEdge({
      scopeId: scope,
      kind: "blocks",
      fromId: a.id,
      toId: b.id,
      state: "confirmed",
      origin: "agent",
      actorId: "dave",
    });
    assert.equal(agent.state, "confirmed");
    assert.equal(agent.decidedBy, "dave");
    await store.close?.();
  });

  test(`${name}: deleting an item removes its edges`, { skip }, async () => {
    const store = await make(() => 7);
    const localScope = `${scope}-delete` as never;
    const a = await store.createItem({
      scopeId: localScope,
      kind: "ticket",
      title: "A",
      column: "backlog",
      actorId: "u",
    });
    const b = await store.createItem({
      scopeId: localScope,
      kind: "customer_issue",
      title: "B",
      column: "backlog",
      actorId: "u",
    });
    await store.upsertEdge({
      scopeId: localScope,
      kind: "addresses",
      fromId: a.id,
      toId: b.id,
      state: "confirmed",
      origin: "agent",
      actorId: "u",
    });
    assert.equal(await store.deleteItem(a.id, "u"), true);
    assert.deepEqual(await store.listEdges(localScope), []);
    assert.equal(await store.deleteItem(a.id, "u"), false);
    await store.close?.();
  });

  test(`${name}: rubrics round-trip and scopes are listed with counts`, { skip }, async () => {
    const store = await make(() => 9);
    const localScope = `${scope}-rubric` as never;
    await store.createItem({ scopeId: localScope, kind: "document", title: "Spec", column: "done", actorId: "u" });
    const rubric = await store.setRubric(
      localScope,
      [{ key: "has_owner", type: "noul", instructions: "Does `item` name an owner?" }],
      "u",
    );
    assert.equal(rubric.questions.length, 1);
    assert.deepEqual((await store.getRubric(localScope))?.questions, rubric.questions);
    const scopes = await store.listScopes();
    assert.deepEqual(
      scopes.find((entry) => entry.scopeId === localScope),
      { scopeId: localScope, itemCount: 1 },
    );
    await store.close?.();
  });
}
