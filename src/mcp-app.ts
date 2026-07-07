/**
 * @file X Timeline Viewer — MCP App.
 *
 * Renders an X (Twitter) timeline from the `display_timeline` tool result and
 * lets the user search / paginate via the app-only `fetch_posts` server tool.
 *
 * Rendering is XSS-safe by construction: all API-supplied strings reach the
 * DOM exclusively through `textContent` / `createTextNode`. URL linkification
 * splits the post text on entity offsets and builds anchor elements — raw
 * text is never concatenated into HTML. The only `innerHTML` writes use the
 * constant SVG icon strings defined in this file.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./global.css";
import "./mcp-app.css";

// ---------------------------------------------------------------------------
// Shapes (mirrors INTERFACE.md — the viewer renders ONLY this shape)
// ---------------------------------------------------------------------------

interface XAuthor {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  verified?: boolean;
}

interface XMedia {
  type: "photo" | "video" | "animated_gif";
  url?: string;
  preview_image_url?: string;
}

interface XUrlEntity {
  url: string;
  expanded_url: string;
  display_url: string;
}

interface XPost {
  id: string;
  text: string;
  author: XAuthor;
  created_at: string; // ISO 8601
  metrics: {
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    views?: number;
  };
  media?: XMedia[];
  urls?: XUrlEntity[];
}

type TimelineSource = "search" | "user";

/** structuredContent of `fetch_posts`. */
interface FetchPostsPayload {
  posts: XPost[];
  next_token?: string;
  mode: "live" | "demo";
}

/** structuredContent of `display_timeline`. */
interface TimelinePayload extends FetchPostsPayload {
  source: TimelineSource;
  query?: string;
  username?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  source: "search" as TimelineSource,
  query: undefined as string | undefined,
  username: undefined as string | undefined,
  mode: "demo" as "live" | "demo",
  posts: [] as XPost[],
  /** ids already rendered — guards against duplicate appends when paging. */
  seenIds: new Set<string>(),
  nextToken: undefined as string | undefined,
  /** In-flight guard for search / load-more. */
  busy: false,
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const mainEl = document.querySelector(".main") as HTMLElement;
const sourceLabelEl = document.getElementById("source-label")!;
const demoBadgeEl = document.getElementById("demo-badge")!;
const searchFormEl = document.getElementById("search-form") as HTMLFormElement;
const searchInputEl = document.getElementById("search-input") as HTMLInputElement;
const bannerEl = document.getElementById("banner")!;
const loadingEl = document.getElementById("state-loading")!;
const loadingTextEl = document.getElementById("loading-text")!;
const emptyEl = document.getElementById("state-empty")!;
const errorEl = document.getElementById("state-error")!;
const errorMessageEl = document.getElementById("error-message")!;
const timelineEl = document.getElementById("timeline")!;
const loadMoreBtn = document.getElementById("load-more-btn") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// Constant SVG icons (static markup only — NEVER interpolate user data here)
// ---------------------------------------------------------------------------

const ICONS = {
  reply:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"/></svg>',
  repost:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/></svg>',
  like:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg>',
  views:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/></svg>',
  verified:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/></svg>',
  play:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12L4 2v20l17-10z"/></svg>',
};

/** Deterministic avatar-fallback palette (works on light and dark). */
const AVATAR_COLORS = [
  "#1d9bf0", "#00ba7c", "#f91880", "#7856ff",
  "#ff7a00", "#ffd400", "#e0245e", "#794bc4",
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** 1234 → "1.2K", 3400000 → "3.4M". */
function formatCompact(n: number | undefined): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "";
  if (n < 1000) return String(n);
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [div, suffix] of units) {
    if (n >= div) {
      const v = n / div;
      // One decimal below 100, none above; strip trailing ".0".
      const s = v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "");
      return `${s}${suffix}`;
    }
  }
  return String(n);
}

