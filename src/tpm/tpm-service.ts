import type { JevClient } from "../classify/jev-client.ts";
import type { ScopeId } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { selectCandidates } from "./tpm-candidates.ts";
import {
  ACCEPT_CHOICE_AT,
  CONFIRM_EDGE_AT,
  classifyItem,
  resolveRelations,
  type ItemDraft,
  type LinkJudgments,
} from "./tpm-classifier.ts";
import { STALE_DOC_DAYS, computeInsights, type TpmInsights } from "./tpm-insights.ts";
import { DEFAULT_METRIC_WINDOW, computeMetrics, type TpmMetrics } from "./tpm-metrics.ts";
import {
  isTpmColumn,
  isTpmEdgeKind,
  isTpmKind,
  type TpmColumn,
  type TpmEdge,
  type TpmEdgeKind,
  type TpmEdgeOrigin,
  type TpmItem,
  type TpmItemPatch,
  type TpmKind,
  type TpmRubric,
  type TpmRubricQuestion,
  type TpmSignals,
  type TpmStore,
} from "./tpm-store.ts";

export const MAX_INGEST_ITEMS = 50;
const MAX_METRIC_EVENTS = 50_000;
export const MAX_RUBRIC_QUESTIONS = 20;
const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS = 20_000;
const CANDIDATE_LIMIT = 12;
const CLASSIFY_CONCURRENCY = 4;

export interface TpmItemInput {
  title: string;
  body?: string;
  kind?: TpmKind;
  column?: TpmColumn;
  ref?: string;
  assignee?: string;
  updatedAt?: number;
}

export type TpmUpdateInput = Omit<Partial<TpmItemInput>, "ref"> & { ref?: string | null };

export type TpmResult<T> = { ok: true; value: T } | { ok: false; code: TpmErrorCode; message: string };
type TpmErrorCode = "invalid" | "not_found" | "conflict";

export interface TpmIngestSummary {
  created: TpmItem[];
  updated: TpmItem[];
  confirmedEdges: TpmEdge[];
  proposedEdges: TpmEdge[];
  lowConfidence: Array<{ itemId: string; fields: string[] }>;
  classifier: "used" | "unavailable" | "failed";
  failure?: string;
  usage: { inputTokens: number; outputTokens: number; questions: number };
}

export interface TpmBoardView {
  scopeId: ScopeId;
  items: TpmItem[];
  edges: TpmEdge[];
  insights: TpmInsights;
  metrics: TpmMetrics;
  rubric: TpmRubricQuestion[];
  classifier: { available: boolean; model?: string };
}

export interface TpmService {
  classifierAvailable: boolean;
  board(scopeId: ScopeId, opts?: { windowDays?: number }): Promise<TpmBoardView>;
  boards(): Promise<Array<{ scopeId: ScopeId; itemCount: number }>>;
  resolve(scopeId: ScopeId, idOrRef: string): Promise<TpmItem | null>;
  ingest(
    scopeId: ScopeId,
    actorId: string,
    inputs: readonly TpmItemInput[],
    signal?: AbortSignal,
  ): Promise<TpmResult<TpmIngestSummary>>;
  update(
    scopeId: ScopeId,
    actorId: string,
    idOrRef: string,
    input: TpmUpdateInput,
    signal?: AbortSignal,
  ): Promise<TpmResult<TpmIngestSummary>>;
  remove(scopeId: ScopeId, actorId: string, idOrRef: string): Promise<TpmResult<TpmItem>>;
  link(
    scopeId: ScopeId,
    actorId: string,
    input: { kind: TpmEdgeKind; from: string; to: string },
    origin: TpmEdgeOrigin,
  ): Promise<TpmResult<TpmEdge>>;
  decide(scopeId: ScopeId, actorId: string, edgeId: string, accept: boolean): Promise<TpmResult<TpmEdge>>;
  setRubric(scopeId: ScopeId, actorId: string, questions: unknown): Promise<TpmResult<TpmRubric>>;
  reclassify(
    scopeId: ScopeId,
    actorId: string,
    idsOrRefs?: readonly string[],
    signal?: AbortSignal,
  ): Promise<TpmResult<TpmIngestSummary>>;
}

