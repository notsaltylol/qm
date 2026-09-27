import type { TpmBoardView, TpmIngestSummary } from "./tpm-service.ts";
import { CUSTOMER_IMPACT_LEVELS } from "./tpm-classifier.ts";
import type { TpmInsights } from "./tpm-insights.ts";
import { TPM_COLUMNS, type TpmEdge, type TpmItem } from "./tpm-store.ts";

export const SHORT_ID_CHARS = 8;

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_CHARS);
}

export function itemHandle(item: Pick<TpmItem, "id" | "externalRef">): string {
  return item.externalRef ?? shortId(item.id);
}

function label(item: Pick<TpmItem, "id" | "externalRef" | "title" | "column">): string {
  return `[${itemHandle(item)}] ${item.title} (${item.column})`;
}

function edgeLine(edge: TpmEdge, byId: Map<string, TpmItem>): string {
  const from = byId.get(edge.fromId);
  const to = byId.get(edge.toId);
  const confidence = edge.confidence !== undefined ? ` p=${edge.confidence.toFixed(2)}` : "";
  return `link ${shortId(edge.id)}: [${from ? itemHandle(from) : "?"}] ${edge.kind} [${to ? itemHandle(to) : "?"}] (${edge.state}, ${edge.origin}${confidence})`;
}

export function formatIngest(summary: TpmIngestSummary, board: TpmBoardView): string {
  const byId = new Map(board.items.map((item) => [item.id, item]));
  const lines: string[] = [];
  if (summary.created.length)
    lines.push(
      `created ${summary.created.length}: ${summary.created.map((item) => `${label(item)} ${item.kind}`).join("; ")}`,
    );
  if (summary.updated.length)
    lines.push(
      `updated ${summary.updated.length}: ${summary.updated.map((item) => `${label(item)} ${item.kind}`).join("; ")}`,
    );
  if (summary.confirmedEdges.length) {
    lines.push(`links applied:\n${summary.confirmedEdges.map((edge) => `- ${edgeLine(edge, byId)}`).join("\n")}`);
  }
  if (summary.proposedEdges.length) {
    lines.push(
      `links proposed for review (confirm or reject with action=review):\n${summary.proposedEdges.map((edge) => `- ${edgeLine(edge, byId)}`).join("\n")}`,
    );
  }
  for (const low of summary.lowConfidence) {
    const item = byId.get(low.itemId);
    lines.push(
      `low confidence on ${item ? `[${itemHandle(item)}]` : low.itemId}: ${low.fields.join(", ")} — set these explicitly with action=update if you know them`,
    );
  }
  if (summary.classifier === "unavailable")
    lines.push("classifier: not configured; kinds, columns, and links were not inferred");
  if (summary.classifier === "failed")
    lines.push(`classifier: failed (${summary.failure ?? "unknown error"}); unclassified items keep their defaults`);
  if (summary.usage.questions) {
    lines.push(
      `classifier usage: ${summary.usage.questions} questions, ${summary.usage.inputTokens + summary.usage.outputTokens} Jev tokens`,
    );
  }
  return lines.join("\n") || "nothing changed";
}

export function formatBoard(board: TpmBoardView): string {
  if (!board.items.length) return "The board is empty. Add items with action=add.";
  const byId = new Map(board.items.map((item) => [item.id, item]));
  const lines: string[] = [];
  for (const column of TPM_COLUMNS) {
    const items = board.items.filter((item) => item.column === column);
    if (!items.length) continue;
    lines.push(`## ${column} (${items.length})`);
    for (const item of items)
      lines.push(`- [${itemHandle(item)}] ${item.title} · ${item.kind}${item.assignee ? ` · @${item.assignee}` : ""}`);
  }
  const confirmed = board.edges.filter((edge) => edge.state === "confirmed");
  if (confirmed.length)
    lines.push(`## links (${confirmed.length})`, ...confirmed.map((edge) => `- ${edgeLine(edge, byId)}`));
  const proposed = board.edges.filter((edge) => edge.state === "proposed");
  if (proposed.length)
    lines.push(`## awaiting review (${proposed.length})`, ...proposed.map((edge) => `- ${edgeLine(edge, byId)}`));
  return lines.join("\n");
}

