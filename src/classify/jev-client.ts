import { fetchWithRetry } from "../util/async.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_QUESTIONS_PER_REQUEST = 64;
const MAX_RESPONSE_CHARS = 2_000_000;

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export interface JevEvaluation {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface JevClient {
  model: string;
  evaluate(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevEvaluation>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function probabilities(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new Error("Jev answer is missing probabilities");
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(value)) {
    if (!isUnit(p)) throw new Error("Jev answer has an invalid probability");
    out[key] = p;
  }
  return out;
}

function parseAnswer(raw: unknown, question: JevQuestion): JevAnswer {
  if (!isRecord(raw) || raw.type !== question.type) throw new Error("Jev answer type does not match its question");
  if (question.type === "noul") {
    if (!isUnit(raw.noul)) throw new Error("Jev noul answer is out of range");
    return { type: "noul", noul: raw.noul };
  }
  if (!isUnit(raw.confidence)) throw new Error("Jev answer confidence is out of range");
  if (question.type === "choice") {
    if (typeof raw.choice !== "string" || !(raw.choice in question.criteria)) {
      throw new Error("Jev choice answer is not one of the offered options");
    }
    return {
      type: "choice",
      choice: raw.choice,
      confidence: raw.confidence,
      probabilities: probabilities(raw.probabilities),
    };
  }
  const levels = question.criteria.length;
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > levels - 1) {
    throw new Error("Jev score answer is out of range");
  }
  return {
    type: "score",
    score: raw.score,
    confidence: raw.confidence,
    probabilities: probabilities(raw.probabilities),
  };
}

function chunkQuestions(questions: Record<string, JevQuestion>): Array<Record<string, JevQuestion>> {
  const entries = Object.entries(questions);
  const chunks: Array<Record<string, JevQuestion>> = [];
  for (let i = 0; i < entries.length; i += MAX_QUESTIONS_PER_REQUEST) {
    chunks.push(Object.fromEntries(entries.slice(i, i + MAX_QUESTIONS_PER_REQUEST)));
  }
  return chunks;
}

export function createJevClient(opts: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  endpoint?: string;
  fetch?: typeof fetch;
}): JevClient {
  const request = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? JEV_ENDPOINT;

  async function evaluateChunk(
    state: unknown,
    questions: Record<string, JevQuestion>,
    signal: AbortSignal | undefined,
  ): Promise<JevEvaluation> {
    const body = JSON.stringify({ state, model: opts.model, questions });
    const response = await fetchWithRetry(
      (attemptSignal) =>
        request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body,
          redirect: "error",
          signal: attemptSignal,
        }),
      "idempotent",
      { timeoutMs: opts.timeoutMs ?? 30_000, ...(signal ? { signal } : {}) },
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
    if (text.length > MAX_RESPONSE_CHARS) throw new Error("Jev response exceeds the supported size");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Jev returned a response that is not JSON");
    }
    if (!isRecord(parsed) || !isRecord(parsed.answers)) throw new Error("Jev response is missing answers");
    const answers: Record<string, JevAnswer> = {};
    for (const [key, question] of Object.entries(questions)) {
      answers[key] = parseAnswer(parsed.answers[key], question);
    }
    const usage = isRecord(parsed.usage) ? parsed.usage : {};
    return {
      model: typeof parsed.model === "string" ? parsed.model : opts.model,
      answers,
      usage: {
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      },
    };
  }

  return {
    model: opts.model,
    async evaluate(state, questions, signal) {
      const chunks = chunkQuestions(questions);
      if (chunks.length === 0) return { model: opts.model, answers: {}, usage: { inputTokens: 0, outputTokens: 0 } };
      const results = await Promise.all(chunks.map((chunk) => evaluateChunk(state, chunk, signal)));
      return {
        model: results[0]!.model,
        answers: Object.assign({}, ...results.map((result) => result.answers)) as Record<string, JevAnswer>,
        usage: {
          inputTokens: results.reduce((sum, result) => sum + result.usage.inputTokens, 0),
          outputTokens: results.reduce((sum, result) => sum + result.usage.outputTokens, 0),
        },
      };
    },
  };
}
