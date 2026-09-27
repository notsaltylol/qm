import { test } from "node:test";
import assert from "node:assert/strict";
import { createJevClient, JEV_ENDPOINT } from "../src/classify/jev-client.ts";

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("sends the documented request and parses typed answers", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const client = createJevClient({
    apiKey: "k-123",
    model: "jev-latest",
    fetch: async (url, init) => {
      seen = { url: String(url), init: init! };
      return respond({
        model: "jev-1.13.0",
        answers: {
          urgent: { type: "noul", noul: 0.8 },
          team: { type: "choice", choice: "billing", confidence: 0.7, probabilities: { billing: 0.85, tech: 0.15 } },
          anger: { type: "score", score: 1.2, confidence: 0.6, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } },
        },
        usage: { input_tokens: 40, output_tokens: 5 },
      });
    },
  });
  const result = await client.evaluate(
    { text: "refund please" },
    {
      urgent: { type: "noul", instructions: "Urgent?" },
      team: { type: "choice", instructions: "Team?", criteria: { billing: "Billing", tech: "Tech" } },
      anger: { type: "score", instructions: "Anger?", criteria: ["calm", "annoyed", "angry"] },
    },
  );
  assert.equal(seen?.url, JEV_ENDPOINT);
  assert.equal((seen?.init.headers as Record<string, string>).authorization, "Bearer k-123");
  assert.equal(JSON.parse(String(seen?.init.body)).model, "jev-latest");
  assert.deepEqual(result.answers.urgent, { type: "noul", noul: 0.8 });
  assert.equal(result.answers.team?.type === "choice" && result.answers.team.choice, "billing");
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 5 });
  assert.equal(result.model, "jev-1.13.0");
});

test("rejects answers outside the offered options or ranges", async () => {
  const client = createJevClient({
    apiKey: "k",
    model: "jev-latest",
    fetch: async () =>
      respond({ answers: { team: { type: "choice", choice: "sales", confidence: 0.9, probabilities: {} } } }),
  });
  await assert.rejects(
    client.evaluate("x", { team: { type: "choice", instructions: "Team?", criteria: { billing: "B" } } }),
    /not one of the offered options/,
  );
});

test("fails on HTTP errors without leaking the key", async () => {
  const client = createJevClient({
    apiKey: "secret-key",
    model: "jev-latest",
    fetch: async () => respond({ error: "bad" }, 401),
  });
  await assert.rejects(client.evaluate("x", { q: { type: "noul", instructions: "?" } }), (error: Error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /secret-key/);
    return true;
  });
});

test("splits large question sets across requests and merges answers", async () => {
  let requests = 0;
  const client = createJevClient({
    apiKey: "k",
    model: "jev-latest",
    fetch: async (_url, init) => {
      requests += 1;
      const questions = JSON.parse(String(init!.body)).questions as Record<string, unknown>;
      return respond({
        answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul", noul: 0.5 }])),
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const questions = Object.fromEntries(
    Array.from({ length: 130 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "?" }]),
  );
  const result = await client.evaluate("x", questions);
  assert.equal(requests, 3);
  assert.equal(Object.keys(result.answers).length, 130);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 3 });
});