export function formatItem(board: TpmBoardView, item: TpmItem): string {
  const byId = new Map(board.items.map((other) => [other.id, other]));
  const lines = [`${label(item)} · ${item.kind}${item.assignee ? ` · @${item.assignee}` : ""}`, `id: ${item.id}`];
  if (item.body) lines.push(item.body.length > 1_500 ? `${item.body.slice(0, 1_500)}…` : item.body);
  const signals = item.signals;
  if (signals.mentionsBlocker !== undefined) lines.push(`says it is blocked: p=${signals.mentionsBlocker.toFixed(2)}`);
  if (signals.customerImpact) {
    const level = CUSTOMER_IMPACT_LEVELS[Math.round(signals.customerImpact.score)] ?? "";
    lines.push(`customer impact: ${signals.customerImpact.score.toFixed(1)} (${level})`);
  }
  for (const [key, value] of Object.entries(signals.custom ?? {})) {
    const shown = typeof value.value === "number" ? value.value.toFixed(2) : value.value;
    lines.push(
      `${key}: ${shown}${value.confidence !== undefined ? ` (confidence ${value.confidence.toFixed(2)})` : ""}`,
    );
  }
  const related = board.edges.filter((edge) => edge.fromId === item.id || edge.toId === item.id);
  if (related.length) lines.push("links:", ...related.map((edge) => `- ${edgeLine(edge, byId)}`));
  return lines.join("\n");
}

const refs = (items: ReadonlyArray<{ id: string; title: string }>, byId: Map<string, TpmItem>): string =>
  items
    .map((entry) => `[${byId.get(entry.id) ? itemHandle(byId.get(entry.id)!) : shortId(entry.id)}] ${entry.title}`)
    .join(", ");

export function formatInsights(board: TpmBoardView): string {
  const insights: TpmInsights = board.insights;
  const byId = new Map(board.items.map((item) => [item.id, item]));
  const handle = (id: string): string => (byId.get(id) ? itemHandle(byId.get(id)!) : shortId(id));
  const lines: string[] = [
    `columns: ${TPM_COLUMNS.map((column) => `${column} ${insights.counts[column]}`).join(", ")}`,
  ];
  if (insights.blocked.length) {
    lines.push("## blocked");
    for (const entry of insights.blocked) {
      const blockers = entry.blockers.length ? ` by ${refs(entry.blockers, byId)}` : " (no blocker recorded)";
      const roots =
        entry.rootBlockers.length && entry.rootBlockers.some((root) => !entry.blockers.some((b) => b.id === root.id))
          ? `; root cause ${refs(entry.rootBlockers, byId)}`
          : "";
      lines.push(`- [${handle(entry.id)}] ${entry.title}: ${entry.blockedDays}d${blockers}${roots}`);
    }
  }
  if (insights.bottlenecks.length) {
    lines.push("## bottlenecks");
    for (const entry of insights.bottlenecks)
      lines.push(
        `- [${handle(entry.id)}] ${entry.title} (${entry.column}) holds up ${entry.downstreamOpen} open items`,
      );
  }
  if (insights.customerCoverage.length) {
    lines.push("## customer issues");
    for (const entry of insights.customerCoverage) {
      const impact = entry.impact !== undefined ? ` impact ${entry.impact.toFixed(1)}/3` : "";
      const tickets = entry.tickets.length ? `: ${refs(entry.tickets, byId)}` : "";
      lines.push(`- [${handle(entry.id)}] ${entry.title}${impact} — ${entry.status.replace("_", " ")}${tickets}`);
    }
  }
  if (insights.staleDocuments.length) {
    lines.push("## stale documents");
    for (const entry of insights.staleDocuments) {
      const behind = entry.behind.length ? `; work moved since: ${refs(entry.behind, byId)}` : "";
      lines.push(`- [${handle(entry.id)}] ${entry.title}: last updated ${entry.ageDays}d ago${behind}`);
    }
  }
  if (insights.staleWork.length) {
    lines.push("## idle work");
    for (const entry of insights.staleWork)
      lines.push(`- [${handle(entry.id)}] ${entry.title}: ${entry.column} for ${entry.idleDays}d`);
  }
  if (insights.unrecordedBlockers.length) {
    lines.push("## says blocked but no blocker recorded");
    for (const entry of insights.unrecordedBlockers)
      lines.push(`- [${handle(entry.id)}] ${entry.title} (p=${entry.probability.toFixed(2)})`);
  }
  if (insights.cycles.length) {
    lines.push("## dependency cycles");
    for (const cycle of insights.cycles) lines.push(`- ${cycle.map((entry) => `[${handle(entry.id)}]`).join(" → ")}`);
  }
  if (insights.pendingReview)
    lines.push(`${insights.pendingReview} proposed links await review (action=board lists them).`);
  return lines.join("\n");
}