/** ISO timestamp → "now" / "5m" / "2h" / "3d" / "Mar 5" / "Mar 5, 2024". */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d`;
  const date = new Date(then);
  const opts: Intl.DateTimeFormatOptions =
    date.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return date.toLocaleDateString(undefined, opts);
}

/** Stable color pick for the avatar-initial fallback. */
function avatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * Validate an external URL for use as href / openLink target.
 * Parse-and-reserialize (URL.href) so only http(s) survives — blocks
 * `javascript:` and friends. Returns undefined when unsafe/unparseable.
 */
function safeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.href;
    }
  } catch {
    // fall through
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// App wiring (same shape as the vanillajs template)
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

const app = new App({ name: "X Timeline Viewer", version: "1.0.0" });

app.onteardown = async () => {
  console.info("App is being torn down");
  return {};
};

app.ontoolinput = (params) => {
  // display_timeline is running server-side; show a query-aware spinner.
  console.info("Received tool call input:", params);
  const args = (params.arguments ?? {}) as { query?: string; username?: string };
  if (typeof args.query === "string" && args.query) {
    loadingTextEl.textContent = `Searching for “${args.query}”…`;
  } else if (typeof args.username === "string" && args.username) {
    loadingTextEl.textContent = `Loading @${args.username}…`;
  }
  showView("loading");
};

app.ontoolresult = (result) => {
  console.info("Received tool call result:", result);
  const payload = parseTimelinePayload(result);
  if (!payload) {
    showError(toolErrorText(result) ?? "Received an invalid tool result.");
    return;
  }
  state.source = payload.source;
  state.query = payload.query;
  state.username = payload.username;
  applyPage(payload, /* append */ false);
};

app.ontoolcancelled = (params) => {
  console.info("Tool call cancelled:", params.reason);
  // ontoolinput already switched to the loading spinner; restore the prior
  // view so a cancelled call doesn't leave the viewer stuck on "Loading…".
  showView(state.posts.length > 0 ? "timeline" : "empty");
};

app.onerror = console.error;

app.onhostcontextchanged = handleHostContextChanged;

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

/** Runtime-validate a post enough to render it without throwing. */
function isRenderablePost(p: unknown): p is XPost {
  if (typeof p !== "object" || p === null) return false;
  const post = p as Partial<XPost>;
  return (
    typeof post.id === "string" &&
    typeof post.text === "string" &&
    typeof post.author === "object" &&
    post.author !== null &&
    typeof post.author.username === "string"
  );
}

function parsePostsPayload(result: CallToolResult): FetchPostsPayload | null {
  const sc = result.structuredContent as Partial<FetchPostsPayload> | undefined;
  if (!sc || !Array.isArray(sc.posts)) return null;
  return {
    posts: sc.posts.filter(isRenderablePost),
    next_token: typeof sc.next_token === "string" ? sc.next_token : undefined,
    mode: sc.mode === "live" ? "live" : "demo",
  };
}

function parseTimelinePayload(result: CallToolResult): TimelinePayload | null {
  const base = parsePostsPayload(result);
  if (!base) return null;
  const sc = result.structuredContent as Partial<TimelinePayload>;
  return {
    ...base,
    source: sc.source === "user" ? "user" : "search",
    query: typeof sc.query === "string" ? sc.query : undefined,
    username: typeof sc.username === "string" ? sc.username : undefined,
  };
}

// ---------------------------------------------------------------------------
// View state helpers
// ---------------------------------------------------------------------------

type ViewName = "loading" | "empty" | "error" | "timeline";

function showView(view: ViewName) {
  loadingEl.hidden = view !== "loading";
  emptyEl.hidden = view !== "empty";
  errorEl.hidden = view !== "error";
  timelineEl.hidden = view !== "timeline";
  loadMoreBtn.hidden = view !== "timeline" || !state.nextToken;
}

function showError(message: string) {
  errorMessageEl.textContent = message;
  showView("error");
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;

/** Transient, non-destructive error notice (keeps the timeline visible). */
function showBanner(message: string) {
  bannerEl.textContent = message;
  bannerEl.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    bannerEl.hidden = true;
  }, 6000);
}

function renderHeader() {
  if (state.source === "user" && state.username) {
    sourceLabelEl.textContent = `@${state.username}`;
  } else if (state.query) {
    sourceLabelEl.textContent = `Search: ${state.query}`;
  } else {
    sourceLabelEl.textContent = "Timeline";
  }
  demoBadgeEl.hidden = state.mode !== "demo";
  // Reflect the active search query in the box (without clobbering typing).
  if (state.source === "search" && document.activeElement !== searchInputEl) {
    searchInputEl.value = state.query ?? "";
  }
}

// ---------------------------------------------------------------------------
// Post rendering (all API text goes through textContent — never innerHTML)
// ---------------------------------------------------------------------------

/**
 * Append `text` to `container` with entity URLs turned into anchors.
 * The text is split on matches of each entity's t.co `url` (or its
 * `expanded_url`); segments become text nodes, matches become `<a>` elements
 * whose label is set via textContent. No raw string ever meets innerHTML.
 */
function linkifyInto(container: HTMLElement, text: string, urls?: XUrlEntity[]) {
  interface Match {
    start: number;
    end: number;
    entity: XUrlEntity;
  }
  const matches: Match[] = [];
  for (const entity of urls ?? []) {
    // Match the wrapped t.co URL first (what the API puts in `text`),
    // falling back to the expanded URL for pre-expanded/demo text.
    for (const needle of [entity.url, entity.expanded_url]) {
      if (!needle) continue;
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        matches.push({ start: idx, end: idx + needle.length, entity });
        break;
      }
    }
  }
  matches.sort((a, b) => a.start - b.start);

  let pos = 0;
  for (const m of matches) {
    if (m.start < pos) continue; // overlap — skip
    if (m.start > pos) {
      container.appendChild(document.createTextNode(text.slice(pos, m.start)));
    }
    const href = safeHttpUrl(m.entity.expanded_url) ?? safeHttpUrl(m.entity.url);
    const label = m.entity.display_url || m.entity.expanded_url || m.entity.url;
    if (href) {
      const a = document.createElement("a");
      a.className = "post-link";
      a.href = href;
      a.rel = "noopener noreferrer";
      a.textContent = label;
      a.title = m.entity.expanded_url;
      a.addEventListener("click", (e) => {
        // Route through the host — plain navigation is blocked in the iframe.
        e.preventDefault();
        e.stopPropagation();
        void openExternal(href);
      });
      container.appendChild(a);
    } else {
      // Unsafe/unparseable URL: render its label as plain text.
      container.appendChild(document.createTextNode(label));
    }
    pos = m.end;
  }
  if (pos < text.length) {
    container.appendChild(document.createTextNode(text.slice(pos)));
  }
}

/** Avatar image with colored-initial fallback on missing/failed load. */
function createAvatar(author: XAuthor): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "avatar";

  const useFallback = () => {
    wrap.replaceChildren();
    wrap.classList.add("avatar-fallback");
    wrap.style.backgroundColor = avatarColor(author.username);
    const initial = (author.name || author.username || "?").trim().charAt(0);
    wrap.textContent = initial.toUpperCase() || "?";
  };

  const src = safeHttpUrl(author.profile_image_url);
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", useFallback);
    img.src = src;
    wrap.appendChild(img);
  } else {
    useFallback();
  }
  return wrap;
}

/** One metric ("icon + compact count"). Icons are constant markup. */
function createMetric(
  kind: "reply" | "repost" | "like" | "views",
  value: number | undefined,
  label: string,
): HTMLElement {
  const el = document.createElement("span");
  el.className = `metric metric-${kind}`;
  el.title = label;
  const icon = document.createElement("span");
  icon.className = "metric-icon";
  icon.innerHTML = ICONS[kind]; // constant markup only
  const count = document.createElement("span");
  count.className = "metric-count";
  count.textContent = formatCompact(value);
  el.append(icon, count);
  return el;
}

function createMediaGrid(media: XMedia[]): HTMLElement | null {
  const items = media
    .map((m) => ({
      type: m.type,
      src: safeHttpUrl(m.type === "photo" ? m.url ?? m.preview_image_url : m.preview_image_url ?? m.url),
    }))
    .filter((m): m is { type: XMedia["type"]; src: string } => Boolean(m.src));
  if (items.length === 0) return null;

  const grid = document.createElement("div");
  grid.className = `post-media media-count-${Math.min(items.length, 4)}`;
  for (const item of items.slice(0, 4)) {
    const cell = document.createElement("div");
    cell.className = "media-item";
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = item.src;
    // Hide broken media cells instead of showing a broken-image glyph.
    img.addEventListener("error", () => {
      cell.remove();
    });
    cell.appendChild(img);
    if (item.type === "video" || item.type === "animated_gif") {
      const badge = document.createElement("span");
      badge.className = "media-play";
      badge.innerHTML = ICONS.play; // constant markup
      cell.appendChild(badge);
    }
    grid.appendChild(cell);
  }
  return grid;
}

function createPostCard(post: XPost): HTMLElement {
  const card = document.createElement("article");
  card.className = "post";
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  card.setAttribute(
    "aria-label",
    `Post by ${post.author.name || post.author.username}. Open on X.`,
  );

  card.appendChild(createAvatar(post.author));

  const body = document.createElement("div");
  body.className = "post-body";

  // --- Header row: name · badge · @handle · time ---
  const head = document.createElement("div");
  head.className = "post-head";

  const name = document.createElement("span");
  name.className = "post-name";
  name.textContent = post.author.name || post.author.username;
  head.appendChild(name);

  if (post.author.verified) {
    const badge = document.createElement("span");
    badge.className = "verified-badge";
    badge.title = "Verified";
    badge.innerHTML = ICONS.verified; // constant markup
    head.appendChild(badge);
  }

  const handle = document.createElement("span");
  handle.className = "post-handle";
  handle.textContent = `@${post.author.username}`;
  head.appendChild(handle);

  const dot = document.createElement("span");
  dot.className = "post-dot";
  dot.textContent = "·";
  head.appendChild(dot);

  const time = document.createElement("time");
  time.className = "post-time";
  time.dateTime = post.created_at;
  time.textContent = relativeTime(post.created_at);
  time.title = new Date(post.created_at).toLocaleString();
  head.appendChild(time);

  body.appendChild(head);

  // --- Text (escaped + linkified) ---
  const textEl = document.createElement("p");
  textEl.className = "post-text";
  linkifyInto(textEl, post.text, post.urls);
  body.appendChild(textEl);

  // --- Media previews ---
  if (post.media && post.media.length > 0) {
    const grid = createMediaGrid(post.media);
    if (grid) body.appendChild(grid);
  }

  // --- Metric bar ---
  const metrics = document.createElement("div");
  metrics.className = "post-metrics";
  metrics.appendChild(createMetric("reply", post.metrics?.replies, "Replies"));
  metrics.appendChild(createMetric("repost", post.metrics?.reposts, "Reposts"));
  metrics.appendChild(createMetric("like", post.metrics?.likes, "Likes"));
  if (post.metrics?.views !== undefined) {
    metrics.appendChild(createMetric("views", post.metrics.views, "Views"));
  }
  body.appendChild(metrics);

  card.appendChild(body);

  // --- Open on X (host-mediated link opening; degrades gracefully) ---
  const postUrl = `https://x.com/${encodeURIComponent(post.author.username)}/status/${encodeURIComponent(post.id)}`;
  card.addEventListener("click", () => void openExternal(postUrl));
  card.addEventListener("keydown", (e) => {
    // Ignore Enter presses on interactive children (e.g. focused inline
    // links) — their own handlers fire, and acting here would open two links.
    if (e.key === "Enter" && e.target === card) void openExternal(postUrl);
  });

  return card;
}

