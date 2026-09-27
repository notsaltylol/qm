import "@xyflow/react/dist/style.css";
import { createElement as h, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { buildFlow, type FlowEdgeData, type FlowNodeData } from "./tpm-graph-model.ts";
import { COLUMN_LABEL, KIND_LABEL, type TpmBoardWire } from "./tpm-types.ts";

export interface TpmGraphProps {
  board: TpmBoardWire;
  hideDone: boolean;
  dark: boolean;
  busy: ReadonlySet<string>;
  onDecide: (edgeId: string, accept: boolean) => void;
}

type TpmNode = Node<FlowNodeData, "tpm">;
type TpmEdge = Edge<FlowEdgeData & { busy: boolean; onDecide: TpmGraphProps["onDecide"] }, "tpm">;

const EDGE_VERB = { blocks: "blocks", addresses: "fixes", documents: "describes" } as const;

function TpmNodeView({ data }: NodeProps<TpmNode>) {
  const { item } = data;
  const classes = [
    "tpm-flow-node",
    `kind-${item.kind}`,
    data.blocked ? "is-blocked" : "",
    item.column === "done" ? "is-done" : "",
    data.dimmed ? "is-dimmed" : "",
    data.focused ? "is-focused" : "",
  ].join(" ");
  return h(
    "div",
    { className: classes, title: item.title },
    h(Handle, { type: "target", position: Position.Left, isConnectable: false }),
    h(
      "div",
      { className: "tpm-flow-meta" },
      h("span", { className: `tpm-chip kind-${item.kind}` }, KIND_LABEL[item.kind]),
      h("span", null, data.handle),
      h("span", { className: "tpm-flow-column" }, COLUMN_LABEL[item.column]),
    ),
    h("div", { className: "tpm-flow-title" }, item.title),
    data.blocked || data.stale
      ? h(
          "div",
          { className: "tpm-flow-meta" },
          data.blocked ? h("span", { className: "tpm-chip alert" }, "Blocked") : null,
          data.stale ? h("span", { className: "tpm-chip alert" }, "Stale") : null,
        )
      : null,
    h(Handle, { type: "source", position: Position.Right, isConnectable: false }),
  );
}

function TpmEdgeView(props: EdgeProps<TpmEdge>) {
  const { edge, busy, onDecide } = props.data!;
  const [path, labelX, labelY] = getBezierPath(props);
  const proposed = edge.state === "proposed";
  const verb = EDGE_VERB[edge.kind];
  const className = [
    "tpm-flow-edge",
    `edge-${edge.kind}`,
    proposed ? "is-proposed" : "",
    props.data!.dimmed ? "is-dimmed" : "",
  ].join(" ");
  return h(
    "g",
    { className },
    h(BaseEdge, { id: props.id, path, ...(props.markerEnd ? { markerEnd: props.markerEnd } : {}) }),
    h(
      EdgeLabelRenderer,
      null,
      h(
        "div",
        {
          className: `tpm-flow-label nodrag nopan ${proposed ? "is-proposed" : ""} ${props.data!.dimmed ? "is-dimmed" : ""}`,
          style: { transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` },
        },
        h("span", null, proposed ? `${verb}?` : verb),
        proposed && edge.confidence !== undefined
          ? h("span", { className: "tpm-flow-p" }, `${Math.round(edge.confidence * 100)}%`)
          : null,
        proposed
          ? h(
              "button",
              {
                type: "button",
                "aria-label": `Confirm this ${verb} link`,
                disabled: busy,
                onClick: () => onDecide(edge.id, true),
              },
              "✓",
            )
          : null,
        proposed
          ? h(
              "button",
              {
                type: "button",
                "aria-label": `Reject this ${verb} link`,
                disabled: busy,
                onClick: () => onDecide(edge.id, false),
              },
              "✕",
            )
          : null,
      ),
    ),
  );
}

const NODE_TYPES = { tpm: TpmNodeView };
const EDGE_TYPES = { tpm: TpmEdgeView };

function TpmGraph(props: TpmGraphProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const flow = useMemo(
    () => buildFlow(props.board, { hideDone: props.hideDone, focusId }),
    [props.board, props.hideDone, focusId],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<TpmNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<TpmEdge>([]);
  const layoutKey = useRef("");

  useEffect(() => {
    const key = [...flow.nodes.map((node) => node.id), ...flow.edges.map((edge) => edge.id)].join(",");
    const keepPositions = key === layoutKey.current;
    layoutKey.current = key;
    setNodes((current) => {
      const moved = new Map(keepPositions ? current.map((node) => [node.id, node.position]) : []);
      return flow.nodes.map((node) => ({ ...node, position: moved.get(node.id) ?? node.position }));
    });
  }, [flow, setNodes]);

  useEffect(() => {
    setEdges(
      flow.edges.map((edge) => ({
        ...edge,
        data: { ...edge.data, busy: props.busy.has(edge.id), onDecide: props.onDecide },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      })),
    );
  }, [flow, props.busy, props.onDecide, setEdges]);

  if (!flow.nodes.length) {
    return h(
      "div",
      { className: "tpm-empty" },
      "No links yet. As QM adds items, the classifier connects blockers, fixes, and docs here.",
    );
  }
  return h(
    "div",
    { className: "tpm-flow-frame" },
    h(
      ReactFlow<TpmNode, TpmEdge>,
      {
        nodes,
        edges,
        nodeTypes: NODE_TYPES,
        edgeTypes: EDGE_TYPES,
        onNodesChange,
        onEdgesChange,
        onNodeClick: (_event, node) => setFocusId((current) => (current === node.id ? null : node.id)),
        onPaneClick: () => setFocusId(null),
        nodesConnectable: false,
        colorMode: props.dark ? "dark" : "light",
        fitView: true,
        fitViewOptions: { padding: 0.15 },
        minZoom: 0.2,
        proOptions: { hideAttribution: true },
      },
      h(Background, { gap: 20, size: 1 }),
      h(Controls, { showInteractive: false }),
      h(MiniMap<TpmNode>, {
        pannable: true,
        zoomable: true,
        nodeClassName: (node) => `tpm-minimap kind-${node.data.item.kind}`,
      }),
    ),
    flow.hiddenCount
      ? h("div", { className: "tpm-flow-hidden" }, `${flow.hiddenCount} items without links are not shown.`)
      : null,
  );
}

export function mountTpmGraph(
  host: HTMLElement,
  props: TpmGraphProps,
): { update(next: TpmGraphProps): void; unmount(): void } {
  const root = createRoot(host);
  root.render(h(TpmGraph, props));
  return {
    update: (next) => root.render(h(TpmGraph, next)),
    unmount: () => root.unmount(),
  };
}
