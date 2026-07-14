// Telemetry reaches the DOM only through textContent/createTextNode; innerHTML is constant SVG.
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type {
  DisplayTracesOutput,
  FetchTelemetryOutput,
  LogRecord as QylLogRecord,
  McpDataMode as Mode,
  Span as QylSpan,
  SpanEvent as QylSpanEvent,
  Trace as QylTrace,
} from "@ancplua/qyl-api-schema/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import packageMetadata from "../package.json";
import {
  DisplayTracesOutputSchema,
  FetchTelemetryOutputSchema,
} from "../src/contract-validation.ts";
import { logBodyText } from "../src/log-body.ts";
import { computeWaterfall, type WaterfallRow } from "./waterfall.ts";
import "./global.css";
import "./mcp-app.css";

type TracesPayload = DisplayTracesOutput;
type LogsPayload = Required<Pick<FetchTelemetryOutput, "logs" | "mode">>;


type Tab = "waterfall" | "logs";

const state = {
  mode: undefined as Mode | undefined,
  traces: [] as QylTrace[],
  selectedTraceId: undefined as string | undefined,
  selectedSpanId: undefined as string | undefined,
  activeTab: "waterfall" as Tab,
  logsCache: new Map<string, QylLogRecord[]>(),
  busy: false,
  // Prevent an older response from replacing the active trace's logs.
  logsRequestSeq: 0,
};


const mainEl = document.querySelector(".main") as HTMLElement;
const demoBadgeEl = document.getElementById("demo-badge")!;
const traceCountLabelEl = document.getElementById("trace-count-label")!;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const emptyRefreshBtn = document.getElementById("empty-refresh-btn") as HTMLButtonElement;
const retryBtn = document.getElementById("retry-btn") as HTMLButtonElement;
const bannerEl = document.getElementById("banner")!;
const loadingEl = document.getElementById("state-loading")!;
const loadingTextEl = document.getElementById("loading-text")!;
const emptyEl = document.getElementById("state-empty")!;
const errorEl = document.getElementById("state-error")!;
const errorMessageEl = document.getElementById("error-message")!;
const explorerEl = document.getElementById("explorer")!;
const traceListEl = document.getElementById("trace-list")!;
const traceViewEmptyEl = document.getElementById("trace-view-empty")!;
const traceViewBodyEl = document.getElementById("trace-view-body")!;
const traceTitleEl = document.getElementById("trace-title")!;
const traceStatusBadgeEl = document.getElementById("trace-status-badge")!;
const traceIdLabelEl = document.getElementById("trace-id-label")!;
const traceDurationLabelEl = document.getElementById("trace-duration-label")!;
const traceSpanCountLabelEl = document.getElementById("trace-span-count-label")!;
const traceServicesEl = document.getElementById("trace-services")!;
const tabWaterfallBtn = document.getElementById("tab-waterfall") as HTMLButtonElement;
const tabLogsBtn = document.getElementById("tab-logs") as HTMLButtonElement;
const waterfallPanelEl = document.getElementById("waterfall-panel")!;
const timeRulerEl = document.getElementById("time-ruler")!;
const spanRowsEl = document.getElementById("span-rows")!;
const logsPanelEl = document.getElementById("logs-panel")!;
const logsStateEl = document.getElementById("logs-state")!;
const logsListEl = document.getElementById("logs-list")!;
const detailPanelEl = document.getElementById("detail-panel")!;
const detailTitleEl = document.getElementById("detail-title")!;
const detailBodyEl = document.getElementById("detail-body")!;
const detailCloseBtn = document.getElementById("detail-close-btn") as HTMLButtonElement;


const KIND_LABELS: Record<number, string> = {
  0: "Unspecified",
  1: "Internal",
  2: "Server",
  3: "Client",
  4: "Producer",
  5: "Consumer",
};

type Flavor = "genai" | "http" | "db" | "messaging" | "neutral";