const fail = (code: TpmErrorCode, message: string): { ok: false; code: TpmErrorCode; message: string } => ({
  ok: false,
  code,
  message,
});

function validateInput(input: Partial<TpmItemInput>, requireTitle: boolean): string | null {
  if (requireTitle && (typeof input.title !== "string" || !input.title.trim())) return "each item needs a title";
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > MAX_TITLE_CHARS)) {
    return `titles must be at most ${MAX_TITLE_CHARS} characters`;
  }
  if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > MAX_BODY_CHARS)) {
    return `bodies must be at most ${MAX_BODY_CHARS} characters`;
  }
  if (input.kind !== undefined && !isTpmKind(input.kind)) return `unknown kind ${String(input.kind)}`;
  if (input.column !== undefined && !isTpmColumn(input.column)) return `unknown column ${String(input.column)}`;
  if (input.updatedAt !== undefined && (!Number.isFinite(input.updatedAt) || input.updatedAt <= 0)) {
    return "updatedAt must be a positive epoch-millisecond timestamp";
  }
  return null;
}

export function validateRubric(questions: unknown): TpmResult<TpmRubricQuestion[]> {
  if (!Array.isArray(questions)) return fail("invalid", "questions must be an array");
  if (questions.length > MAX_RUBRIC_QUESTIONS) return fail("invalid", `at most ${MAX_RUBRIC_QUESTIONS} questions`);
  const seen = new Set<string>();
  const out: TpmRubricQuestion[] = [];
  for (const raw of questions) {
    if (typeof raw !== "object" || raw === null) return fail("invalid", "each question must be an object");
    const q = raw as Record<string, unknown>;
    const key = q.key;
    if (typeof key !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(key) || seen.has(key)) {
      return fail("invalid", "each question needs a unique lowercase key (letters, digits, underscores)");
    }
    seen.add(key);
    if (typeof q.instructions !== "string" || !q.instructions.trim() || q.instructions.length > 1_000) {
      return fail("invalid", `question ${key} needs instructions of at most 1000 characters`);
    }
    const appliesTo = q.appliesTo;
    if (
      appliesTo !== undefined &&
      (!Array.isArray(appliesTo) || appliesTo.length === 0 || !appliesTo.every(isTpmKind))
    ) {
      return fail("invalid", `question ${key} has an invalid appliesTo list`);
    }
    const base = {
      key,
      instructions: q.instructions.trim(),
      ...(appliesTo ? { appliesTo: appliesTo as TpmKind[] } : {}),
    };
    if (q.type === "noul") {
      out.push({ ...base, type: "noul" });
    } else if (q.type === "choice") {
      const criteria = q.criteria;
      const entries =
        typeof criteria === "object" && criteria !== null && !Array.isArray(criteria) ? Object.entries(criteria) : [];
      if (entries.length < 2 || entries.length > 32 || !entries.every(([, v]) => typeof v === "string")) {
        return fail("invalid", `choice question ${key} needs 2 to 32 options, each mapped to a description`);
      }
      out.push({ ...base, type: "choice", criteria: Object.fromEntries(entries) as Record<string, string> });
    } else if (q.type === "score") {
      const criteria = q.criteria;
      if (
        !Array.isArray(criteria) ||
        criteria.length < 2 ||
        criteria.length > 10 ||
        !criteria.every((v) => typeof v === "string")
      ) {
        return fail("invalid", `score question ${key} needs 2 to 10 ordered level descriptions`);
      }
      out.push({ ...base, type: "score", criteria: criteria as string[] });
    } else {
      return fail("invalid", `question ${key} must have type noul, choice, or score`);
    }
  }
  return { ok: true, value: out };
}

async function mapLimit<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const MIN_PREFIX_CHARS = 6;

function uniquePrefix<T extends { id: string }>(values: readonly T[], prefix: string): T | null {
  if (prefix.length < MIN_PREFIX_CHARS) return null;
  const matches = values.filter((value) => value.id.startsWith(prefix));
  return matches.length === 1 ? matches[0]! : null;
}

