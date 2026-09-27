import { createElement as h, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  COVERAGE_LABEL,
  COVERAGE_ORDER,
  STATUS,
  agingRows,
  chartTheme,
  cycleRows,
  flowRows,
  formatDays,
  throughputRows,
  type ChartTheme,
} from "./tpm-chart-data.ts";
import { COLUMN_LABEL, TPM_COLUMNS, type TpmMetricsView } from "./tpm-types.ts";

export interface TpmChartsProps {
  metrics: TpmMetricsView;
  dark: boolean;
}

type Row = Record<string, unknown>;
type TooltipLine = { key: string; value: string; color: string };

function TooltipBox(props: { title: string; lines: TooltipLine[]; note?: string; theme: ChartTheme }) {
  return h(
    "div",
    { className: "tpm-tooltip" },
    h("div", { className: "tpm-tooltip-title" }, props.title),
    ...props.lines.map((line) =>
      h(
        "div",
        { className: "tpm-tooltip-row", key: line.key },
        h("i", { className: "tpm-tooltip-key", style: { background: line.color } }),
        h("strong", null, line.value),
        h("span", null, line.key),
      ),
    ),
    props.note ? h("div", { className: "tpm-tooltip-note" }, props.note) : null,
  );
}

type ChartCardProps = {
  title: string;
  subtitle: string;
  wide?: boolean;
  empty?: string | null;
  table: { head: string[]; rows: Array<Array<string | number>> };
  legend?: Array<{ label: string; color: string }>;
  children?: ReactNode;
};

function cardBody(props: ChartCardProps, asTable: boolean): ReactNode {
  if (props.empty) return h("div", { className: "tpm-chart-empty" }, props.empty);
  if (asTable) {
    return h(
      "div",
      { className: "tpm-chart-table" },
      h(
        "table",
        null,
        h("thead", null, h("tr", null, ...props.table.head.map((cell) => h("th", { key: cell }, cell)))),
        h(
          "tbody",
          null,
          ...props.table.rows.map((row, index) =>
            h("tr", { key: index }, ...row.map((cell, cellIndex) => h("td", { key: cellIndex }, String(cell)))),
          ),
        ),
      ),
    );
  }
  return h(
    "div",
    null,
    props.children,
    props.legend?.length
      ? h(
          "ul",
          { className: "tpm-chart-legend" },
          ...props.legend.map((entry) =>
            h("li", { key: entry.label }, h("i", { style: { background: entry.color } }), entry.label),
          ),
        )
      : null,
  );
}

function ChartCard(props: ChartCardProps) {
  const [asTable, setAsTable] = useState(false);
  return h(
    "section",
    { className: `tpm-chart-card${props.wide ? " wide" : ""}` },
    h(
      "header",
      null,
      h("div", null, h("h3", null, props.title), h("p", null, props.subtitle)),
      props.empty
        ? null
        : h(
            "button",
            {
              type: "button",
              className: "tpm-table-toggle",
              "aria-pressed": asTable,
              onClick: () => setAsTable(!asTable),
            },
            asTable ? "Chart" : "Table",
          ),
    ),
    cardBody(props, asTable),
  );
}

function frame(height: number, chart: ReactNode) {
  return h(ResponsiveContainer, { width: "100%", height, children: chart as ReactElement });
}

function axisProps(theme: ChartTheme) {
  return {
    stroke: theme.axis,
    tick: { fill: theme.muted, fontSize: 12 },
    tickLine: false,
  };
}

function FlowChart({ metrics, theme }: { metrics: TpmMetricsView; theme: ChartTheme }) {
  const rows = flowRows(metrics);
  const columns = [...TPM_COLUMNS].reverse();
  return h(
    ChartCard,
    {
      title: "Cumulative flow",
      subtitle: `Items in each column, day by day, last ${metrics.windowDays} days. A widening band is where work piles up.`,
      wide: true,
      legend: TPM_COLUMNS.map((column) => ({ label: COLUMN_LABEL[column], color: theme.columns[column] })),
      table: {
        head: ["Day", ...TPM_COLUMNS.map((column) => COLUMN_LABEL[column])],
        rows: rows.map((row) => [String(row.label), ...TPM_COLUMNS.map((column) => Number(row[column]))]),
      },
    },
    frame(
      300,
      h(
        AreaChart,
        { data: rows, margin: { top: 8, right: 16, bottom: 0, left: -8 } },
        h(CartesianGrid, { stroke: theme.grid, vertical: false }),
        h(XAxis, { dataKey: "label", ...axisProps(theme), minTickGap: 32 }),
        h(YAxis, { ...axisProps(theme), allowDecimals: false, axisLine: false }),
        h(Tooltip, {
          cursor: { stroke: theme.muted, strokeWidth: 1 },
          content: (tip: {
            active?: boolean;
            label?: string | number;
            payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown }>;
          }) =>
            tip.active && tip.payload?.length
              ? h(TooltipBox, {
                  theme,
                  title: String(tip.label),
                  lines: TPM_COLUMNS.map((column) => ({
                    key: COLUMN_LABEL[column],
                    value: String(tip.payload!.find((entry) => entry.dataKey === column)?.value ?? 0),
                    color: theme.columns[column],
                  })),
                })
              : null,
        }),
        ...columns.map((column) =>
          h(Area, {
            key: column,
            type: "monotone",
            dataKey: column,
            name: COLUMN_LABEL[column],
            stackId: "flow",
            stroke: theme.surface,
            strokeWidth: 2,
            fill: theme.columns[column],
            fillOpacity: 0.9,
            isAnimationActive: false,
          }),
        ),
      ),
    ),
  );
}

