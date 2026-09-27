import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TPM_COLUMNS, TPM_EDGE_KINDS, TPM_KINDS, type TpmColumn, type TpmEdgeKind, type TpmKind } from "./tpm-store.ts";
import type { TpmBoardAccess, TpmItemInput, TpmResult, TpmUpdateInput } from "./tpm-service.ts";
import { formatBoard, formatIngest, formatInsights, formatItem, itemHandle, shortId } from "./tpm-format.ts";
import { MAX_INGEST_ITEMS } from "./tpm-service.ts";

type ToolText = { content: Array<{ type: "text"; text: string }>; details: Record<string, never> };

export interface TpmToolDeps {
  board(): TpmBoardAccess | null | undefined;
  recordCall(callId: string, payload: Record<string, unknown>): Promise<void>;
  recordResult(callId: string, summary: Record<string, unknown>, ret: ToolText, isError: boolean): Promise<ToolText>;
}

const ACTIONS = [
  "add",
  "update",
  "remove",
  "link",
  "review",
  "board",
  "item",
  "insights",
  "rubric",
  "reclassify",
] as const;

const literals = <T extends string>(values: readonly T[], description: string) =>
  Type.Union(
    values.map((value) => Type.Literal(value)),
    { description },
  );

const itemFields = {
  title: Type.String({
    description: "Short title as written in the source (ticket title, doc title, customer's subject line).",
  }),
  body: Type.Optional(
    Type.String({
      description:
        "The raw source text: ticket description and latest comments, the customer's words, or the doc's summary. Paste it as-is; do not summarize or classify it yourself.",
    }),
  ),
  kind: Type.Optional(
    literals(TPM_KINDS, "Only when the source states it outright. Leave unset and the classifier decides."),
  ),
  column: Type.Optional(
    literals(TPM_COLUMNS, "Only when the source has an explicit status field. Leave unset and the classifier decides."),
  ),
  ref: Type.Optional(
    Type.String({
      description:
        "Stable source identifier such as ENG-142, a Zendesk ticket number, or a doc URL. Re-adding the same ref updates the item.",
    }),
  ),
  assignee: Type.Optional(Type.String({ description: "Owner as named in the source." })),
  updated_at: Type.Optional(
    Type.String({ description: "ISO 8601 time the source was last edited. Always pass it for documents." }),
  ),
};

const text = (value: string): ToolText => ({ content: [{ type: "text", text: value }], details: {} });

