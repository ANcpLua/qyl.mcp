/**
 * @file qyl MCP Dashboard — MCP App.
 *
 * Aggregate dashboard over the MCP spans that the qyl.mcp runner's passthrough emits
 * into the collector. Renders the pre-aggregated `McpDashboardStats` from
 * the `display_mcp_dashboard` tool result; the window selector and refresh
 * button re-fetch via the app-only `fetch_telemetry view:"mcp_stats"` tool.
 *
 * Charts are hand-rolled inline SVG (no libraries). Rendering is XSS-safe by
 * construction: all telemetry strings reach the DOM exclusively through
 * `textContent`; SVG attributes are built from numbers and constants only.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type {
  McpDashboardBucket as McpBucket,
  McpDashboardStats,
  McpDataMode as Mode,
  McpNameRequestCount as McpNameCount,
  McpToolStats as McpToolRow,
} from "@ancplua/qyl-api-schema/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../package.json";
import {
  DisplayMcpDashboardOutputSchema,
  FetchTelemetryOutputSchema,
} from "../src/contracts.ts";
import "./global.css";
import "./mcp-dashboard.css";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type SortKey = "name" | "requests" | "error_rate" | "avg_ms" | "p95_ms";

interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

const WINDOW_PRESETS = [1, 24, 168] as const;

const state = {
  mode: undefined as Mode | undefined,
  stats: undefined as McpDashboardStats | undefined,
  hours: 24,
  /** Monotonic token so a stale fetch can't clobber a newer one. */
  requestSeq: 0,
  toolsSort: { key: "requests", dir: -1 } as SortState,
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const mainEl = document.querySelector(".main") as HTMLElement;
const demoBadgeEl = document.getElementById("demo-badge")!;
const analyzedLabelEl = document.getElementById("analyzed-label")!;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const emptyRefreshBtn = document.getElementById("empty-refresh-btn") as HTMLButtonElement;
const retryBtn = document.getElementById("retry-btn") as HTMLButtonElement;
const bannerEl = document.getElementById("banner")!;
const truncationNoteEl = document.getElementById("truncation-note")!;
const loadingEl = document.getElementById("state-loading")!;
const loadingTextEl = document.getElementById("loading-text")!;
const emptyEl = document.getElementById("state-empty")!;
const errorEl = document.getElementById("state-error")!;
const errorMessageEl = document.getElementById("error-message")!;
const dashboardEl = document.getElementById("dashboard")!;
const trafficChartEl = document.getElementById("traffic-chart")!;
const trafficTipEl = document.getElementById("traffic-tip")!;
const byServerEl = document.getElementById("by-server")!;
const byTransportEl = document.getElementById("by-transport")!;
const mostUsedEl = document.getElementById("most-used")!;
const slowestEl = document.getElementById("slowest")!;
const mostFailingEl = document.getElementById("most-failing")!;
const toolsTableEl = document.getElementById("tools-table")!;
const windowButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".win-btn"),
);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** 640 → "640", 1236 → "1.24", 87.4 → "87.4", 234000 → "234". */
function sigFig(v: number): string {
  if (v >= 100) return String(Math.round(v));
  const s = v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.replace(/\.?0+$/, "");
}

/** 412 → "412", 1834 → "1.8K", 2400000 → "2.4M". */
function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return String(n);
  for (const [div, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const) {
    if (n >= div) {
      const v = n / div;
      const s = v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "");
      return `${s}${suffix}`;
    }
  }
  return String(n);
}

/** Milliseconds → "0.42 ms" / "87 ms" / "1.24 s". */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms >= 1000) return `${sigFig(ms / 1000)} s`;
  if (ms >= 1) return `${sigFig(ms)} ms`;
  return `${ms.toFixed(2)} ms`;
}

