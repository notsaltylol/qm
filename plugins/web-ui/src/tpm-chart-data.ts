import { COLUMN_LABEL, TPM_COLUMNS, type CoverageStatus, type TpmColumn, type TpmMetricsView } from "./tpm-types.ts";

export const CYCLE_BUCKETS = [
  { label: "Under 1 day", max: 1 },
  { label: "1–3 days", max: 3 },
  { label: "3–7 days", max: 7 },
  { label: "1–2 weeks", max: 14 },
  { label: "Over 2 weeks", max: Infinity },
] as const;

export const COVERAGE_ORDER: CoverageStatus[] = ["unaddressed", "in_flight", "fix_shipped", "resolved"];

export const COVERAGE_LABEL: Record<CoverageStatus, string> = {
  unaddressed: "No fix linked",
  in_flight: "Fix in flight",
  fix_shipped: "Fix shipped, not closed",
  resolved: "Resolved",
};

const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"],
};

export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };

export interface ChartTheme {
  surface: string;
  ink: string;
  secondary: string;
  muted: string;
  grid: string;
  axis: string;
  series: string[];
  columns: Record<TpmColumn, string>;
  coverage: Record<CoverageStatus, string>;
}

export function chartTheme(dark: boolean): ChartTheme {
  const series = dark ? SERIES.dark : SERIES.light;
  return {
    surface: dark ? "#1a1a19" : "#fcfcfb",
    ink: dark ? "#ffffff" : "#0b0b0b",
    secondary: dark ? "#c3c2b7" : "#52514e",
    muted: "#898781",
    grid: dark ? "#2c2c2a" : "#e1e0d9",
    axis: dark ? "#383835" : "#c3c2b7",
    series,
    columns: Object.fromEntries(TPM_COLUMNS.map((column, index) => [column, series[index]!])) as Record<
      TpmColumn,
      string
    >,
    coverage: {
      unaddressed: STATUS.critical,
      in_flight: series[0]!,
      fix_shipped: STATUS.good,
      resolved: "#898781",
    },
  };
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function dayLabel(at: number): string {
  return DAY_FORMAT.format(new Date(at));
}

export function flowRows(metrics: TpmMetricsView): Array<Record<string, number | string>> {
  return metrics.flow.map((point) => ({
    label: dayLabel(point.at),
    ...Object.fromEntries(TPM_COLUMNS.map((column) => [column, point.counts[column]])),
  }));
}

export function throughputRows(metrics: TpmMetricsView): Array<{ label: string; done: number }> {
  return metrics.throughput.map((week) => ({ label: `Week of ${dayLabel(week.weekStart)}`, done: week.done }));
}

export function cycleRows(metrics: TpmMetricsView): Array<{ label: string; count: number; titles: string[] }> {
  const rows = CYCLE_BUCKETS.map((bucket) => ({ label: bucket.label, count: 0, titles: [] as string[] }));
  for (const entry of metrics.cycleTimes) {
    const index = CYCLE_BUCKETS.findIndex((bucket) => entry.days < bucket.max);
    rows[index]!.count += 1;
    rows[index]!.titles.push(entry.title);
  }
  return rows;
}

export function agingRows(metrics: TpmMetricsView): Array<{
  title: string;
  column: string;
  working: number;
  workingBeforeBlock: number;
  workingToEnd: number;
  blocked: number;
  blockedBar: number;
  total: number;
}> {
  return metrics.aging.map((entry) => {
    const blocked = Math.min(entry.blockedDays, entry.ageDays);
    const working = Math.max(0, Math.round((entry.ageDays - blocked) * 10) / 10);
    return {
      title: entry.title,
      column: COLUMN_LABEL[entry.column],
      working,
      workingBeforeBlock: blocked ? working : 0,
      workingToEnd: blocked ? 0 : working,
      blocked,
      blockedBar: blocked || 0.001,
      total: entry.ageDays,
    };
  });
}

export function formatDays(days: number | null): string {
  if (days === null) return "–";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days * 10) / 10}d`;
}