/** Render a page of posts into the timeline (replace or append). */
function applyPage(payload: FetchPostsPayload, append: boolean) {
  if (!append) {
    state.posts = [];
    state.seenIds.clear();
    timelineEl.replaceChildren();
  }
  state.mode = payload.mode;
  state.nextToken = payload.next_token;

  const fragment = document.createDocumentFragment();
  for (const post of payload.posts) {
    if (state.seenIds.has(post.id)) continue;
    state.seenIds.add(post.id);
    state.posts.push(post);
    fragment.appendChild(createPostCard(post));
  }
  timelineEl.appendChild(fragment);

  renderHeader();
  loadMoreBtn.textContent = "Load more";
  loadMoreBtn.disabled = false;
  showView(state.posts.length === 0 ? "empty" : "timeline");
}

// ---------------------------------------------------------------------------
// Host interactions
// ---------------------------------------------------------------------------

/** Open a URL via the host, guarding on the openLinks capability. */
async function openExternal(url: string) {
  const href = safeHttpUrl(url);
  if (!href) return;
  if (!app.getHostCapabilities()?.openLinks) {
    console.warn("Host does not support opening links; ignoring click:", href);
    return;
  }
  try {
    const { isError } = await app.openLink({ url: href });
    if (isError) console.warn("Host rejected open-link request:", href);
  } catch (e) {
    console.error("openLink failed:", e);
  }
}