/** Fraction 0..1 → "0%" / "<0.1%" / "2.4%" / "12%". */
function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return "—";
  const pct = rate * 100;
  if (pct === 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(pct)}%`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Bucket-start ISO timestamp → axis/tooltip label scaled to the window. */
function formatBucketTime(iso: string, windowHours: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (windowHours <= 48) return hm;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/** Extract joined text content from a tool result (for error reporting). */
function toolErrorText(result: CallToolResult): string | undefined {
  const text = result.content
    ?.map((c) => ("text" in c ? c.text : ""))
    .filter(Boolean)
    .join(" ");
  return text || undefined;
}

function parseStatsPayload(result: CallToolResult): McpDashboardStats | null {
  const displayed = DisplayMcpDashboardOutputSchema.safeParse(result.structuredContent);
  if (displayed.success) return displayed.data.stats;

  const fetched = FetchTelemetryOutputSchema.safeParse(result.structuredContent);
  return fetched.success && fetched.data.stats !== undefined
    ? fetched.data.stats
    : null;
}

// ---------------------------------------------------------------------------
// View state helpers
// ---------------------------------------------------------------------------

type ViewName = "loading" | "empty" | "error" | "dashboard";

function showView(view: ViewName) {
  loadingEl.hidden = view !== "loading";
  emptyEl.hidden = view !== "empty";
  errorEl.hidden = view !== "error";
  dashboardEl.hidden = view !== "dashboard";
}

function showError(message: string) {
  errorMessageEl.textContent = message;
  showView("error");
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;

/** Transient, non-destructive error notice (keeps the dashboard visible). */
function showBanner(message: string) {
  bannerEl.textContent = message;
  bannerEl.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    bannerEl.hidden = true;
  }, 6000);
}

function renderHeader() {
  demoBadgeEl.hidden = state.mode !== "demo";
  const stats = state.stats;
  analyzedLabelEl.textContent = stats
    ? `analyzed ${stats.span_count_analyzed.toLocaleString()} span${stats.span_count_analyzed === 1 ? "" : "s"}`
    : "";
  truncationNoteEl.hidden = !stats?.truncated;
  for (const btn of windowButtons) {
    const active = Number(btn.dataset.hours) === state.hours;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

// ---------------------------------------------------------------------------
// Traffic chart (inline SVG: stacked ok/error columns + error-rate line)
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  cls?: string,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (cls) el.setAttribute("class", cls);
  return el;
}

/** Smallest 1/2/5×10^k ≥ v (clean axis maxima). */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return f * exp;
}

/** Column with a rounded data-end (top) and a square baseline (bottom). */
function roundedTopColumn(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const x2 = x + w;
  return (
    `M${x.toFixed(2)},${(y + h).toFixed(2)}` +
    ` L${x.toFixed(2)},${(y + r).toFixed(2)}` +
    ` Q${x.toFixed(2)},${y.toFixed(2)} ${(x + r).toFixed(2)},${y.toFixed(2)}` +
    ` L${(x2 - r).toFixed(2)},${y.toFixed(2)}` +
    ` Q${x2.toFixed(2)},${y.toFixed(2)} ${x2.toFixed(2)},${(y + r).toFixed(2)}` +
    ` L${x2.toFixed(2)},${(y + h).toFixed(2)} Z`
  );
}

function windowHoursOf(stats: McpDashboardStats): number {
  const start = new Date(stats.window.start).getTime();
  const end = new Date(stats.window.end).getTime();
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return (end - start) / 3.6e6;
  }
  return state.hours;
}

function bucketRate(b: McpBucket): number {
  return b.requests > 0 ? b.errors / b.requests : 0;
}

function hideTrafficTip() {
  trafficTipEl.hidden = true;
}

function showTrafficTip(bucket: McpBucket, windowHours: number, clientX: number, clientY: number) {
  const title = document.createElement("div");
  title.className = "tip-title";
  title.textContent = formatBucketTime(bucket.start, windowHours);

  const rows = document.createDocumentFragment();
  const addRow = (keyCls: string | undefined, value: string, label: string) => {
    const row = document.createElement("div");
    row.className = "tip-row";
    const key = document.createElement("span");
    key.className = keyCls ? `tip-key ${keyCls}` : "tip-key";
    row.appendChild(key);
    const valueEl = document.createElement("span");
    valueEl.className = "tip-value";
    valueEl.textContent = value;
    row.appendChild(valueEl);
    const labelEl = document.createElement("span");
    labelEl.className = "tip-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);
    rows.appendChild(row);
  };
  addRow("ok", formatCompact(Math.max(0, bucket.requests - bucket.errors)), "ok");
  addRow("err", formatCompact(bucket.errors), "errors");
  addRow("err", formatRate(bucketRate(bucket)), "error rate");

  trafficTipEl.replaceChildren(title, rows);
  trafficTipEl.hidden = false;

  const wrapRect = trafficTipEl.parentElement!.getBoundingClientRect();
  const tipW = trafficTipEl.offsetWidth;
  const tipH = trafficTipEl.offsetHeight;
  let left = clientX - wrapRect.left + 12;
  if (left + tipW > wrapRect.width - 4) left = clientX - wrapRect.left - tipW - 12;
  let top = clientY - wrapRect.top - tipH - 8;
  if (top < 0) top = clientY - wrapRect.top + 12;
  trafficTipEl.style.left = `${Math.max(0, left)}px`;
  trafficTipEl.style.top = `${Math.max(0, top)}px`;
}

function renderTrafficChart() {
  const stats = state.stats;
  hideTrafficTip();
  trafficChartEl.replaceChildren();
  if (!stats || stats.buckets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = "No traffic in this window.";
    trafficChartEl.appendChild(empty);
    return;
  }

  const buckets = stats.buckets;
  const windowHours = windowHoursOf(stats);
  const width = Math.max(300, Math.floor(trafficChartEl.clientWidth) || 560);
  const height = 200;
  const padTop = 8;
  const padRight = 44;
  const padBottom = 20;
  const padLeft = 38;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const n = buckets.length;
  const slot = plotW / n;
  const barW = Math.min(24, Math.max(2, slot - 2));

  const yMax = niceCeil(Math.max(...buckets.map((b) => b.requests)));
  const maxRatePct = Math.max(...buckets.map((b) => bucketRate(b) * 100));
  const rMax = Math.min(100, niceCeil(Math.max(maxRatePct, 1)));

  const svg = svgEl("svg", {
    width: String(width),
    height: String(height),
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
  });
  svg.setAttribute(
    "aria-label",
    `MCP traffic: ${stats.totals.requests} requests, ${stats.totals.errors} errors (${formatRate(stats.totals.error_rate)}) across ${n} buckets`,
  );

  const yBase = padTop + plotH;

  // Gridlines + left axis ticks (request counts), solid hairlines.
  for (const frac of [0.5, 1]) {
    const y = yBase - plotH * frac;
    svg.appendChild(
      svgEl(
        "line",
        { x1: String(padLeft), y1: y.toFixed(2), x2: String(padLeft + plotW), y2: y.toFixed(2) },
        "grid-line",
      ),
    );
    const label = svgEl(
      "text",
      { x: String(padLeft - 5), y: (y + 3).toFixed(2), "text-anchor": "end" },
      "tick-label",
    );
    label.textContent = formatCompact(yMax * frac);
    svg.appendChild(label);
  }

  // Baseline.
  svg.appendChild(
    svgEl(
      "line",
      { x1: String(padLeft), y1: String(yBase), x2: String(padLeft + plotW), y2: String(yBase) },
      "axis-line",
    ),
  );

  // Right axis (error-rate %) — 0 at baseline, rMax at top.
  const rateTickTop = svgEl(
    "text",
    { x: String(padLeft + plotW + 5), y: String(padTop + 3), "text-anchor": "start" },
    "tick-label rate",
  );
  rateTickTop.textContent = `${rMax}%`;
  svg.appendChild(rateTickTop);
  const rateTickZero = svgEl(
    "text",
    { x: String(padLeft + plotW + 5), y: String(yBase + 3), "text-anchor": "start" },
    "tick-label rate",
  );
  rateTickZero.textContent = "0%";
  svg.appendChild(rateTickZero);

  // Stacked columns: ok grows from the baseline, errors ride on top with a
  // 2px surface gap; the topmost segment carries the rounded data-end.
  const barsGroup = svgEl("g");
  for (let i = 0; i < n; i++) {
    const b = buckets[i]!;
    const ok = Math.max(0, b.requests - b.errors);
    const errors = Math.min(b.errors, b.requests);
    if (ok <= 0 && errors <= 0) continue;
    const x = padLeft + i * slot + (slot - barW) / 2;
    const okH = ok > 0 ? Math.max((ok / yMax) * plotH, 1.5) : 0;
    const errH = errors > 0 ? Math.max((errors / yMax) * plotH, 1.5) : 0;

    if (ok > 0 && errors > 0) {
      barsGroup.appendChild(
        svgEl(
          "rect",
          {
            x: x.toFixed(2),
            y: (yBase - okH).toFixed(2),
            width: barW.toFixed(2),
            height: okH.toFixed(2),
          },
          "bar-ok",
        ),
      );
      barsGroup.appendChild(
        svgEl("path", { d: roundedTopColumn(x, yBase - okH - 2 - errH, barW, errH) }, "bar-err"),
      );
    } else if (ok > 0) {
      barsGroup.appendChild(
        svgEl("path", { d: roundedTopColumn(x, yBase - okH, barW, okH) }, "bar-ok"),
      );
    } else {
      barsGroup.appendChild(
        svgEl("path", { d: roundedTopColumn(x, yBase - errH, barW, errH) }, "bar-err"),
      );
    }
  }
  svg.appendChild(barsGroup);

  // Error-rate line over bucket centers (right-axis scale), 2px round.
  const points = buckets.map((b, i) => {
    const cx = padLeft + i * slot + slot / 2;
    const cy = yBase - (Math.min(bucketRate(b) * 100, rMax) / rMax) * plotH;
    return `${cx.toFixed(2)},${cy.toFixed(2)}`;
  });
  if (points.length > 1) {
    svg.appendChild(svgEl("path", { d: `M${points.join(" L")}` }, "traffic-rate-line"));
  }
  // End-dot marker with a surface ring so it stays legible over columns.
  const lastPoint = points[points.length - 1]!.split(",");
  svg.appendChild(
    svgEl("circle", { cx: lastPoint[0]!, cy: lastPoint[1]!, r: "4" }, "rate-dot"),
  );

  // X axis time labels: first, middle, last bucket.
  const tickIdx = n >= 3 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
  const anchors = ["start", "middle", "end"];
  tickIdx.forEach((idx, k) => {
    const anchor = tickIdx.length === 2 ? (k === 0 ? "start" : "end") : anchors[k]!;
    const x =
      anchor === "start"
        ? padLeft
        : anchor === "end"
          ? padLeft + plotW
          : padLeft + idx * slot + slot / 2;
    const label = svgEl(
      "text",
      { x: x.toFixed(2), y: String(height - 6), "text-anchor": anchor },
      "tick-label",
    );
    label.textContent = formatBucketTime(buckets[idx]!.start, windowHours);
    svg.appendChild(label);
  });

  // Hover/focus layer: one full-height hit rect per bucket (bigger than the
  // marks), driving the tooltip; values also live in the totals + tables.
  for (let i = 0; i < n; i++) {
    const b = buckets[i]!;
    const hit = svgEl(
      "rect",
      {
        x: (padLeft + i * slot).toFixed(2),
        y: String(padTop),
        width: slot.toFixed(2),
        height: String(plotH),
        tabindex: "0",
      },
      "traffic-hit",
    );
    hit.setAttribute(
      "aria-label",
      `${formatBucketTime(b.start, windowHours)}: ${Math.max(0, b.requests - b.errors)} ok, ${b.errors} errors, ${formatRate(bucketRate(b))} error rate`,
    );
    hit.addEventListener("pointermove", (e) => showTrafficTip(b, windowHours, e.clientX, e.clientY));
    hit.addEventListener("pointerleave", hideTrafficTip);
    hit.addEventListener("focus", () => {
      const rect = hit.getBoundingClientRect();
      showTrafficTip(b, windowHours, rect.left + rect.width / 2, rect.top + 20);
    });
    hit.addEventListener("blur", hideTrafficTip);
    svg.appendChild(hit);
  }

  trafficChartEl.appendChild(svg);
}

// Re-render the SVG when the card resizes (host width changes).
let lastChartWidth = 0;
const chartResizeObserver = new ResizeObserver(() => {
  const w = trafficChartEl.clientWidth;
  if (Math.abs(w - lastChartWidth) > 8 && state.stats && !dashboardEl.hidden) {
    lastChartWidth = w;
    renderTrafficChart();
  }
});
chartResizeObserver.observe(trafficChartEl);

// ---------------------------------------------------------------------------
// Ranked bar lists
// ---------------------------------------------------------------------------

interface BarListItem {
  name: string;
  value: number;
  label: string;
  title?: string;
}

function renderBarList(
  container: HTMLElement,
  items: BarListItem[],
  fillClass: string,
  emptyText: string,
) {
  container.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "bl-empty";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "bl-row";
    row.title = item.title ?? item.name;

    const name = document.createElement("span");
    name.className = "bl-name";
    name.textContent = item.name;
    row.appendChild(name);

    const track = document.createElement("div");
    track.className = "bl-track";
    const fill = document.createElement("div");
    fill.className = `bl-fill ${fillClass}`;
    const pct = (item.value / max) * 100;
    fill.style.width = `${Math.max(pct, item.value > 0 ? 1.5 : 0).toFixed(2)}%`;
    track.appendChild(fill);
    row.appendChild(track);

    const value = document.createElement("span");
    value.className = "bl-value";
    value.textContent = item.label;
    row.appendChild(value);

    fragment.appendChild(row);
  }
  container.replaceChildren(fragment);
}

const RANK_LIMIT = 6;

function renderRankedWidgets(stats: McpDashboardStats) {
  const byRequests = (a: McpNameCount, b: McpNameCount) => b.requests - a.requests;

  renderBarList(
    byServerEl,
    [...stats.by_server]
      .sort(byRequests)
      .slice(0, RANK_LIMIT)
      .map((s) => ({ name: s.name, value: s.requests, label: formatCompact(s.requests) })),
    "fill-ok",
    "No server data.",
  );

  renderBarList(
    byTransportEl,
    [...stats.by_transport]
      .sort(byRequests)
      .slice(0, RANK_LIMIT)
      .map((t) => ({ name: t.name, value: t.requests, label: formatCompact(t.requests) })),
    "fill-ok",
    "No transport data.",
  );

  renderBarList(
    mostUsedEl,
    [...stats.tools]
      .sort((a, b) => b.requests - a.requests)
      .slice(0, RANK_LIMIT)
      .map((t) => ({ name: t.name, value: t.requests, label: formatCompact(t.requests) })),
    "fill-ok",
    "No tool calls in this window.",
  );

  renderBarList(
    slowestEl,
    [...stats.tools]
      .sort((a, b) => b.p95_ms - a.p95_ms)
      .slice(0, RANK_LIMIT)
      .map((t) => ({
        name: t.name,
        value: t.p95_ms,
        label: formatMs(t.p95_ms),
        title: `${t.name} — p95 ${formatMs(t.p95_ms)}, avg ${formatMs(t.avg_ms)}`,
      })),
    "fill-p95",
    "No tool calls in this window.",
  );

  renderBarList(
    mostFailingEl,
    [...stats.tools]
      .filter((t) => t.requests >= 5 && t.error_rate > 0)
      .sort((a, b) => b.error_rate - a.error_rate)
      .slice(0, RANK_LIMIT)
      .map((t) => ({
        name: t.name,
        value: t.error_rate,
        label: formatRate(t.error_rate),
        title: `${t.name} — ${t.errors} of ${t.requests} requests failed`,
      })),
    "fill-err",
    "No failing tools (≥5 requests).",
  );
}

// ---------------------------------------------------------------------------
// Detail tables (sortable)
// ---------------------------------------------------------------------------

const TABLE_COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "name", label: "Name", numeric: false },
  { key: "requests", label: "Requests", numeric: true },
  { key: "error_rate", label: "Error rate", numeric: true },
  { key: "avg_ms", label: "Avg", numeric: true },
  { key: "p95_ms", label: "P95", numeric: true },
];

function sortRows(rows: McpToolRow[], sort: SortState): McpToolRow[] {
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (sort.key === "name") {
      cmp = a.name.localeCompare(b.name);
    } else {
      cmp = a[sort.key] - b[sort.key];
    }
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return cmp * sort.dir;
  });
}

function renderTable(
  container: HTMLElement,
  rows: McpToolRow[],
  sort: SortState,
  onSort: (key: SortKey) => void,
  emptyText: string,
) {
  container.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "table-empty";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "data-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of TABLE_COLUMNS) {
    const th = document.createElement("th");
    th.scope = "col";
    if (col.numeric) th.classList.add("num");
    const active = sort.key === col.key;
    if (active) th.setAttribute("aria-sort", sort.dir === 1 ? "ascending" : "descending");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `th-btn${active ? " sorted" : ""}`;
    const label = document.createElement("span");
    label.textContent = col.label;
    btn.appendChild(label);
    const indicator = document.createElement("span");
    indicator.className = "sort-indicator";
    indicator.textContent = active ? (sort.dir === 1 ? "▲" : "▼") : "";
    btn.appendChild(indicator);
    btn.addEventListener("click", () => onSort(col.key));
    th.appendChild(btn);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of sortRows(rows, sort)) {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.className = "name-cell";
    nameTd.textContent = row.name;
    nameTd.title = row.name;
    tr.appendChild(nameTd);

    const requestsTd = document.createElement("td");
    requestsTd.className = "num";
    requestsTd.textContent = formatCompact(row.requests);
    tr.appendChild(requestsTd);

    const rateTd = document.createElement("td");
    rateTd.className = `num err-cell${row.error_rate > 0.01 ? " err-hot" : ""}`;
    rateTd.textContent = formatRate(row.error_rate);
    tr.appendChild(rateTd);

    const avgTd = document.createElement("td");
    avgTd.className = "num";
    avgTd.textContent = formatMs(row.avg_ms);
    tr.appendChild(avgTd);

    const p95Td = document.createElement("td");
    p95Td.className = "num";
    p95Td.textContent = formatMs(row.p95_ms);
    tr.appendChild(p95Td);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) {
    return { key, dir: current.dir === 1 ? -1 : 1 };
  }
  return { key, dir: key === "name" ? 1 : -1 };
}

function renderToolsTable() {
  renderTable(
    toolsTableEl,
    state.stats?.tools ?? [],
    state.toolsSort,
    (key) => {
      state.toolsSort = nextSort(state.toolsSort, key);
      renderToolsTable();
    },
    "No tool calls in this window.",
  );
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------

function applyStats(stats: McpDashboardStats) {
  state.stats = stats;
  state.mode = stats.mode;
  renderHeader();
  if (stats.span_count_analyzed === 0) {
    showView("empty");
    return;
  }
  showView("dashboard");
  renderTrafficChart();
  renderRankedWidgets(stats);
  renderToolsTable();
}

// ---------------------------------------------------------------------------
// Fetch (app-only fetch_telemetry view:"mcp_stats")
// ---------------------------------------------------------------------------

async function fetchStats() {
  const seq = ++state.requestSeq;
  refreshBtn.disabled = true;
  refreshBtn.classList.add("spinning");
  const hadStats = Boolean(state.stats);
  if (hadStats) {
    // Refetch keeps the frame: hold the previous render at reduced opacity.
    dashboardEl.classList.add("refreshing");
  } else {
    loadingTextEl.textContent = "Loading MCP stats…";
    showView("loading");
  }
  try {
    const result = await app.callServerTool({
      name: "fetch_telemetry",
      arguments: { view: "mcp_stats", hours: state.hours },
    });
    if (seq !== state.requestSeq) return;
    if (result.isError) {
      throw new Error(toolErrorText(result) ?? "fetch_telemetry failed");
    }
    const stats = parseStatsPayload(result);
    if (!stats) {
      throw new Error("fetch_telemetry returned an invalid stats payload");
    }
    applyStats(stats);
  } catch (err) {
    if (seq !== state.requestSeq) return;
    if (hadStats) {
      showView("dashboard");
      showBanner(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } else {
      showError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    if (seq === state.requestSeq) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("spinning");
      dashboardEl.classList.remove("refreshing");
    }
  }
}

function setWindow(hours: number) {
  if (state.hours === hours) return;
  state.hours = hours;
  renderHeader();
  void fetchStats();
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

for (const btn of windowButtons) {
  btn.addEventListener("click", () => {
    const hours = Number(btn.dataset.hours);
    if (WINDOW_PRESETS.includes(hours as (typeof WINDOW_PRESETS)[number])) {
      setWindow(hours);
    }
  });
}
refreshBtn.addEventListener("click", () => void fetchStats());
emptyRefreshBtn.addEventListener("click", () => void fetchStats());
retryBtn.addEventListener("click", () => void fetchStats());

// ---------------------------------------------------------------------------
// App wiring (same shape as the trace explorer)
// ---------------------------------------------------------------------------

function handleHostContextChanged(ctx: McpUiHostContext) {
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  if (ctx.safeAreaInsets) {
    mainEl.style.paddingTop = `${ctx.safeAreaInsets.top}px`;
    mainEl.style.paddingRight = `${ctx.safeAreaInsets.right}px`;
    mainEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    mainEl.style.paddingLeft = `${ctx.safeAreaInsets.left}px`;
  }
}

const app = new App({ name: "qyl MCP Dashboard", version: packageMetadata.version });

app.onteardown = async () => {
  console.info("App is being torn down");
  return {};
};

app.ontoolinput = (params) => {
  // display_mcp_dashboard is running server-side; show a window-aware spinner.
  const args = (params.arguments ?? {}) as { hours?: number };
  if (typeof args.hours === "number" && Number.isFinite(args.hours)) {
    // Snap the selector to the nearest preset for display.
    state.hours = args.hours <= 1 ? 1 : args.hours <= 24 ? 24 : 168;
    renderHeader();
    loadingTextEl.textContent = `Loading MCP stats (last ${args.hours}h)…`;
  } else {
    loadingTextEl.textContent = "Loading MCP stats…";
  }
  showView("loading");
};

app.ontoolresult = (result) => {
  const stats = parseStatsPayload(result);
  if (!stats) {
    showError(toolErrorText(result) ?? "Received an invalid tool result.");
    return;
  }
  applyStats(stats);
};

app.ontoolcancelled = () => {
  // ontoolinput already switched to the loading spinner; restore the prior
  // view so a cancelled call doesn't leave the viewer stuck on "Loading…".
  showView(state.stats ? "dashboard" : "empty");
};

app.onerror = console.error;

app.onhostcontextchanged = handleHostContextChanged;

// ---------------------------------------------------------------------------
// Connect to host
// ---------------------------------------------------------------------------

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