function ThroughputChart({ metrics, theme }: { metrics: TpmMetricsView; theme: ChartTheme }) {
  const rows = throughputRows(metrics);
  const total = rows.reduce((sum, row) => sum + row.done, 0);
  return h(
    ChartCard,
    {
      title: "Weekly throughput",
      subtitle: `Items moved to done each week · ${total} in the last ${metrics.windowDays} days`,
      table: { head: ["Week", "Done"], rows: rows.map((row) => [row.label, row.done]) },
    },
    frame(
      240,
      h(
        BarChart,
        { data: rows, margin: { top: 20, right: 12, bottom: 0, left: -16 } },
        h(CartesianGrid, { stroke: theme.grid, vertical: false }),
        h(XAxis, {
          dataKey: "label",
          ...axisProps(theme),
          tickFormatter: (value: string) => value.replace("Week of ", ""),
        }),
        h(YAxis, { ...axisProps(theme), allowDecimals: false, axisLine: false }),
        h(Tooltip, {
          cursor: { fill: theme.grid, opacity: 0.5 },
          content: (tip: {
            active?: boolean;
            label?: string | number;
            payload?: ReadonlyArray<{ value?: unknown }>;
          }) =>
            tip.active && tip.payload?.length
              ? h(TooltipBox, {
                  theme,
                  title: String(tip.label),
                  lines: [{ key: "done", value: String(tip.payload[0]!.value), color: theme.series[0]! }],
                })
              : null,
        }),
        h(
          Bar,
          { dataKey: "done", fill: theme.series[0], maxBarSize: 24, radius: [4, 4, 0, 0], isAnimationActive: false },
          h(LabelList, { dataKey: "done", position: "top", fill: theme.secondary, fontSize: 12 }),
        ),
      ),
    ),
  );
}

function CycleChart({ metrics, theme }: { metrics: TpmMetricsView; theme: ChartTheme }) {
  const rows = cycleRows(metrics);
  return h(
    ChartCard,
    {
      title: "Cycle time",
      subtitle: `From first started to done · median ${formatDays(metrics.kpis.medianCycleDays)} across ${metrics.cycleTimes.length} items`,
      empty: metrics.cycleTimes.length ? null : "No work went from started to done in this window yet.",
      table: {
        head: ["Item", "Cycle time", "Of which blocked"],
        rows: metrics.cycleTimes.map((entry) => [entry.title, formatDays(entry.days), formatDays(entry.blockedDays)]),
      },
    },
    frame(
      240,
      h(
        BarChart,
        { data: rows, margin: { top: 20, right: 12, bottom: 0, left: -16 } },
        h(CartesianGrid, { stroke: theme.grid, vertical: false }),
        h(XAxis, { dataKey: "label", ...axisProps(theme), interval: 0, fontSize: 11 }),
        h(YAxis, { ...axisProps(theme), allowDecimals: false, axisLine: false }),
        h(Tooltip, {
          cursor: { fill: theme.grid, opacity: 0.5 },
          content: (tip: { active?: boolean; label?: string | number; payload?: ReadonlyArray<{ payload?: Row }> }) => {
            const row = tip.payload?.[0]?.payload as { count: number; titles: string[] } | undefined;
            return tip.active && row
              ? h(TooltipBox, {
                  theme,
                  title: String(tip.label),
                  lines: [{ key: "items", value: String(row.count), color: theme.series[0]! }],
                  ...(row.titles.length
                    ? {
                        note:
                          row.titles.slice(0, 5).join(" · ") +
                          (row.titles.length > 5 ? ` · +${row.titles.length - 5}` : ""),
                      }
                    : {}),
                })
              : null;
          },
        }),
        h(
          Bar,
          { dataKey: "count", fill: theme.series[0], maxBarSize: 24, radius: [4, 4, 0, 0], isAnimationActive: false },
          h(LabelList, { dataKey: "count", position: "top", fill: theme.secondary, fontSize: 12 }),
        ),
      ),
    ),
  );
}

