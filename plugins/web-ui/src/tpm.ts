import "./tpm.css";
import { html, nothing, render, type TemplateResult } from "lit";
import { api } from "./core-bridge.ts";
import { errMessage } from "../../chassis/src/errors";
import { ensureContexts } from "./contexts.ts";
import { appState } from "./shell.ts";
import {
  COLUMN_LABEL,
  KIND_LABEL,
  itemHandle,
  TPM_COLUMNS,
  type ItemRef,
  type TpmBoardWire,
  type TpmColumn,
  type TpmInsightsView,
  type TpmItemView,
  type TpmTab,
  METRIC_WINDOWS,
} from "./tpm-types.ts";
import { fieldSelect } from "./ui.ts";
import type { TpmGraphProps } from "./tpm-graph.ts";
import type { TpmChartsProps } from "./tpm-charts.ts";
import { formatDays } from "./tpm-chart-data.ts";

const IMPACT_LABEL = ["No impact", "Workaround", "Degraded", "Blocked / revenue risk"];

const SCOPE_KEY = "qm.tpm.scope";
const WINDOW_LABEL: Record<(typeof METRIC_WINDOWS)[number], string> = { 14: "2 weeks", 42: "6 weeks", 84: "12 weeks" };

const state = {
  boards: [] as Array<{ scopeId: string; itemCount: number }>,
  names: new Map<string, string>(),
  scope: null as string | null,
  tab: "kanban" as TpmTab,
  board: null as TpmBoardWire | null,
  loading: false,
  error: "",
  busy: new Set<string>(),
  dropColumn: null as TpmColumn | null,
  hideDone: false,
  windowDays: 42 as (typeof METRIC_WINDOWS)[number],
};

let host: HTMLElement | null = null;
let boardRequest = 0;
let watching = false;

function rememberedScope(): string | null {
  try {
    return localStorage.getItem(SCOPE_KEY);
  } catch {
    return null;
  }
}

function rememberScope(scope: string): void {
  try {
    localStorage.setItem(SCOPE_KEY, scope);
  } catch {
    void 0;
  }
}

function scopeName(scope: string): string {
  return state.names.get(scope) ?? (scope.startsWith("personal:") ? "Personal" : scope);
}

async function loadBoard(days = state.windowDays): Promise<void> {
  if (!state.scope) return;
  const request = ++boardRequest;
  const result = await api<{ board: TpmBoardWire }>(
    `/api/tpm/board?scope=${encodeURIComponent(state.scope)}&days=${days}`,
  );
  if (request !== boardRequest) return;
  state.windowDays = days;
  state.board = result.board;
}

function watchPage(): void {
  if (watching || !appState.mainEl) return;
  watching = true;
  new MutationObserver(draw).observe(document.documentElement, { attributeFilter: ["class"] });
  new MutationObserver(syncIslands).observe(appState.mainEl, { childList: true });
}

export async function renderTpmPage(): Promise<void> {
  if (appState.currentView !== "tpm") return;
  watchPage();
  state.loading = true;
  state.error = "";
  draw();
  try {
    const [boards, contexts] = await Promise.all([
      api<{ boards: Array<{ scopeId: string; itemCount: number }> }>("/api/tpm/boards"),
      ensureContexts(),
    ]);
    state.boards = boards.boards;
    state.names = new Map(contexts.map((context) => [context.scopeId, context.name ?? scopeName(context.scopeId)]));
    const remembered = rememberedScope();
    const available = new Set(state.boards.map((board) => board.scopeId));
    state.scope =
      [state.scope, remembered].find((scope) => scope && available.has(scope)) ?? state.boards[0]?.scopeId ?? null;
    state.board = null;
    await loadBoard();
  } catch (error) {
    state.error = errMessage(error);
  } finally {
    state.loading = false;
  }
  draw();
}

async function selectScope(scope: string): Promise<void> {
  state.scope = scope;
  rememberScope(scope);
  state.board = null;
  state.loading = true;
  draw();
  try {
    await loadBoard();
  } catch (error) {
    state.error = errMessage(error);
  } finally {
    state.loading = false;
  }
  draw();
}

