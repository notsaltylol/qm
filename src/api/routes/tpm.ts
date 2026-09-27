import { isTpmColumn } from "../../tpm/tpm-store.ts";
import { DEFAULT_METRIC_WINDOW, METRIC_WINDOWS } from "../../tpm/tpm-metrics.ts";
import type { TpmResult } from "../../tpm/tpm-service.ts";
import type { ScopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

const ERROR_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;

function field(ctx: ApiCtx, name: string): string {
  if (ctx.method === "GET") return (ctx.url.searchParams.get(name) ?? "").trim();
  const body = isObj(ctx.body) ? ctx.body : {};
  return typeof body[name] === "string" ? (body[name] as string).trim() : "";
}

async function authorizedScope(ctx: ApiCtx): Promise<{ principalId: string; scope: ScopeId } | null> {
  const principalId = field(ctx, "principalId");
  const scope = field(ctx, "scope") as ScopeId;
  if (!ctx.deps.tpm) {
    sendJson(ctx.res, 503, { error: "tpm_unavailable" });
    return null;
  }
  if (!principalId || !scope) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "principalId and scope required" });
    return null;
  }
  if (
    !(await ctx.deps.featureFlags?.enabled("tpm_board", scope)) ||
    !(await ctx.app.belongsToScope(principalId, scope))
  ) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  return { principalId, scope };
}

function respond<T>(ctx: ApiCtx, result: TpmResult<T>, body: (value: T) => unknown): void {
  if (result.ok) return sendJson(ctx.res, 200, body(result.value));
  return sendJson(ctx.res, ERROR_STATUS[result.code], { error: result.code, message: result.message });
}

async function listBoards(ctx: ApiCtx): Promise<void> {
  const tpm = ctx.deps.tpm;
  if (!tpm) return sendJson(ctx.res, 503, { error: "tpm_unavailable" });
  const principalId = field(ctx, "principalId");
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  const boards = [];
  for (const board of await tpm.boards()) {
    if (!(await ctx.deps.featureFlags?.enabled("tpm_board", board.scopeId))) continue;
    if (await ctx.app.belongsToScope(principalId, board.scopeId)) boards.push(board);
  }
  return sendJson(ctx.res, 200, { boards, classifier: tpm.classifierAvailable });
}

async function getBoard(ctx: ApiCtx): Promise<void> {
  const access = await authorizedScope(ctx);
  if (!access) return;
  const requested = Number(ctx.url.searchParams.get("days"));
  const windowDays = (METRIC_WINDOWS as readonly number[]).includes(requested) ? requested : DEFAULT_METRIC_WINDOW;
  return sendJson(ctx.res, 200, { board: await ctx.deps.tpm!.board(access.scope, { windowDays }) });
}

async function moveItem(ctx: ApiCtx): Promise<void> {
  const access = await authorizedScope(ctx);
  if (!access) return;
  const column = field(ctx, "column");
  if (!isTpmColumn(column)) return sendJson(ctx.res, 400, { error: "bad_request", message: "valid column required" });
  const result = await ctx.deps.tpm!.update(access.scope, access.principalId, ctx.params.id!, { column });
  return respond(ctx, result, (summary) => ({ item: summary.updated[0] }));
}

async function decideEdge(ctx: ApiCtx): Promise<void> {
  const access = await authorizedScope(ctx);
  if (!access) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  if (typeof body.accept !== "boolean")
    return sendJson(ctx.res, 400, { error: "bad_request", message: "accept required" });
  const result = await ctx.deps.tpm!.decide(access.scope, access.principalId, ctx.params.id!, body.accept);
  return respond(ctx, result, (edge) => ({ edge }));
}

export const tpmRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/tpm/boards", auth: "source", handle: listBoards },
  { method: "GET", path: "/v1/tpm/board", auth: "source", handle: getBoard },
  { method: "PATCH", path: "/v1/tpm/items/:id", auth: "source", handle: moveItem },
  { method: "POST", path: "/v1/tpm/edges/:id/decide", auth: "source", handle: decideEdge },
];