interface ClassifyTarget {
  item: TpmItem;
  created?: boolean;
  draft: ItemDraft;
  candidatePool: TpmItem[];
}

export function createTpmService(deps: { store: TpmStore; classifier?: JevClient; now?: () => number }): TpmService {
  const { store, classifier } = deps;
  const now = deps.now ?? (() => Date.now());

  async function resolve(scopeId: ScopeId, idOrRef: string): Promise<TpmItem | null> {
    const key = idOrRef.trim();
    if (!key) return null;
    const byId = await store.getItem(key);
    if (byId && byId.scopeId === scopeId) return byId;
    const items = await store.listItems(scopeId);
    return items.find((item) => item.externalRef === key) ?? uniquePrefix(items, key);
  }

  async function rubricFor(scopeId: ScopeId): Promise<TpmRubricQuestion[]> {
    return (await store.getRubric(scopeId))?.questions ?? [];
  }

  function emptySummary(): TpmIngestSummary {
    return {
      created: [],
      updated: [],
      confirmedEdges: [],
      proposedEdges: [],
      lowConfidence: [],
      classifier: classifier ? "used" : "unavailable",
      usage: { inputTokens: 0, outputTokens: 0, questions: 0 },
    };
  }

  async function classifyTargets(
    scopeId: ScopeId,
    actorId: string,
    targets: readonly ClassifyTarget[],
    summary: TpmIngestSummary,
    signal: AbortSignal | undefined,
  ): Promise<Map<string, TpmItem>> {
    const finalItems = new Map<string, TpmItem>();
    if (!classifier || targets.length === 0) return finalItems;
    const rubric = await rubricFor(scopeId);
    const failures: string[] = [];
    const pending: Array<{ itemId: string; kind: TpmKind; links: LinkJudgments }> = [];
    const uncertainKinds = new Set<string>();
    await mapLimit(targets, CLASSIFY_CONCURRENCY, async (target) => {
      const candidates = selectCandidates(target.item, target.candidatePool, CANDIDATE_LIMIT);
      let result;
      try {
        result = await classifyItem(classifier, target.draft, candidates, rubric, signal);
      } catch (error) {
        failures.push(errMessage(error));
        summary.lowConfidence.push({ itemId: target.item.id, fields: ["unclassified"] });
        return;
      }
      summary.usage.inputTokens += result.usage.inputTokens;
      summary.usage.outputTokens += result.usage.outputTokens;
      summary.usage.questions += result.questionCount;
      const low: string[] = [];
      const accepted = <T>(
        field: string,
        given: T | undefined,
        judged: { value: T; confidence: number } | null,
        fallback: T,
      ): T => {
        if (given !== undefined) return given;
        if (judged && judged.confidence >= ACCEPT_CHOICE_AT) return judged.value;
        low.push(field);
        return judged?.value ?? fallback;
      };
      const kind = accepted("kind", target.draft.kind, result.kind, target.item.kind);
      const column = accepted("column", target.draft.column, result.column, target.item.column);
      const custom = Object.fromEntries(
        rubric
          .filter((question) => !question.appliesTo || question.appliesTo.includes(kind))
          .flatMap((question) => (result.custom[question.key] ? [[question.key, result.custom[question.key]!]] : [])),
      );
      const signals: TpmSignals = {
        mentionsBlocker: result.mentionsBlocker,
        ...(kind === "customer_issue" ? { customerImpact: result.customerImpact } : {}),
        ...(low.length ? { lowConfidence: low } : {}),
        ...(Object.keys(custom).length ? { custom } : {}),
        classifiedAt: now(),
        model: result.model,
      };
      const updated = await store.updateItem(
        target.item.id,
        { kind, column, signals, ...(target.created ? { placement: true } : {}) },
        actorId,
      );
      if (updated) finalItems.set(updated.id, updated);
      if (low.length) summary.lowConfidence.push({ itemId: target.item.id, fields: low });
      pending.push({ itemId: target.item.id, kind, links: result.links });
      if (low.includes("kind")) uncertainKinds.add(target.item.id);
    });
    const kinds = new Map((await store.listItems(scopeId)).map((item) => [item.id, item.kind]));
    for (const entry of pending) {
      for (const relation of resolveRelations(entry.itemId, entry.kind, entry.links, (id) => kinds.get(id))) {
        const certain = !uncertainKinds.has(relation.fromId) && !uncertainKinds.has(relation.toId);
        const edge = await store.upsertEdge({
          scopeId,
          kind: relation.kind,
          fromId: relation.fromId,
          toId: relation.toId,
          state: relation.probability >= CONFIRM_EDGE_AT && certain ? "confirmed" : "proposed",
          origin: "classifier",
          confidence: relation.probability,
          actorId,
        });
        if (edge.state === "confirmed") summary.confirmedEdges.push(edge);
        else if (edge.state === "proposed") summary.proposedEdges.push(edge);
      }
    }
    if (failures.length) {
      summary.classifier = "failed";
      summary.failure = failures[0];
    }
    return finalItems;
  }

  function replaceClassified(list: TpmItem[], finalItems: Map<string, TpmItem>): TpmItem[] {
    return list.map((item) => finalItems.get(item.id) ?? item);
  }

  const service: TpmService = {
    classifierAvailable: classifier !== undefined,

    async board(scopeId, opts = {}) {
      const [items, edges, rubric, events] = await Promise.all([
        store.listItems(scopeId),
        store.listEdges(scopeId),
        rubricFor(scopeId),
        store.listEvents(scopeId, { limit: MAX_METRIC_EVENTS }),
      ]);
      const visibleEdges = edges.filter((edge) => edge.state !== "rejected");
      const at = now();
      return {
        scopeId,
        items,
        edges: visibleEdges,
        insights: computeInsights(items, visibleEdges, at),
        metrics: computeMetrics(
          items,
          visibleEdges,
          events,
          at,
          opts.windowDays ?? DEFAULT_METRIC_WINDOW,
          STALE_DOC_DAYS,
        ),
        rubric,
        classifier: { available: classifier !== undefined, ...(classifier ? { model: classifier.model } : {}) },
      };
    },

    boards: () => store.listScopes(),

    resolve,

    async ingest(scopeId, actorId, inputs, signal) {
      if (!Array.isArray(inputs) || inputs.length === 0) return fail("invalid", "items must be a non-empty list");
      if (inputs.length > MAX_INGEST_ITEMS) return fail("invalid", `at most ${MAX_INGEST_ITEMS} items per call`);
      for (const input of inputs) {
        const problem = validateInput(input, true);
        if (problem) return fail("invalid", problem);
      }
      const refs = inputs.flatMap((input) => (input.ref ? [input.ref] : []));
      if (new Set(refs).size !== refs.length) return fail("invalid", "each ref may appear only once per call");
      const summary = emptySummary();
      const existing = await store.listItems(scopeId);
      const byRef = new Map(existing.flatMap((item) => (item.externalRef ? [[item.externalRef, item] as const] : [])));
      const targets: ClassifyTarget[] = [];
      const touched: TpmItem[] = [];
      for (const input of inputs) {
        const title = input.title.trim();
        const body = input.body ?? "";
        const prior = input.ref ? byRef.get(input.ref) : undefined;
        if (prior) {
          const bodyChanged = input.body !== undefined && input.body !== prior.body;
          const patch: TpmItemPatch = {
            title,
            ...(input.body !== undefined ? { body } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.column ? { column: input.column } : {}),
            ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
            ...(input.updatedAt !== undefined ? { sourceUpdatedAt: input.updatedAt } : {}),
          };
          const updated = await store.updateItem(prior.id, patch, actorId);
          if (!updated) continue;
          summary.updated.push(updated);
          touched.push(updated);
          if (bodyChanged || title !== prior.title || input.kind) {
            targets.push({
              item: updated,
              draft: {
                title: updated.title,
                body: updated.body,
                kind: input.kind ?? updated.kind,
                ...(input.column || !bodyChanged ? { column: input.column ?? updated.column } : {}),
              },
              candidatePool: [],
            });
          }
          continue;
        }
        const created = await store.createItem({
          scopeId,
          kind: input.kind ?? "ticket",
          title,
          body,
          column: input.column ?? "backlog",
          ...(input.ref ? { externalRef: input.ref } : {}),
          ...(input.assignee ? { assignee: input.assignee } : {}),
          ...(input.updatedAt !== undefined ? { sourceUpdatedAt: input.updatedAt } : {}),
          actorId,
        });
        summary.created.push(created);
        touched.push(created);
        targets.push({
          item: created,
          created: true,
          draft: {
            title,
            body,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.column ? { column: input.column } : {}),
          },
          candidatePool: [],
        });
      }
      const touchedIds = new Set(touched.map((item) => item.id));
      const untouched = existing.filter((item) => !touchedIds.has(item.id));
      targets.forEach((target, index) => {
        target.candidatePool = [...untouched, ...targets.slice(0, index).map((earlier) => earlier.item)];
      });
      const finalItems = await classifyTargets(scopeId, actorId, targets, summary, signal);
      summary.created = replaceClassified(summary.created, finalItems);
      summary.updated = replaceClassified(summary.updated, finalItems);
      return { ok: true, value: summary };
    },

    async update(scopeId, actorId, idOrRef, input, signal) {
      const item = await resolve(scopeId, idOrRef);
      if (!item) return fail("not_found", `no item ${idOrRef} on this board`);
      const problem = validateInput({ ...input, ref: undefined } as Partial<TpmItemInput>, false);
      if (problem) return fail("invalid", problem);
      if (input.title !== undefined && !input.title.trim()) return fail("invalid", "title cannot be empty");
      if (input.ref) {
        const clash = await resolve(scopeId, input.ref);
        if (clash && clash.id !== item.id) return fail("conflict", `ref ${input.ref} already belongs to another item`);
      }
      const patch: TpmItemPatch = {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.column ? { column: input.column } : {}),
        ...(input.ref !== undefined ? { externalRef: input.ref } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
        ...(input.updatedAt !== undefined ? { sourceUpdatedAt: input.updatedAt } : {}),
      };
      const updated = await store.updateItem(item.id, patch, actorId);
      if (!updated) return fail("not_found", `no item ${idOrRef} on this board`);
      const summary = emptySummary();
      summary.updated.push(updated);
      const contentChanged =
        (input.body !== undefined && input.body !== item.body) ||
        (input.title !== undefined && input.title.trim() !== item.title);
      if (contentChanged) {
        const pool = (await store.listItems(scopeId)).filter((other) => other.id !== updated.id);
        const finalItems = await classifyTargets(
          scopeId,
          actorId,
          [
            {
              item: updated,
              draft: {
                title: updated.title,
                body: updated.body,
                kind: updated.kind,
                ...(input.column ? { column: input.column } : {}),
              },
              candidatePool: pool,
            },
          ],
          summary,
          signal,
        );
        summary.updated = replaceClassified(summary.updated, finalItems);
      } else {
        summary.classifier = "unavailable";
      }
      return { ok: true, value: summary };
    },

    async remove(scopeId, actorId, idOrRef) {
      const item = await resolve(scopeId, idOrRef);
      if (!item) return fail("not_found", `no item ${idOrRef} on this board`);
      await store.deleteItem(item.id, actorId);
      return { ok: true, value: item };
    },

    async link(scopeId, actorId, input, origin) {
      if (!isTpmEdgeKind(input.kind)) return fail("invalid", `unknown link kind ${String(input.kind)}`);
      const [from, to] = await Promise.all([resolve(scopeId, input.from), resolve(scopeId, input.to)]);
      if (!from) return fail("not_found", `no item ${input.from} on this board`);
      if (!to) return fail("not_found", `no item ${input.to} on this board`);
      if (from.id === to.id) return fail("invalid", "an item cannot link to itself");
      const edge = await store.upsertEdge({
        scopeId,
        kind: input.kind,
        fromId: from.id,
        toId: to.id,
        state: "confirmed",
        origin,
        actorId,
      });
      return { ok: true, value: edge };
    },

    async decide(scopeId, actorId, edgeId, accept) {
      const edges = await store.listEdges(scopeId);
      const edge = edges.find((candidate) => candidate.id === edgeId.trim()) ?? uniquePrefix(edges, edgeId.trim());
      if (!edge) return fail("not_found", `no link ${edgeId} on this board`);
      const decided = await store.decideEdge(edge.id, accept ? "confirmed" : "rejected", actorId);
      return decided ? { ok: true, value: decided } : fail("not_found", `no link ${edgeId} on this board`);
    },

    async setRubric(scopeId, actorId, questions) {
      const valid = validateRubric(questions);
      if (!valid.ok) return valid;
      return { ok: true, value: await store.setRubric(scopeId, valid.value, actorId) };
    },

    async reclassify(scopeId, actorId, idsOrRefs, signal) {
      const items = await store.listItems(scopeId);
      let selected = items;
      if (idsOrRefs && idsOrRefs.length) {
        const wanted: TpmItem[] = [];
        for (const key of idsOrRefs) {
          const item =
            items.find((candidate) => candidate.id === key || candidate.externalRef === key) ??
            uniquePrefix(items, key);
          if (!item) return fail("not_found", `no item ${key} on this board`);
          wanted.push(item);
        }
        selected = wanted;
      }
      if (selected.length > MAX_INGEST_ITEMS) return fail("invalid", `at most ${MAX_INGEST_ITEMS} items per call`);
      const summary = emptySummary();
      summary.updated = selected;
      const finalItems = await classifyTargets(
        scopeId,
        actorId,
        selected.map((item) => ({
          item,
          draft: { title: item.title, body: item.body, kind: item.kind, column: item.column },
          candidatePool: items.filter((other) => other.id !== item.id),
        })),
        summary,
        signal,
      );
      summary.updated = replaceClassified(summary.updated, finalItems);
      return { ok: true, value: summary };
    },
  };
  return service;
}