async function moveItem(itemId: string, column: TpmColumn): Promise<void> {
  const board = state.board;
  const item = board?.items.find((candidate) => candidate.id === itemId);
  if (!board || !item || item.column === column) return;
  const previous = item.column;
  item.column = column;
  state.busy.add(itemId);
  draw();
  try {
    await api(`/api/tpm/items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: JSON.stringify({ scope: board.scopeId, column }),
    });
    await loadBoard();
  } catch (error) {
    item.column = previous;
    state.error = `Couldn't move "${item.title}": ${errMessage(error)}`;
  } finally {
    state.busy.delete(itemId);
  }
  draw();
}

async function decideEdge(edgeId: string, accept: boolean): Promise<void> {
  const board = state.board;
  if (!board) return;
  state.busy.add(edgeId);
  draw();
  try {
    await api(`/api/tpm/edges/${encodeURIComponent(edgeId)}/decide`, {
      method: "POST",
      body: JSON.stringify({ scope: board.scopeId, accept }),
    });
    await loadBoard();
  } catch (error) {
    state.error = `Couldn't update the link: ${errMessage(error)}`;
  } finally {
    state.busy.delete(edgeId);
  }
  draw();
}

function openBlockerCount(board: TpmBoardWire, item: TpmItemView): number {
  const byId = new Map(board.items.map((candidate) => [candidate.id, candidate]));
  return board.edges.filter(
    (edge) =>
      edge.kind === "blocks" &&
      edge.state === "confirmed" &&
      edge.toId === item.id &&
      byId.get(edge.fromId)?.column !== "done",
  ).length;
}

function cardTpl(board: TpmBoardWire, item: TpmItemView, staleDocs: Set<string>): TemplateResult {
  const blockers = openBlockerCount(board, item);
  const impact = item.signals.customerImpact;
  const fixes = board.edges.filter(
    (edge) => edge.kind === "addresses" && edge.state === "confirmed" && edge.toId === item.id,
  ).length;
  return html`<article
    class="tpm-card"
    draggable="true"
    aria-busy=${state.busy.has(item.id) ? "true" : "false"}
    @dragstart=${(event: DragEvent) => event.dataTransfer?.setData("text/plain", item.id)}
  >
    <div class="tpm-card-title">${item.title}</div>
    <div class="tpm-card-meta">
      <span class="tpm-chip kind-${item.kind}">${KIND_LABEL[item.kind]}</span>
      <span>${itemHandle(item)}</span>
      ${item.assignee ? html`<span>@${item.assignee}</span>` : nothing}
    </div>
    <div class="tpm-card-meta">
      ${blockers ? html`<span class="tpm-chip alert">blocked by ${blockers}</span>` : nothing}
      ${
        impact && item.kind === "customer_issue"
          ? html`<span class="tpm-chip ${impact.score >= 2 ? "alert" : ""}"
              >${IMPACT_LABEL[Math.round(impact.score)] ?? ""}</span
            >`
          : nothing
      }
      ${
        item.kind === "customer_issue" && item.column !== "done"
          ? html`<span class="tpm-chip ${fixes ? "" : "alert"}"
              >${fixes ? `${fixes} fix${fixes === 1 ? "" : "es"} linked` : "no fix linked"}</span
            >`
          : nothing
      }
      ${staleDocs.has(item.id) ? html`<span class="tpm-chip alert">stale</span>` : nothing}
      ${item.signals.lowConfidence?.length ? html`<span class="tpm-chip">needs review</span>` : nothing}
    </div>
  </article>`;
}

function kanbanTpl(board: TpmBoardWire): TemplateResult {
  const staleDocs = new Set(board.insights.staleDocuments.map((doc) => doc.id));
  return html`<div class="tpm-kanban">
    ${TPM_COLUMNS.map((column) => {
      const items = board.items.filter((item) => item.column === column);
      return html`<section
        class="tpm-column ${state.dropColumn === column ? "drop-target" : ""}"
        aria-label=${COLUMN_LABEL[column]}
        @dragover=${(event: DragEvent) => {
          event.preventDefault();
          if (state.dropColumn !== column) {
            state.dropColumn = column;
            draw();
          }
        }}
        @dragleave=${() => {
          state.dropColumn = null;
          draw();
        }}
        @drop=${(event: DragEvent) => {
          event.preventDefault();
          state.dropColumn = null;
          const id = event.dataTransfer?.getData("text/plain");
          if (id) void moveItem(id, column);
          else draw();
        }}
      >
        <h2><span>${COLUMN_LABEL[column]}</span><span>${items.length}</span></h2>
        ${items.map((item) => cardTpl(board, item, staleDocs))}
      </section>`;
    })}
  </div>`;
}

function coverageNote(entry: TpmInsightsView["customerCoverage"][number], board: TpmBoardWire): string {
  if (entry.status === "unaddressed") return "No ticket addresses this yet.";
  if (entry.status === "fix_shipped")
    return `Fix shipped (${refs(entry.tickets, board)}). Confirm with the customer and close it.`;
  return `In flight: ${refs(entry.tickets, board)}`;
}

function graphTpl(): TemplateResult {
  return html`<div class="tpm-toolbar">
      <label class="tpm-toggle">
        <input
          type="checkbox"
          .checked=${state.hideDone}
          @change=${(event: Event) => {
            state.hideDone = (event.target as HTMLInputElement).checked;
            draw();
          }}
        />
        Hide done work
      </label>
      <div class="tpm-legend">
        <span><i class="key edge-blocks"></i>blocks</span>
        <span><i class="key edge-addresses"></i>fixes a customer issue</span>
        <span><i class="key edge-documents"></i>describes</span>
        <span><i class="key is-proposed"></i>proposed, confirm or reject on the link</span>
        <span>Click an item to trace what it blocks and what blocks it</span>
      </div>
    </div>
    <div class="tpm-flow-host"></div>`;
}

interface IslandView<P> {
  update(next: P): void;
  unmount(): void;
}

function reactIsland<P>(
  selector: string,
  label: string,
  load: () => Promise<(host: HTMLElement, props: P) => IslandView<P>>,
  propsFor: (board: TpmBoardWire) => P,
): () => void {
  let mounted: { host: HTMLElement; view: IslandView<P> } | null = null;
  let loading: Promise<(host: HTMLElement, props: P) => IslandView<P>> | null = null;
  return () => {
    const hostEl = (host?.isConnected && host.querySelector<HTMLElement>(selector)) || null;
    const board = state.board;
    if (mounted && (!hostEl || mounted.host !== hostEl || !board)) {
      mounted.view.unmount();
      mounted = null;
    }
    if (!hostEl || !board) return;
    if (mounted) return mounted.view.update(propsFor(board));
    loading ??= load();
    void loading
      .then((mount) => {
        const current = host?.querySelector<HTMLElement>(selector);
        if (current !== hostEl || !hostEl.isConnected || mounted || !state.board) return;
        mounted = { host: hostEl, view: mount(hostEl, propsFor(state.board)) };
      })
      .catch((error: unknown) => {
        loading = null;
        state.error = `Couldn't load the ${label}: ${errMessage(error)}`;
        draw();
      });
  };
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

const decide = (edgeId: string, accept: boolean): void => void decideEdge(edgeId, accept);

const syncGraph = reactIsland<TpmGraphProps>(
  ".tpm-flow-host",
  "dependency graph",
  () => import("./tpm-graph.ts").then((module) => module.mountTpmGraph),
  (board) => ({
    board,
    hideDone: state.hideDone,
    dark: isDark(),
    busy: new Set(state.busy),
    onDecide: decide,
  }),
);

const syncCharts = reactIsland<TpmChartsProps>(
  ".tpm-charts-host",
  "charts",
  () => import("./tpm-charts.ts").then((module) => module.mountTpmCharts),
  (board) => ({ metrics: board.metrics, dark: isDark() }),
);

function syncIslands(): void {
  syncGraph();
  syncCharts();
}

function refs(entries: ItemRef[], board: TpmBoardWire): string {
  const byId = new Map(board.items.map((item) => [item.id, item]));
  return entries
    .map((entry) => `${byId.get(entry.id) ? itemHandle(byId.get(entry.id)!) : ""} ${entry.title}`.trim())
    .join(", ");
}

function insightCard(title: string, rows: TemplateResult[], empty: string): TemplateResult {
  return html`<section class="tpm-insight">
    <h3>${title}</h3>
    ${
      rows.length
        ? html`<ul>
            ${rows}
          </ul>`
        : html`<div class="why">${empty}</div>`
    }
  </section>`;
}

function reviewTpl(board: TpmBoardWire): TemplateResult {
  const byId = new Map(board.items.map((item) => [item.id, item]));
  const proposed = board.edges.filter((edge) => edge.state === "proposed");
  return insightCard(
    `Proposed links (${proposed.length})`,
    proposed.map((edge) => {
      const from = byId.get(edge.fromId);
      const to = byId.get(edge.toId);
      const verb = { blocks: "blocks", addresses: "fixes", documents: "describes" }[edge.kind];
      return html`<li class="tpm-review-row">
        <span>${from?.title ?? "?"} <strong>${verb}</strong> ${to?.title ?? "?"}</span>
        <span class="why">${edge.confidence !== undefined ? `${Math.round(edge.confidence * 100)}%` : ""}</span>
        <button
          class="btn"
          type="button"
          ?disabled=${state.busy.has(edge.id)}
          @click=${() => void decideEdge(edge.id, true)}
        >
          Confirm
        </button>
        <button
          class="btn"
          type="button"
          ?disabled=${state.busy.has(edge.id)}
          @click=${() => void decideEdge(edge.id, false)}
        >
          Reject
        </button>
      </li>`;
    }),
    "Nothing to review. Links the classifier is unsure about show up here.",
  );
}

async function selectWindow(days: (typeof METRIC_WINDOWS)[number]): Promise<void> {
  if (days === state.windowDays) return;
  state.loading = true;
  draw();
  try {
    await loadBoard(days);
  } catch (error) {
    state.error = errMessage(error);
  } finally {
    state.loading = false;
    draw();
  }
}

function kpiTile(label: string, value: string, note: string, tone?: "critical" | "warning"): TemplateResult {
  return html`<div class="tpm-kpi ${tone ?? ""}">
    <div class="tpm-kpi-label">${label}</div>
    <div class="tpm-kpi-value">${value}</div>
    <div class="tpm-kpi-note">${note}</div>
  </div>`;
}

function trendNote(now: number, before: number): string {
  if (now === before) return `same as last week (${before})`;
  return `${now > before ? "up" : "down"} from ${before} last week`;
}

function performanceTpl(board: TpmBoardWire): TemplateResult {
  const kpis = board.metrics.kpis;
  return html`<div class="tpm-toolbar">
      <div class="tpm-segmented" role="group" aria-label="Time range">
        ${METRIC_WINDOWS.map(
          (days) =>
            html`<button
              type="button"
              aria-pressed=${state.windowDays === days ? "true" : "false"}
              ?disabled=${state.loading}
              @click=${() => void selectWindow(days)}
            >
              ${WINDOW_LABEL[days]}
            </button>`,
        )}
      </div>
    </div>
    <div class="tpm-kpis">
      ${kpiTile("Done this week", String(kpis.doneThisWeek), trendNote(kpis.doneThisWeek, kpis.donePreviousWeek))}
      ${kpiTile("Median cycle time", formatDays(kpis.medianCycleDays), "started to done, this range")}
      ${kpiTile("In progress", String(kpis.wip), "in progress, blocked, or in review")}
      ${kpiTile(
        "Blocked now",
        String(kpis.blockedNow),
        `${formatDays(kpis.blockedDaysInWindow)} lost to blocks this range`,
        kpis.blockedNow ? "critical" : undefined,
      )}
      ${kpiTile(
        "Customer issues without a fix",
        String(kpis.unaddressedCustomerIssues),
        `of ${kpis.openCustomerIssues} open`,
        kpis.unaddressedCustomerIssues ? "critical" : undefined,
      )}
      ${kpiTile(
        "Stale documents",
        String(kpis.staleDocuments),
        `not edited in ${board.metrics.staleDocDays} days`,
        kpis.staleDocuments ? "warning" : undefined,
      )}
    </div>
    <div class="tpm-charts-host"></div>`;
}

function insightsTpl(board: TpmBoardWire): TemplateResult {
  const insights = board.insights;
  return html`${performanceTpl(board)}
    <h2 class="tpm-section-title">Needs attention</h2>
    <div class="tpm-insights">
      ${reviewTpl(board)}
      ${insightCard(
        "Blocked",
        insights.blocked.map(
          (entry) =>
            html`<li>
              <strong>${entry.title}</strong> · ${entry.blockedDays}d
              <div class="why">
                ${entry.blockers.length ? `waiting on ${refs(entry.blockers, board)}` : "no blocker recorded"}
                ${
                  entry.rootBlockers.some((root) => !entry.blockers.some((blocker) => blocker.id === root.id))
                    ? html`<br />root cause: ${refs(entry.rootBlockers, board)}`
                    : nothing
                }
              </div>
            </li>`,
        ),
        "Nothing is blocked.",
      )}
      ${insightCard(
        "Customer issues",
        insights.customerCoverage.map(
          (entry) =>
            html`<li>
              <strong>${entry.title}</strong>
              ${entry.impact !== undefined ? html` · ${IMPACT_LABEL[Math.round(entry.impact)]}` : nothing}
              <div class="why">${coverageNote(entry, board)}</div>
            </li>`,
        ),
        "No open customer issues.",
      )}
      ${insightCard(
        "Bottlenecks",
        insights.bottlenecks.map(
          (entry) =>
            html`<li>
              <strong>${entry.title}</strong> <span class="why">holds up ${entry.downstreamOpen} open items</span>
            </li>`,
        ),
        "No single item is holding up several others.",
      )}
      ${insightCard(
        "Stale documents",
        insights.staleDocuments.map(
          (entry) =>
            html`<li>
              <strong>${entry.title}</strong> · updated ${entry.ageDays}d ago
              ${entry.behind.length ? html`<div class="why">Work moved since: ${refs(entry.behind, board)}</div>` : nothing}
            </li>`,
        ),
        "Docs are current with the work they describe.",
      )}
      ${insightCard(
        "Idle work",
        insights.staleWork.map(
          (entry) =>
            html`<li>
              <strong>${entry.title}</strong>
              <span class="why">${COLUMN_LABEL[entry.column]} for ${entry.idleDays}d</span>
            </li>`,
        ),
        "Nothing in progress has sat still for two weeks.",
      )}
      ${insightCard(
        "Says blocked, no blocker recorded",
        insights.unrecordedBlockers.map(
          (entry) =>
            html`<li>
              <strong>${entry.title}</strong> <span class="why">${Math.round(entry.probability * 100)}%</span>
            </li>`,
        ),
        "Every stated blocker is on the graph.",
      )}
      ${
        insights.cycles.length
          ? insightCard(
              "Dependency cycles",
              insights.cycles.map((cycle) => html`<li>${cycle.map((entry) => entry.title).join(" → ")}</li>`),
              "",
            )
          : nothing
      }
    </div>`;
}

function tabsTpl(): TemplateResult {
  const tab = (value: TpmTab, label: string) =>
    html`<button
      type="button"
      role="tab"
      aria-selected=${state.tab === value ? "true" : "false"}
      @click=${() => {
        state.tab = value;
        draw();
      }}
    >
      ${label}
    </button>`;
  return html`<div class="tpm-tabs" role="tablist">
    ${tab("kanban", "Board")}${tab("graph", "Dependencies")}${tab("insights", "Insights")}
  </div>`;
}

function summaryTpl(board: TpmBoardWire): TemplateResult {
  const insights = board.insights;
  const unaddressed = insights.customerCoverage.filter((entry) => entry.status === "unaddressed").length;
  return html`<div class="tpm-summary">
    ${board.items.length} items · ${insights.blocked.length} blocked · ${unaddressed} customer issues without a fix ·
    ${insights.staleDocuments.length} stale docs · ${insights.pendingReview} links to review ·
    ${board.classifier.available ? `classifier ${board.classifier.model ?? "on"}` : "classifier off"}
  </div>`;
}

const TAB_VIEW: Record<TpmTab, (board: TpmBoardWire) => TemplateResult> = {
  kanban: kanbanTpl,
  graph: () => graphTpl(),
  insights: insightsTpl,
};

function bodyTpl(board: TpmBoardWire | null): TemplateResult | typeof nothing {
  if (state.loading && !board) return html`<div class="tpm-empty">Loading…</div>`;
  if (!state.boards.length) {
    return html`<div class="tpm-empty">
      No TPM boards yet. In a project or channel with the TPM board enabled, ask QM to track your tickets, customer
      issues, and docs. It sorts them onto a board and maps what blocks what.
    </div>`;
  }
  return board ? TAB_VIEW[state.tab](board) : nothing;
}

function draw(): void {
  if (appState.currentView !== "tpm" || !appState.mainEl) return;
  if (!host || host.parentElement !== appState.mainEl) {
    host = document.createElement("div");
    host.className = "pane tpm-page";
    appState.mainEl.replaceChildren(host);
  }
  const board = state.board;
  const body = bodyTpl(board);
  render(
    html`<div class="list-page-head">
        <div>
          <h1 class="pane-title">TPM board</h1>
          <div class="pane-subtitle">Tickets, customer issues, and docs, with what blocks what</div>
        </div>
      </div>
      ${
        state.boards.length
          ? html`<div class="tpm-toolbar">
              ${fieldSelect({
                ariaLabel: "Board",
                value: state.scope ?? "",
                onChange: (value) => void selectScope(value),
                options: state.boards.map(
                  (entry) =>
                    html`<option value=${entry.scopeId} ?selected=${entry.scopeId === state.scope}>
                      ${scopeName(entry.scopeId)} (${entry.itemCount})
                    </option>`,
                ),
              })}
              ${tabsTpl()}
            </div>`
          : nothing
      }
      ${state.error ? html`<div class="action-notice">${state.error}</div>` : nothing}
      ${board ? summaryTpl(board) : nothing} ${body}`,
    host,
  );
  syncIslands();
}