function spanFlavor(span: QylSpan): Flavor {
  let flavor: Flavor | undefined;
  for (const attr of span.attributes ?? []) {
    const key = attr?.key;
    if (typeof key !== "string") continue;
    if (key.startsWith("gen_ai.")) return "genai"; // highest priority — stop early
    if (!flavor && key.startsWith("http.")) flavor = "http";
    if (!flavor && key.startsWith("db.")) flavor = "db";
    if (!flavor && key.startsWith("messaging.")) flavor = "messaging";
  }
  if (flavor) return flavor;
  if (span.kind === 4 || span.kind === 5) return "messaging";
  return "neutral";
}

function serviceName(span: QylSpan): string {
  const v = span.resource?.["service.name"];
  return typeof v === "string" && v ? v : "unknown";
}

interface SeverityInfo {
  label: string;
  cls: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}

function severityInfo(log: QylLogRecord): SeverityInfo {
  const n = log.severity_number;
  let info: SeverityInfo;
  if (n >= 21) info = { label: "FATAL", cls: "fatal" };
  else if (n >= 17) info = { label: "ERROR", cls: "error" };
  else if (n >= 13) info = { label: "WARN", cls: "warn" };
  else if (n >= 9) info = { label: "INFO", cls: "info" };
  else if (n >= 5) info = { label: "DEBUG", cls: "debug" };
  else info = { label: "TRACE", cls: "trace" };
  if (typeof log.severity_text === "string" && log.severity_text) {
    info = { ...info, label: log.severity_text.toUpperCase() };
  }
  return info;
}

function sigFig(v: number): string {
  if (v >= 100) return String(Math.round(v));
  const s = v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.replace(/\.?0+$/, "");
}

