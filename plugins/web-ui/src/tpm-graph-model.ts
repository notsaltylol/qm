import dagre from "@dagrejs/dagre";
import { itemHandle, type TpmBoardWire, type TpmEdgeView, type TpmItemView } from "./tpm-types.ts";

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 76;

export interface FlowNodeData extends Record<string, unknown> {
  item: TpmItemView;
  handle: string;
  blocked: boolean;
  stale: boolean;
  dimmed: boolean;
  focused: boolean;
}

export interface FlowEdgeData extends Record<string, unknown> {
  edge: TpmEdgeView;
  dimmed: boolean;
}

export interface FlowNode {
  id: string;
  type: "tpm";
  position: { x: number; y: number };
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: "tpm";
  data: FlowEdgeData;
}

function walk(edges: readonly Pick<TpmEdgeView, "fromId" | "toId">[], start: string, forward: boolean): Set<string> {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length) {
    const current = pending.pop()!;
    for (const edge of edges) {
      const [from, to] = forward ? [edge.fromId, edge.toId] : [edge.toId, edge.fromId];
      if (from !== current || seen.has(to)) continue;
      seen.add(to);
      pending.push(to);
    }
  }
  return seen;
}

export function connectedIds(edges: readonly Pick<TpmEdgeView, "fromId" | "toId">[], start: string): Set<string> {
  return new Set([...walk(edges, start, true), ...walk(edges, start, false)]);
}

export function buildFlow(
  board: TpmBoardWire,
  opts: { hideDone: boolean; focusId: string | null },
): { nodes: FlowNode[]; edges: FlowEdge[]; hiddenCount: number } {
  const hiddenIds = new Set(
    opts.hideDone ? board.items.filter((item) => item.column === "done").map((item) => item.id) : [],
  );
  const edges = board.edges.filter(
    (edge) => edge.state !== "rejected" && !hiddenIds.has(edge.fromId) && !hiddenIds.has(edge.toId),
  );
  const linked = new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]));
  const items = board.items.filter((item) => linked.has(item.id));
  const focus = opts.focusId && linked.has(opts.focusId) ? connectedIds(edges, opts.focusId) : null;
  const blocked = new Set(board.insights.blocked.map((entry) => entry.id));
  const stale = new Set(board.insights.staleDocuments.map((entry) => entry.id));

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const item of items) graph.setNode(item.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) graph.setEdge(edge.fromId, edge.toId);
  dagre.layout(graph);

  return {
    nodes: items.map((item) => {
      const point = graph.node(item.id) as { x: number; y: number };
      return {
        id: item.id,
        type: "tpm",
        position: { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 },
        data: {
          item,
          handle: itemHandle(item),
          blocked: blocked.has(item.id),
          stale: stale.has(item.id),
          dimmed: focus !== null && !focus.has(item.id),
          focused: item.id === opts.focusId,
        },
      };
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.fromId,
      target: edge.toId,
      type: "tpm",
      data: { edge, dimmed: focus !== null && !(focus.has(edge.fromId) && focus.has(edge.toId)) },
    })),
    hiddenCount: board.items.length - hiddenIds.size - items.length,
  };
}