function barHeight(count: number): number {
  return Math.max(120, count * 34 + 48);
}

function AgingChart({ metrics, theme }: { metrics: TpmMetricsView; theme: ChartTheme }) {
  const rows = agingRows(metrics);
  return h(
    ChartCard,
    {
      title: "Aging work in progress",
      subtitle: "Days since each open item started, split into time blocked and time moving",
      wide: true,
      empty: rows.length ? null : "Nothing is in progress.",
      legend: [
        { label: "Moving", color: theme.series[0]! },
        { label: "Blocked", color: STATUS.critical },
      ],
      table: {
        head: ["Item", "Column", "Days since started", "Days blocked"],
        rows: rows.map((row) => [row.title, row.column, row.total, row.blocked]),
      },
    },
    frame(
      barHeight(rows.length),
      h(
        BarChart,
        { data: rows, layout: "vertical", margin: { top: 20, right: 48, bottom: 0, left: 8 }, barCategoryGap: 8 },
        h(CartesianGrid, { stroke: theme.grid, horizontal: false }),
        h(XAxis, { type: "number", ...axisProps(theme), unit: "d", allowDecimals: false }),
        h(YAxis, { type: "category", dataKey: "title", ...axisProps(theme), width: 220, axisLine: false }),
        h(ReferenceLine, {
          x: 14,
          stroke: theme.muted,
          label: { value: "2 weeks", position: "top", fill: theme.muted, fontSize: 11 },
        }),
        h(Tooltip, {
          cursor: { fill: theme.grid, opacity: 0.5 },
          content: (tip: { active?: boolean; payload?: ReadonlyArray<{ payload?: Row }> }) => {
            const row = tip.payload?.[0]?.payload as ReturnType<typeof agingRows>[number] | undefined;
            return tip.active && row
              ? h(TooltipBox, {
                  theme,
                  title: `${row.title} · ${row.column}`,
                  lines: [
                    { key: "moving", value: formatDays(row.working), color: theme.series[0]! },
                    { key: "blocked", value: formatDays(row.blocked), color: STATUS.critical },
                  ],
                })
              : null;
          },
        }),
        h(Bar, {
          dataKey: "workingBeforeBlock",
          stackId: "age",
          fill: theme.series[0],
          maxBarSize: 20,
          stroke: theme.surface,
          strokeWidth: 2,
          isAnimationActive: false,
        }),
        h(Bar, {
          dataKey: "workingToEnd",
          stackId: "age",
          fill: theme.series[0],
          maxBarSize: 20,
          radius: [0, 4, 4, 0],
          stroke: theme.surface,
          strokeWidth: 2,
          isAnimationActive: false,
        }),
        h(
          Bar,
          {
            dataKey: "blockedBar",
            name: "Blocked",
            stackId: "age",
            fill: STATUS.critical,
            maxBarSize: 20,
            radius: [0, 4, 4, 0],
            strokeWidth: 2,
            isAnimationActive: false,
          },
          ...rows.map((row) =>
            h(Cell, {
              key: row.title,
              fill: row.blocked ? STATUS.critical : "transparent",
              stroke: row.blocked ? theme.surface : "none",
            }),
          ),
          h(LabelList, {
            dataKey: "total",
            position: "right",
            fill: theme.secondary,
            fontSize: 12,
            formatter: (value: unknown) => formatDays(Number(value)),
          }),
        ),
      ),
    ),
  );
}