function formatNs(ns: number): string {
  if (!Number.isFinite(ns) || ns < 0) return "—";
  if (ns < 1e3) return `${Math.round(ns)} ns`;
  if (ns < 1e6) return `${sigFig(ns / 1e3)} µs`;
  if (ns < 1e9) return `${sigFig(ns / 1e6)} ms`;
  return `${sigFig(ns / 1e9)} s`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatLogTime(ns: number): string {
  if (!Number.isFinite(ns) || ns <= 0) return "—";
  const date = new Date(ns / 1e6);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

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

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}


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

const app = new App({ name: "qyl Trace Explorer", version: packageMetadata.version });

app.onteardown = async () => {
  console.info("App is being torn down");
  return {};
};

app.ontoolinput = (params) => {
  const args = (params.arguments ?? {}) as { trace_id?: string; session_id?: string };
  if (typeof args.trace_id === "string" && args.trace_id) {
    loadingTextEl.textContent = `Loading trace ${shortId(args.trace_id)}…`;
  } else if (typeof args.session_id === "string" && args.session_id) {
    loadingTextEl.textContent = `Loading session ${args.session_id}…`;
  } else {
    loadingTextEl.textContent = "Loading traces…";
  }
  showView("loading");
};

app.ontoolresult = (result) => {
  const payload = parseTracesPayload(result);
  if (!payload) {
    showError(toolErrorText(result) ?? "Received an invalid tool result.");
    return;
  }
  applyTraces(payload);
};

app.ontoolcancelled = () => {
  // Restore the prior view after a cancelled call.
  showView(state.traces.length > 0 ? "explorer" : "empty");
};

app.onerror = console.error;

app.onhostcontextchanged = handleHostContextChanged;

function toolErrorText(result: CallToolResult): string | undefined {
  const text = result.content
    ?.map((c) => ("text" in c ? c.text : ""))
    .filter(Boolean)
    .join(" ");
  return text || undefined;
}

function parseTracesPayload(result: CallToolResult): TracesPayload | null {
  const parsed = DisplayTracesOutputSchema.safeParse(result.structuredContent);
  return parsed.success ? parsed.data : null;
}

function parseLogsPayload(result: CallToolResult): LogsPayload | null {
  const parsed = FetchTelemetryOutputSchema.safeParse(result.structuredContent);
  return parsed.success && parsed.data.logs !== undefined
    ? { logs: parsed.data.logs, mode: parsed.data.mode }
    : null;
}


type ViewName = "loading" | "empty" | "error" | "explorer";

function showView(view: ViewName) {
  loadingEl.hidden = view !== "loading";
  emptyEl.hidden = view !== "empty";
  errorEl.hidden = view !== "error";
  explorerEl.hidden = view !== "explorer";
}

function showError(message: string) {
  errorMessageEl.textContent = message;
  showView("error");
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;

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
  const n = state.traces.length;
  traceCountLabelEl.textContent = n === 0 ? "" : `${n} trace${n === 1 ? "" : "s"}`;
}


function selectedTrace(): QylTrace | undefined {
  return state.traces.find((t) => t.trace_id === state.selectedTraceId);
}

function traceDisplayName(trace: QylTrace): string {
  if (trace.root_span?.name) return trace.root_span.name;
  let first: QylSpan | undefined;
  for (const span of trace.spans) {
    if (!first || span.start_time_unix_nano < first.start_time_unix_nano) first = span;
  }
  return first?.name ?? "(unnamed trace)";
}

function applyTraces(payload: TracesPayload) {
  state.traces = payload.traces;
  state.mode = payload.mode;
  state.logsCache.clear();
  state.selectedSpanId = undefined;
  closeDetail();

  const preferred = payload.selected_trace_id ?? state.selectedTraceId;
  const stillThere = state.traces.some((t) => t.trace_id === preferred);
  state.selectedTraceId = stillThere ? preferred : state.traces[0]?.trace_id;
  state.activeTab = "waterfall";

  renderHeader();
  renderTraceList();
  renderTraceView();
  showView(state.traces.length === 0 ? "empty" : "explorer");
}

function selectTrace(traceId: string) {
  if (state.selectedTraceId === traceId) return;
  state.selectedTraceId = traceId;
  state.selectedSpanId = undefined;
  state.activeTab = "waterfall";
  closeDetail();
  renderTraceList();
  renderTraceView();
}

function moveTraceSelection(delta: number) {
  if (state.traces.length === 0) return;
  const idx = state.traces.findIndex((t) => t.trace_id === state.selectedTraceId);
  const next = idx === -1 ? 0 : Math.min(state.traces.length - 1, Math.max(0, idx + delta));
  const trace = state.traces[next];
  if (!trace || trace.trace_id === state.selectedTraceId) return;
  selectTrace(trace.trace_id);
  traceListEl
    .querySelector(`[data-trace-id="${CSS.escape(trace.trace_id)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}


function createServiceChip(name: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "service-chip";
  chip.textContent = name;
  return chip;
}

function createTraceRow(trace: QylTrace): HTMLElement {
  const row = document.createElement("li");
  row.className = "trace-row";
  row.dataset.traceId = trace.trace_id;
  row.setAttribute("role", "option");
  row.tabIndex = -1;
  if (trace.trace_id === state.selectedTraceId) {
    row.classList.add("selected");
    row.setAttribute("aria-selected", "true");
  }
  if (trace.has_error) row.classList.add("has-error");

  const top = document.createElement("div");
  top.className = "trace-row-top";
  if (trace.has_error) {
    const warn = document.createElement("span");
    warn.className = "trace-warn";
    warn.textContent = "⚠";
    warn.title = "Trace contains error spans";
    top.appendChild(warn);
  }
  const name = document.createElement("span");
  name.className = "trace-row-name";
  name.textContent = traceDisplayName(trace);
  name.title = traceDisplayName(trace);
  top.appendChild(name);
  const duration = document.createElement("span");
  duration.className = "trace-row-duration mono";
  duration.textContent = formatNs(trace.duration_ns);
  top.appendChild(duration);
  row.appendChild(top);

  const meta = document.createElement("div");
  meta.className = "trace-row-meta";
  const id = document.createElement("span");
  id.className = "mono dim";
  id.textContent = shortId(trace.trace_id);
  meta.appendChild(id);
  const spans = document.createElement("span");
  spans.className = "dim";
  spans.textContent = `${trace.span_count} span${trace.span_count === 1 ? "" : "s"}`;
  meta.appendChild(spans);
  row.appendChild(meta);

  if (trace.services.length > 0) {
    const chips = document.createElement("div");
    chips.className = "trace-row-chips";
    for (const service of trace.services.slice(0, 4)) {
      chips.appendChild(createServiceChip(service));
    }
    if (trace.services.length > 4) {
      const more = document.createElement("span");
      more.className = "dim";
      more.textContent = `+${trace.services.length - 4}`;
      chips.appendChild(more);
    }
    row.appendChild(chips);
  }

  row.addEventListener("click", () => selectTrace(trace.trace_id));
  return row;
}

function renderTraceList() {
  const fragment = document.createDocumentFragment();
  for (const trace of state.traces) {
    fragment.appendChild(createTraceRow(trace));
  }
  traceListEl.replaceChildren(fragment);
}


function renderTraceView() {
  const trace = selectedTrace();
  traceViewEmptyEl.hidden = Boolean(trace);
  traceViewBodyEl.hidden = !trace;
  if (!trace) return;

  traceTitleEl.textContent = traceDisplayName(trace);
  traceStatusBadgeEl.textContent = trace.has_error ? "Error" : "OK";
  traceStatusBadgeEl.className = `trace-status-badge ${trace.has_error ? "error" : "ok"}`;
  traceIdLabelEl.textContent = trace.trace_id;
  traceDurationLabelEl.textContent = formatNs(trace.duration_ns);
  traceSpanCountLabelEl.textContent = `${trace.span_count} span${trace.span_count === 1 ? "" : "s"}`;
  const chips = document.createDocumentFragment();
  for (const service of trace.services) chips.appendChild(createServiceChip(service));
  traceServicesEl.replaceChildren(chips);

  renderTabs();
  renderWaterfall(trace);
  if (state.activeTab === "logs") void showLogsTab(trace);
}

function renderTabs() {
  const isLogs = state.activeTab === "logs";
  tabWaterfallBtn.classList.toggle("active", !isLogs);
  tabWaterfallBtn.setAttribute("aria-selected", String(!isLogs));
  tabLogsBtn.classList.toggle("active", isLogs);
  tabLogsBtn.setAttribute("aria-selected", String(isLogs));
  waterfallPanelEl.hidden = isLogs;
  logsPanelEl.hidden = !isLogs;
}

function setTab(tab: Tab) {
  if (state.activeTab === tab) return;
  state.activeTab = tab;
  renderTabs();
  const trace = selectedTrace();
  if (tab === "logs" && trace) void showLogsTab(trace);
}


function renderTimeRuler(totalNs: number) {
  timeRulerEl.replaceChildren();
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const pct = (i / ticks) * 100;
    const tick = document.createElement("span");
    tick.className = "ruler-tick";
    if (i === 0) tick.classList.add("first");
    if (i === ticks) tick.classList.add("last");
    tick.style.left = `${pct}%`;
    tick.textContent = totalNs > 0 ? formatNs((i / ticks) * totalNs) : "0 ns";
    timeRulerEl.appendChild(tick);
  }
}

function createSpanRow(row: WaterfallRow<QylSpan>, traceStartNs: number): HTMLElement {
  const { span, depth } = row;
  const flavor = spanFlavor(span);
  const isError = span.status?.code === 2;

  const el = document.createElement("div");
  el.className = `span-row flavor-${flavor}`;
  if (isError) el.classList.add("has-error");
  if (span.span_id === state.selectedSpanId) el.classList.add("selected");
  el.dataset.spanId = span.span_id;
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `Span ${span.name}, ${formatNs(span.end_time_unix_nano - span.start_time_unix_nano)}`);

  const nameCol = document.createElement("div");
  nameCol.className = "span-name-col";
  nameCol.style.paddingLeft = `${8 + Math.min(depth, 24) * 14}px`;
  const dot = document.createElement("span");
  dot.className = "span-dot";
  nameCol.appendChild(dot);
  const name = document.createElement("span");
  name.className = "span-name";
  name.textContent = span.name;
  name.title = span.name;
  nameCol.appendChild(name);
  const service = document.createElement("span");
  service.className = "span-service dim";
  service.textContent = serviceName(span);
  nameCol.appendChild(service);
  el.appendChild(nameCol);

  const barCol = document.createElement("div");
  barCol.className = "span-bar-col";
  const bar = document.createElement("span");
  bar.className = "span-bar";
  bar.style.left = `${row.leftPct}%`;
  bar.style.width = `${row.widthPct}%`;
  barCol.appendChild(bar);
  const durationLabel = document.createElement("span");
  durationLabel.className = "span-duration mono";
  // Sit the label after the bar; when the bar ends near the right edge,
  // flip it to the left of the bar, or inside the bar when there is no
  // room on either side (near-full-width bars).
  const barEnd = row.leftPct + row.widthPct;
  if (barEnd <= 82) {
    durationLabel.style.left = `${barEnd + 0.6}%`;
  } else if (row.leftPct >= 12) {
    durationLabel.style.right = `${100 - row.leftPct + 0.6}%`;
  } else {
    durationLabel.classList.add("inside");
    durationLabel.style.right = `${Math.max(0.6, 100 - barEnd + 0.6)}%`;
  }
  durationLabel.textContent = formatNs(span.end_time_unix_nano - span.start_time_unix_nano);
  barCol.appendChild(durationLabel);
  el.appendChild(barCol);

  const open = () => openDetail(span, traceStartNs);
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === el) open();
  });
  return el;
}

function renderWaterfall(trace: QylTrace) {
  const waterfall = computeWaterfall(trace.spans);
  renderTimeRuler(waterfall.totalNs);
  const fragment = document.createDocumentFragment();
  for (const row of waterfall.rows) {
    fragment.appendChild(createSpanRow(row, waterfall.traceStartNs));
  }
  spanRowsEl.replaceChildren(fragment);
  if (waterfall.rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "logs-state";
    empty.textContent = "This trace has no spans.";
    spanRowsEl.appendChild(empty);
  }
}


function detailSection(label: string): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement("section");
  section.className = "detail-section";
  const heading = document.createElement("div");
  heading.className = "detail-label";
  heading.textContent = label;
  section.appendChild(heading);
  const body = document.createElement("div");
  section.appendChild(body);
  return { section, body };
}

function detailStat(label: string, value: string, cls?: string): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "detail-stat";
  const labelEl = document.createElement("div");
  labelEl.className = "detail-label";
  labelEl.textContent = label;
  cell.appendChild(labelEl);
  const valueEl = document.createElement("div");
  valueEl.className = `detail-stat-value${cls ? ` ${cls}` : ""}`;
  valueEl.textContent = value;
  cell.appendChild(valueEl);
  return cell;
}

function attributeRows(container: HTMLElement, attrs: Array<{ key: string; value: unknown }>) {
  const table = document.createElement("div");
  table.className = "attr-table";
  for (const attr of attrs) {
    if (typeof attr?.key !== "string") continue;
    const keyEl = document.createElement("span");
    keyEl.className = "attr-key mono";
    if (attr.key.startsWith("error.") || attr.key.startsWith("exception.")) {
      keyEl.classList.add("error");
    }
    keyEl.textContent = attr.key;
    const valueEl = document.createElement("span");
    valueEl.className = "attr-value mono";
    valueEl.textContent = stringifyValue(attr.value);
    table.append(keyEl, valueEl);
  }
  container.appendChild(table);
}

function renderEvent(event: QylSpanEvent, spanStartNs: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "event-card";
  const isException = event.name === "exception";
  if (isException) card.classList.add("exception");

  const head = document.createElement("div");
  head.className = "event-head";
  const name = document.createElement("span");
  name.className = "event-name";
  name.textContent = event.name;
  head.appendChild(name);
  const time = document.createElement("span");
  time.className = "mono dim";
  time.textContent = `+${formatNs(Math.max(0, event.time_unix_nano - spanStartNs))}`;
  head.appendChild(time);
  card.appendChild(head);

  for (const item of event.attributes ?? []) {
    const pair = item as { key?: unknown; value?: unknown } | null;
    const key = pair && typeof pair.key === "string" ? pair.key : undefined;
    const value = key !== undefined ? pair?.value : item;
    const row = document.createElement("div");
    row.className = "event-attr";
    if (key !== undefined) {
      const keyEl = document.createElement("span");
      keyEl.className = "attr-key mono";
      keyEl.textContent = key;
      row.appendChild(keyEl);
    }
    if (key === "exception.stacktrace") {
      const pre = document.createElement("pre");
      pre.className = "stacktrace mono";
      pre.textContent = stringifyValue(value);
      row.appendChild(pre);
    } else {
      const valueEl = document.createElement("span");
      valueEl.className = "attr-value mono";
      valueEl.textContent = stringifyValue(value);
      row.appendChild(valueEl);
    }
    card.appendChild(row);
  }
  return card;
}

function openDetail(span: QylSpan, traceStartNs: number) {
  state.selectedSpanId = span.span_id;
  for (const row of spanRowsEl.querySelectorAll<HTMLElement>(".span-row")) {
    row.classList.toggle("selected", row.dataset.spanId === span.span_id);
  }

  detailTitleEl.textContent = span.name;
  const body = document.createDocumentFragment();

  const stats = document.createElement("div");
  stats.className = "detail-stats";
  stats.appendChild(detailStat("Service", serviceName(span)));
  stats.appendChild(detailStat("Kind", KIND_LABELS[span.kind] ?? String(span.kind)));
  stats.appendChild(
    detailStat("Duration", formatNs(span.end_time_unix_nano - span.start_time_unix_nano)),
  );
  stats.appendChild(
    detailStat("Offset", `+${formatNs(Math.max(0, span.start_time_unix_nano - traceStartNs))}`),
  );
  const statusCode = span.status?.code ?? 0;
  const statusLabel = statusCode === 2 ? "Error" : statusCode === 1 ? "OK" : "Unset";
  stats.appendChild(
    detailStat("Status", statusLabel, statusCode === 2 ? "status-error" : statusCode === 1 ? "status-ok" : "status-unset"),
  );
  stats.appendChild(detailStat("Start", formatLogTime(span.start_time_unix_nano)));
  const attrNumber = (key: string): number | undefined => {
    const v = (span.attributes ?? []).find((a) => a?.key === key)?.value;
    return typeof v === "number" ? v : undefined;
  };
  const inTokens = attrNumber("gen_ai.usage.input_tokens");
  const outTokens = attrNumber("gen_ai.usage.output_tokens");
  if (inTokens !== undefined || outTokens !== undefined) {
    stats.appendChild(
      detailStat(
        "Tokens",
        `${inTokens !== undefined ? formatCompact(inTokens) : "—"} in · ${outTokens !== undefined ? formatCompact(outTokens) : "—"} out`,
      ),
    );
  }
  body.appendChild(stats);

  if (span.status?.message) {
    const { section, body: msgBody } = detailSection("Status message");
    const msg = document.createElement("div");
    msg.className = "status-message mono";
    msg.textContent = span.status.message;
    msgBody.appendChild(msg);
    body.appendChild(section);
  }

  const { section: ids, body: idsBody } = detailSection("Identifiers");
  const idTable = document.createElement("div");
  idTable.className = "attr-table";
  const idPairs: Array<[string, string | undefined]> = [
    ["trace", span.trace_id],
    ["span", span.span_id],
    ["parent", span.parent_span_id],
  ];
  for (const [label, value] of idPairs) {
    if (!value) continue;
    const keyEl = document.createElement("span");
    keyEl.className = "attr-key mono";
    keyEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "attr-value mono";
    valueEl.textContent = value;
    idTable.append(keyEl, valueEl);
  }
  idsBody.appendChild(idTable);
  body.appendChild(ids);

  const attrs = span.attributes ?? [];
  if (attrs.length > 0) {
    const { section, body: attrsBody } = detailSection(`Attributes (${attrs.length})`);
    attributeRows(attrsBody, attrs);
    body.appendChild(section);
  }

  const events = span.events ?? [];
  if (events.length > 0) {
    const { section, body: eventsBody } = detailSection(`Events (${events.length})`);
    for (const event of events) {
      eventsBody.appendChild(renderEvent(event, span.start_time_unix_nano));
    }
    body.appendChild(section);
  }

  detailBodyEl.replaceChildren(body);
  detailPanelEl.hidden = false;
  detailBodyEl.scrollTop = 0;
}

function closeDetail() {
  if (detailPanelEl.hidden) return;
  detailPanelEl.hidden = true;
  state.selectedSpanId = undefined;
  for (const row of spanRowsEl.querySelectorAll<HTMLElement>(".span-row.selected")) {
    row.classList.remove("selected");
  }
}


function renderLogs(logs: QylLogRecord[]) {
  logsStateEl.hidden = logs.length > 0;
  if (logs.length === 0) {
    logsStateEl.textContent = "No logs recorded for this trace.";
  }
  const fragment = document.createDocumentFragment();
  const sorted = [...logs].sort((a, b) => a.time_unix_nano - b.time_unix_nano);
  for (const log of sorted) {
    const { label, cls } = severityInfo(log);
    const row = document.createElement("div");
    row.className = `log-row severity-${cls}`;
    const time = document.createElement("span");
    time.className = "log-time mono dim";
    time.textContent = formatLogTime(log.time_unix_nano);
    row.appendChild(time);
    const badge = document.createElement("span");
    badge.className = "log-severity";
    badge.textContent = label;
    row.appendChild(badge);
    const logBody = document.createElement("span");
    logBody.className = "log-body mono";
    logBody.textContent = logBodyText(log.body);
    row.appendChild(logBody);
    fragment.appendChild(row);
  }
  logsListEl.replaceChildren(fragment);
}

async function showLogsTab(trace: QylTrace) {
  const cached = state.logsCache.get(trace.trace_id);
  if (cached) {
    renderLogs(cached);
    return;
  }

  const seq = ++state.logsRequestSeq;
  logsListEl.replaceChildren();
  logsStateEl.hidden = false;
  logsStateEl.textContent = "Loading logs…";
  try {
    const result = await app.callServerTool({
      name: "fetch_telemetry",
      arguments: { view: "logs", trace_id: trace.trace_id, limit: 100 },
    });
    if (result.isError) {
      throw new Error(toolErrorText(result) ?? "fetch_telemetry failed");
    }
    const payload = parseLogsPayload(result);
    if (!payload) {
      throw new Error("fetch_telemetry returned an invalid logs payload");
    }
    state.logsCache.set(trace.trace_id, payload.logs);
    // Stale guard: the user may have switched traces/tabs mid-flight.
    if (seq !== state.logsRequestSeq || state.selectedTraceId !== trace.trace_id) return;
    if (state.activeTab === "logs") renderLogs(payload.logs);
  } catch (err) {
    if (seq !== state.logsRequestSeq || state.selectedTraceId !== trace.trace_id) return;
    logsStateEl.hidden = false;
    logsStateEl.textContent = `Couldn't load logs: ${err instanceof Error ? err.message : String(err)}`;
  }
}


async function refreshTraces() {
  if (state.busy) return;
  state.busy = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add("spinning");
  const hadTraces = state.traces.length > 0;
  if (!hadTraces) {
    loadingTextEl.textContent = "Loading traces…";
    showView("loading");
  }
  try {
    const result = await app.callServerTool({
      name: "fetch_telemetry",
      arguments: { view: "traces", limit: 20 },
    });
    if (result.isError) {
      throw new Error(toolErrorText(result) ?? "fetch_telemetry failed");
    }
    const payload = parseTracesPayload(result);
    if (!payload) {
      throw new Error("fetch_telemetry returned an invalid payload");
    }
    applyTraces(payload);
  } catch (err) {
    if (hadTraces) {
      showView("explorer");
      showBanner(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } else {
      showError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    state.busy = false;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove("spinning");
  }
}


refreshBtn.addEventListener("click", () => void refreshTraces());
emptyRefreshBtn.addEventListener("click", () => void refreshTraces());
retryBtn.addEventListener("click", () => void refreshTraces());
detailCloseBtn.addEventListener("click", closeDetail);
tabWaterfallBtn.addEventListener("click", () => setTab("waterfall"));
tabLogsBtn.addEventListener("click", () => setTab("logs"));

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDetail();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (explorerEl.hidden) return;
    e.preventDefault();
    moveTraceSelection(e.key === "ArrowDown" ? 1 : -1);
  }
});


app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