/** Call the app-only `fetch_posts` tool and parse its result. */
async function fetchPosts(args: {
  source: TimelineSource;
  query?: string;
  username?: string;
  max_results?: number;
  next_token?: string;
}): Promise<FetchPostsPayload> {
  const result = await app.callServerTool({ name: "fetch_posts", arguments: args });
  if (result.isError) {
    throw new Error(toolErrorText(result) ?? "fetch_posts failed");
  }
  const payload = parsePostsPayload(result);
  if (!payload) {
    throw new Error("fetch_posts returned an invalid payload");
  }
  return payload;
}

// --- Search ---
searchFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = searchInputEl.value.trim();
  if (!query || state.busy) return;

  state.busy = true;
  loadingTextEl.textContent = `Searching for “${query}”…`;
  showView("loading");
  try {
    const payload = await fetchPosts({ source: "search", query });
    state.source = "search";
    state.query = query;
    state.username = undefined;
    applyPage(payload, /* append */ false);
  } catch (err) {
    console.error("Search failed:", err);
    if (state.posts.length > 0) {
      // Keep what we have; surface the failure non-destructively.
      showView("timeline");
      showBanner(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    } else {
      showError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    state.busy = false;
  }
});

// --- Load more (pagination via next_token; appends, never replaces) ---
loadMoreBtn.addEventListener("click", async () => {
  if (!state.nextToken || state.busy) return;
  state.busy = true;
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";
  try {
    const payload = await fetchPosts({
      source: state.source,
      query: state.query,
      username: state.username,
      next_token: state.nextToken,
    });
    applyPage(payload, /* append */ true);
  } catch (err) {
    console.error("Load more failed:", err);
    loadMoreBtn.textContent = "Load more";
    loadMoreBtn.disabled = false;
    showBanner(`Couldn't load more posts: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.busy = false;
  }
});

// ---------------------------------------------------------------------------
// Connect to host
// ---------------------------------------------------------------------------

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