function CustomerChart({ metrics, theme }: { metrics: TpmMetricsView; theme: ChartTheme }) {
  const rows = metrics.customerIssues.map((entry) => ({ ...entry, label: COVERAGE_LABEL[entry.status] }));
  const statuses = COVERAGE_ORDER.filter((status) => rows.some((row) => row.status === status));
  return h(
    ChartCard,
    {
      title: "Customer issues",
      subtitle: "Days open, or days to resolve, colored by whether a fix is linked",
      empty: rows.length ? null : "No customer issues on this board.",
      legend: statuses.map((status) => ({ label: COVERAGE_LABEL[status], color: theme.coverage[status] })),
      table: {
        head: ["Issue", "Fix status", "Days"],
        rows: rows.map((row) => [row.title, row.label, row.days]),
      },
    },
    frame(
      barHeight(rows.length),
      h(
        BarChart,
        { data: rows, layout: "vertical", margin: { top: 8, right: 48, bottom: 0, left: 8 }, barCategoryGap: 8 },
        h(CartesianGrid, { stroke: theme.grid, horizontal: false }),
        h(XAxis, { type: "number", ...axisProps(theme), unit: "d", allowDecimals: false }),
        h(YAxis, { type: "category", dataKey: "title", ...axisProps(theme), width: 200, axisLine: false }),
        h(Tooltip, {
          cursor: { fill: theme.grid, opacity: 0.5 },
          content: (tip: { active?: boolean; payload?: ReadonlyArray<{ payload?: Row }> }) => {
            const row = tip.payload?.[0]?.payload as (typeof rows)[number] | undefined;
            return tip.active && row
              ? h(TooltipBox, {
                  theme,
                  title: row.title,
                  lines: [{ key: row.label, value: formatDays(row.days), color: theme.coverage[row.status] }],
                })
              : null;
          },
        }),
        h(
          Bar,
          { dataKey: "days", maxBarSize: 20, radius: [0, 4, 4, 0], isAnimationActive: false },
          ...rows.map((row) => h(Cell, { key: row.id, fill: theme.coverage[row.status] })),
          h(LabelList, {
            dataKey: "days",
            position: "right",
            fill: theme.secondary,
            fontSize: 12,
            formatter: (value: unknown) => formatDays(Number(value)),
          }),
        ),
      ),
    ),
  );
}

function DocsChart({ metrics, theme }: { metrics: TpmMetricsView; theme: ChartTheme }) {
  const { staleDocDays } = metrics;
  const rows = metrics.documents;
  return h(
    ChartCard,
    {
      title: "Document freshness",
      subtitle: `Days since each doc was last edited · stale after ${staleDocDays} days`,
      empty: rows.length ? null : "No documents on this board.",
      legend: [
        { label: "Current", color: theme.series[0]! },
        { label: "Stale", color: STATUS.warning },
      ],
      table: {
        head: ["Document", "Days since edit", "Stale"],
        rows: rows.map((row) => [row.title, row.ageDays, row.stale ? "Yes" : "No"]),
      },
    },
    frame(
      barHeight(rows.length),
      h(
        BarChart,
        { data: rows, layout: "vertical", margin: { top: 16, right: 48, bottom: 0, left: 8 }, barCategoryGap: 8 },
        h(CartesianGrid, { stroke: theme.grid, horizontal: false }),
        h(XAxis, { type: "number", ...axisProps(theme), unit: "d", allowDecimals: false }),
        h(YAxis, { type: "category", dataKey: "title", ...axisProps(theme), width: 200, axisLine: false }),
        h(ReferenceLine, {
          x: staleDocDays,
          stroke: theme.muted,
          label: { value: "stale", position: "top", fill: theme.muted, fontSize: 11 },
        }),
        h(Tooltip, {
          cursor: { fill: theme.grid, opacity: 0.5 },
          content: (tip: { active?: boolean; payload?: ReadonlyArray<{ payload?: Row }> }) => {
            const row = tip.payload?.[0]?.payload as (typeof rows)[number] | undefined;
            return tip.active && row
              ? h(TooltipBox, {
                  theme,
                  title: row.title,
                  lines: [
                    {
                      key: row.stale ? "since edit · stale" : "since edit",
                      value: formatDays(row.ageDays),
                      color: row.stale ? STATUS.warning : theme.series[0]!,
                    },
                  ],
                })
              : null;
          },
        }),
        h(
          Bar,
          { dataKey: "ageDays", maxBarSize: 20, radius: [0, 4, 4, 0], isAnimationActive: false },
          ...rows.map((row) => h(Cell, { key: row.id, fill: row.stale ? STATUS.warning : theme.series[0] })),
          h(LabelList, {
            dataKey: "ageDays",
            position: "right",
            fill: theme.secondary,
            fontSize: 12,
            formatter: (value: unknown) => formatDays(Number(value)),
          }),
        ),
      ),
    ),
  );
}

function TpmCharts(props: TpmChartsProps) {
  const theme = chartTheme(props.dark);
  const { metrics } = props;
  return h(
    "div",
    { className: "tpm-charts" },
    h(FlowChart, { metrics, theme }),
    h(ThroughputChart, { metrics, theme }),
    h(CycleChart, { metrics, theme }),
    h(AgingChart, { metrics, theme }),
    h(CustomerChart, { metrics, theme }),
    h(DocsChart, { metrics, theme }),
  );
}

export function mountTpmCharts(
  host: HTMLElement,
  props: TpmChartsProps,
): { update(next: TpmChartsProps): void; unmount(): void } {
  const root = createRoot(host);
  root.render(h(TpmCharts, props));
  return {
    update: (next) => root.render(h(TpmCharts, next)),
    unmount: () => root.unmount(),
  };
}