function parseTime(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function toInput(raw: Record<string, unknown>): TpmItemInput | string {
  const updatedAt = parseTime(raw.updated_at as string | undefined);
  if (updatedAt === null) return `updated_at ${String(raw.updated_at)} is not an ISO 8601 time`;
  return {
    title: String(raw.title ?? ""),
    ...(typeof raw.body === "string" ? { body: raw.body } : {}),
    ...(typeof raw.kind === "string" ? { kind: raw.kind as TpmKind } : {}),
    ...(typeof raw.column === "string" ? { column: raw.column as TpmColumn } : {}),
    ...(typeof raw.ref === "string" && raw.ref.trim() ? { ref: raw.ref.trim() } : {}),
    ...(typeof raw.assignee === "string" && raw.assignee.trim() ? { assignee: raw.assignee.trim() } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export const TPM_TOOL_DESCRIPTION =
  "The TPM board for this conversation: a kanban of tickets, customer issues, documents, and milestones, plus the dependency graph between them. " +
  "A fast typed classifier (Jev) does the sorting so you spend no reasoning on it. Hand it raw source text and let it pick each item's kind and column, and find which items block which, which tickets address which customer issues, and which documents describe which work. " +
  "Workflow: pull the raw records from the source systems you can reach (issue tracker, support desk, docs, Slack). Pass them to action=add in batches of up to " +
  `${MAX_INGEST_ITEMS}. Include a stable ref and, for documents, updated_at. ` +
  "Links the classifier is sure of are applied. Uncertain ones come back as proposed; confirm or reject them with action=review, asking a person when the call isn't obvious. " +
  "Use action=insights for the TPM view: blocked work and its root causes, bottlenecks, customer issues with no fix or with a fix shipped, stale documents, idle work, and dependency cycles. " +
  "Use action=link only when a person tells you about a dependency. Use action=update when a status changes. Use action=rubric to add the team's own classifier questions, which are asked of every item on later adds. " +
  "Refer to items by their ref or the short id shown in brackets.";

export function createTpmTool(deps: TpmToolDeps): ToolDefinition {
  return defineTool({
    name: "tpm",
    label: "tpm",
    description: TPM_TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: literals(ACTIONS, "What to do on the board."),
      items: Type.Optional(
        Type.Array(Type.Object(itemFields), {
          description: `add only: up to ${MAX_INGEST_ITEMS} raw items to add or refresh.`,
        }),
      ),
      id: Type.Optional(Type.String({ description: "update/remove/item: the item's ref or short id." })),
      title: Type.Optional(Type.String({ description: "update only: new title." })),
      body: Type.Optional(
        Type.String({ description: "update only: new raw source text; the classifier re-reads it." }),
      ),
      kind: Type.Optional(literals(TPM_KINDS, "update only: correct the item's kind.")),
      column: Type.Optional(literals(TPM_COLUMNS, "update only: move the item to this column.")),
      ref: Type.Optional(Type.String({ description: "update only: set the stable source identifier." })),
      assignee: Type.Optional(Type.String({ description: "update only: new owner." })),
      updated_at: Type.Optional(Type.String({ description: "update only: ISO 8601 time the source was last edited." })),
      link_kind: Type.Optional(
        literals(
          TPM_EDGE_KINDS,
          "link only: blocks means `from` must finish before `to` can proceed; addresses means ticket `from` fixes customer issue `to`; documents means document `from` describes item `to`.",
        ),
      ),
      from: Type.Optional(Type.String({ description: "link only: source item ref or short id." })),
      to: Type.Optional(Type.String({ description: "link only: target item ref or short id." })),
      link: Type.Optional(Type.String({ description: "review only: the link's short id." })),
      accept: Type.Optional(
        Type.Boolean({ description: "review only: true confirms the link, false rejects it for good." }),
      ),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            key: Type.String({ description: "snake_case name for the answer." }),
            type: literals(
              ["noul", "choice", "score"] as const,
              "noul = probability a yes/no statement holds; choice = one option; score = position on ordered levels.",
            ),
            instructions: Type.String({
              description:
                "One narrow judgment about `item`, the item being classified. Name the exact condition. Do not ask for dates, counts, or arithmetic.",
            }),
            criteria: Type.Optional(
              Type.Union([Type.Record(Type.String(), Type.String()), Type.Array(Type.String())], {
                description: "choice: option -> description. score: ordered level descriptions, lowest first.",
              }),
            ),
            appliesTo: Type.Optional(Type.Array(literals(TPM_KINDS, "item kind"))),
          }),
          {
            description: "rubric only: the full replacement list of custom questions. Omit to read the current rubric.",
          },
        ),
      ),
      ids: Type.Optional(
        Type.Array(Type.String(), { description: "reclassify only: refs or short ids; omit for the whole board." }),
      ),
    }),
    async execute(callId, params) {
      const action = params.action;
      await deps.recordCall(callId, { tool: "tpm", action });
      const board = deps.board();
      const done = (summary: Record<string, unknown>, body: string, isError = false) =>
        deps.recordResult(callId, { tool: "tpm", action, ...summary }, text(body), isError);
      if (!board) return done({ unavailable: true }, "[the TPM board isn't available in this conversation]", true);
      const failed = <T>(result: TpmResult<T>): result is Extract<TpmResult<T>, { ok: false }> => !result.ok;
      const error = (result: { code: string; message: string }) =>
        done({ error: result.code }, `[error] ${result.message}`, true);
      switch (action) {
        case "add": {
          const raw = (params.items ?? []) as Array<Record<string, unknown>>;
          const inputs: TpmItemInput[] = [];
          for (const entry of raw) {
            const input = toInput(entry);
            if (typeof input === "string") return error({ code: "invalid", message: input });
            inputs.push(input);
          }
          const result = await board.ingest(inputs);
          if (failed(result)) return error(result);
          return done(
            {
              created: result.value.created.length,
              updated: result.value.updated.length,
              classifier: result.value.classifier,
            },
            formatIngest(result.value, await board.board()),
          );
        }
        case "update": {
          if (!params.id) return error({ code: "invalid", message: "update requires `id`" });
          const parsed = toInput({ ...params, title: params.title ?? "" });
          if (typeof parsed === "string") return error({ code: "invalid", message: parsed });
          const patch: TpmUpdateInput = {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(parsed.body !== undefined ? { body: parsed.body } : {}),
            ...(parsed.kind ? { kind: parsed.kind } : {}),
            ...(parsed.column ? { column: parsed.column } : {}),
            ...(parsed.ref ? { ref: parsed.ref } : {}),
            ...(parsed.assignee ? { assignee: parsed.assignee } : {}),
            ...(parsed.updatedAt !== undefined ? { updatedAt: parsed.updatedAt } : {}),
          };
          const result = await board.update(params.id, patch);
          if (failed(result)) return error(result);
          return done({ updated: 1 }, formatIngest(result.value, await board.board()));
        }
        case "remove": {
          if (!params.id) return error({ code: "invalid", message: "remove requires `id`" });
          const result = await board.remove(params.id);
          if (failed(result)) return error(result);
          return done({ removed: 1 }, `removed [${itemHandle(result.value)}] ${result.value.title} and its links`);
        }
        case "link": {
          if (!params.link_kind || !params.from || !params.to) {
            return error({ code: "invalid", message: "link requires `link_kind`, `from`, and `to`" });
          }
          const result = await board.link({ kind: params.link_kind as TpmEdgeKind, from: params.from, to: params.to });
          if (failed(result)) return error(result);
          return done(
            { linked: 1 },
            `linked ${params.from} ${params.link_kind} ${params.to} (link ${shortId(result.value.id)})`,
          );
        }
        case "review": {
          if (!params.link || params.accept === undefined) {
            return error({ code: "invalid", message: "review requires `link` and `accept`" });
          }
          const result = await board.decide(params.link, params.accept);
          if (failed(result)) return error(result);
          return done({ decided: result.value.state }, `link ${shortId(result.value.id)} is now ${result.value.state}`);
        }
        case "board":
          return done({}, formatBoard(await board.board()));
        case "item": {
          if (!params.id) return error({ code: "invalid", message: "item requires `id`" });
          const view = await board.board();
          const key = params.id.trim();
          const item =
            view.items.find((candidate) => candidate.id === key || candidate.externalRef === key) ??
            view.items.filter((candidate) => candidate.id.startsWith(key)).at(0);
          if (!item) return error({ code: "not_found", message: `no item ${key} on this board` });
          return done({}, formatItem(view, item));
        }
        case "insights":
          return done({}, formatInsights(await board.board()));
        case "rubric": {
          if (params.questions === undefined) {
            const view = await board.board();
            return done(
              {},
              view.rubric.length
                ? JSON.stringify(view.rubric, null, 1)
                : "No custom questions; the built-in TPM rubric applies.",
            );
          }
          const result = await board.setRubric(params.questions);
          if (failed(result)) return error(result);
          return done(
            { questions: result.value.questions.length },
            `rubric saved with ${result.value.questions.length} custom questions; run action=reclassify to apply them to existing items`,
          );
        }
        case "reclassify": {
          if (!board.classifierAvailable)
            return error({ code: "unavailable", message: "the classifier is not configured on this deployment" });
          const result = await board.reclassify(params.ids);
          if (failed(result)) return error(result);
          return done({ reclassified: result.value.updated.length }, formatIngest(result.value, await board.board()));
        }
      }
      return error({ code: "invalid", message: `unknown action ${String(action)}` });
    },
  });
}