export interface TpmBoardAccess {
  scopeId: ScopeId;
  classifierAvailable: boolean;
  board(): Promise<TpmBoardView>;
  ingest(inputs: readonly TpmItemInput[]): Promise<TpmResult<TpmIngestSummary>>;
  update(idOrRef: string, input: TpmUpdateInput): Promise<TpmResult<TpmIngestSummary>>;
  remove(idOrRef: string): Promise<TpmResult<TpmItem>>;
  link(input: { kind: TpmEdgeKind; from: string; to: string }): Promise<TpmResult<TpmEdge>>;
  decide(edgeId: string, accept: boolean): Promise<TpmResult<TpmEdge>>;
  setRubric(questions: unknown): Promise<TpmResult<TpmRubric>>;
  reclassify(idsOrRefs?: readonly string[]): Promise<TpmResult<TpmIngestSummary>>;
}

export function bindTpmBoard(
  service: TpmService,
  scopeId: ScopeId,
  actorId: string,
  once: <T>(produce: () => Promise<T>) => Promise<T>,
  signal?: AbortSignal,
): TpmBoardAccess {
  return {
    scopeId,
    classifierAvailable: service.classifierAvailable,
    board: () => service.board(scopeId),
    ingest: (inputs) => once(() => service.ingest(scopeId, actorId, inputs, signal)),
    update: (idOrRef, input) => once(() => service.update(scopeId, actorId, idOrRef, input, signal)),
    remove: (idOrRef) => once(() => service.remove(scopeId, actorId, idOrRef)),
    link: (input) => once(() => service.link(scopeId, actorId, input, "agent")),
    decide: (edgeId, accept) => once(() => service.decide(scopeId, actorId, edgeId, accept)),
    setRubric: (questions) => once(() => service.setRubric(scopeId, actorId, questions)),
    reclassify: (idsOrRefs) => once(() => service.reclassify(scopeId, actorId, idsOrRefs, signal)),
  };
}
