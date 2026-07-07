/**
 * X Apps Server
 *
 * An MCP Apps server for the X (Twitter) API v2 with an interactive
 * timeline viewer UI.
 *
 * Model-facing tools:
 * - search_posts:     GET /2/tweets/search/recent
 * - get_user:         GET /2/users/by/username/:username
 * - get_user_posts:   GET /2/users/:id/tweets
 * - get_trends:       GET /2/trends/by/woeid/:woeid
 * - display_timeline: fetches posts and renders the timeline viewer UI
 *
 * App-only tool (hidden from the model, called by the viewer iframe):
 * - fetch_posts: search / user-timeline fetch with pagination, used by the
 *   viewer's search box, refresh, and "Load more" button.
 *
 * Modes:
 * - Live mode: `X_BEARER_TOKEN` set → app-only Bearer auth against
 *   https://api.x.com/2. The token is never logged or echoed.
 * - Demo mode: no token, or `X_DEMO=1` → canned dataset so every tool is
 *   fully functional offline (including pagination, 5 posts per page).
 */

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// =============================================================================
// Configuration
// =============================================================================

const X_API_BASE = "https://api.x.com/2";

/** URI of the timeline viewer UI resource (see INTERFACE.md). */
export const RESOURCE_URI = "ui://x-viewer/mcp-app.html";

/** Demo mode pages through the canned set this many posts at a time. */
const DEMO_PAGE_SIZE = 5;

// Works both from source (server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

/** Demo mode is active when there is no bearer token or X_DEMO=1. */
function isDemoMode(): boolean {
  return !process.env.X_BEARER_TOKEN || process.env.X_DEMO === "1";
}

// =============================================================================
// Normalized shapes (single source of truth: INTERFACE.md)
// =============================================================================

export interface XAuthor {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  verified?: boolean;
}

export interface XPost {
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
  media?: Array<{
    type: "photo" | "video" | "animated_gif";
    url?: string;
    preview_image_url?: string;
  }>;
  urls?: Array<{ url: string; expanded_url: string; display_url: string }>;
}

export interface XUserProfile extends XAuthor {
  description?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
  };
}

export interface XTrend {
  trend_name: string;
  tweet_count?: number;
}

/** Result shape shared by search_posts / get_user_posts / fetch_posts. */
interface PostsPage {
  posts: XPost[];
  next_token?: string;
  mode: "live" | "demo";
}

// =============================================================================
// Zod schemas (runtime validators mirroring the interfaces above)
// =============================================================================

const AuthorSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string(),
  profile_image_url: z.string().optional(),
  verified: z.boolean().optional(),
});

const PostSchema = z.object({
  id: z.string(),
  text: z.string(),
  author: AuthorSchema,
  created_at: z.string().describe("ISO 8601 timestamp"),
  metrics: z.object({
    likes: z.number(),
    reposts: z.number(),
    replies: z.number(),
    quotes: z.number(),
    views: z.number().optional(),
  }),
  media: z
    .array(
      z.object({
        type: z.enum(["photo", "video", "animated_gif"]),
        url: z.string().optional(),
        preview_image_url: z.string().optional(),
      }),
    )
    .optional(),
  urls: z
    .array(
      z.object({
        url: z.string(),
        expanded_url: z.string(),
        display_url: z.string(),
      }),
    )
    .optional(),
});

const ModeSchema = z.enum(["live", "demo"]);

const UserProfileSchema = AuthorSchema.extend({
  description: z.string().optional(),
  public_metrics: z
    .object({
      followers_count: z.number(),
      following_count: z.number(),
      tweet_count: z.number(),
    })
    .optional(),
});

const TrendSchema = z.object({
  trend_name: z.string(),
  tweet_count: z.number().optional(),
});

// =============================================================================
// X API v2 client
// =============================================================================

/** Error with a message already suitable for showing to the model/user. */
class XApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

/**
 * GET an X API v2 endpoint with Bearer auth and useful error mapping.
 * `params` values that are undefined are omitted from the query string.
 */
async function xApiGet(
  pathname: string,
  params: Record<string, string | number | undefined> = {},
): Promise<any> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    // Callers gate on isDemoMode() first, so this is a defensive check.
    throw new XApiError(
      "X_BEARER_TOKEN is not set — live X API calls are unavailable.",
    );
  }

  const url = new URL(`${X_API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new XApiError(
      `Network error calling the X API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 401) {
    throw new XApiError(
      "X API authentication failed (401): invalid or missing bearer token. " +
        "Check the X_BEARER_TOKEN environment variable.",
      401,
    );
  }

  if (response.status === 429) {
    // x-rate-limit-reset is a Unix epoch (seconds) when the window resets.
    const reset = response.headers.get("x-rate-limit-reset");
    let when = "";
    if (reset) {
      const resetMs = Number(reset) * 1000;
      if (Number.isFinite(resetMs)) {
        const seconds = Math.max(0, Math.ceil((resetMs - Date.now()) / 1000));
        when = ` Rate limit resets at ${new Date(resetMs).toISOString()} (~${seconds}s from now).`;
      }
    }
    throw new XApiError(`X API rate limit exceeded (429).${when}`, 429);
  }

  if (!response.ok) {
    // X API errors usually carry { title, detail } — surface them when present.
    let detail = "";
    try {
      const body: any = await response.json();
      detail = body?.detail || body?.title || body?.errors?.[0]?.message || "";
    } catch {
      /* non-JSON body — status alone will have to do */
    }
    throw new XApiError(
      `X API request failed (${response.status} ${response.statusText})` +
        (detail ? `: ${detail}` : ""),
      response.status,
    );
  }

  return response.json();
}

/** Field/expansion params shared by every tweet-returning endpoint. */
const TWEET_FIELD_PARAMS = {
  "tweet.fields": "created_at,public_metrics,entities,attachments",
  expansions: "author_id,attachments.media_keys",
  "user.fields": "name,username,profile_image_url,verified",
  "media.fields": "type,url,preview_image_url",
} as const;

/** Map a raw X API user object into the normalized XAuthor shape. */
function mapAuthor(user: any): XAuthor {
  return {
    id: String(user?.id ?? ""),
    name: user?.name ?? "Unknown",
    username: user?.username ?? "unknown",
    ...(user?.profile_image_url
      ? { profile_image_url: user.profile_image_url }
      : {}),
    ...(typeof user?.verified === "boolean"
      ? { verified: user.verified }
      : {}),
  };
}

/**
 * Map a raw X API tweets payload (data + includes.users + includes.media)
 * into normalized XPost[] plus the pagination token from meta.next_token.
 */
function mapTweetsPayload(payload: any): {
  posts: XPost[];
  next_token?: string;
} {
  const tweets: any[] = payload?.data ?? [];
  const usersById = new Map<string, any>(
    (payload?.includes?.users ?? []).map((u: any) => [String(u.id), u]),
  );
  const mediaByKey = new Map<string, any>(
    (payload?.includes?.media ?? []).map((m: any) => [String(m.media_key), m]),
  );

  const posts: XPost[] = tweets.map((tweet) => {
    const rawMetrics = tweet.public_metrics ?? {};

    // Attach expanded media referenced via attachments.media_keys.
    const media = (tweet.attachments?.media_keys ?? [])
      .map((key: string) => mediaByKey.get(String(key)))
      .filter((m: any) => m && ["photo", "video", "animated_gif"].includes(m.type))
      .map((m: any) => ({
        type: m.type as "photo" | "video" | "animated_gif",
        ...(m.url ? { url: m.url } : {}),
        ...(m.preview_image_url
          ? { preview_image_url: m.preview_image_url }
          : {}),
      }));

    // entities.urls includes t.co wrappers for the tweet's own media
    // (display_url "pic.x.com/…" / "pic.twitter.com/…") — skip those, the
    // viewer renders media separately.
    const urls = (tweet.entities?.urls ?? [])
      .filter(
        (u: any) =>
          u?.url &&
          u?.expanded_url &&
          !/^pic\.(x|twitter)\.com/.test(u.display_url ?? ""),
      )
      .map((u: any) => ({
        url: u.url,
        expanded_url: u.expanded_url,
        display_url: u.display_url ?? u.expanded_url,
      }));

    const post: XPost = {
      id: String(tweet.id),
      text: tweet.text ?? "",
      author: mapAuthor(usersById.get(String(tweet.author_id))),
      created_at: tweet.created_at ?? new Date().toISOString(),
      metrics: {
        likes: rawMetrics.like_count ?? 0,
        reposts: rawMetrics.retweet_count ?? 0,
        replies: rawMetrics.reply_count ?? 0,
        quotes: rawMetrics.quote_count ?? 0,
        ...(typeof rawMetrics.impression_count === "number"
          ? { views: rawMetrics.impression_count }
          : {}),
      },
    };
    if (media.length > 0) post.media = media;
    if (urls.length > 0) post.urls = urls;
    return post;
  });

  return { posts, next_token: payload?.meta?.next_token };
}

/** Strip a leading "@" so both "jack" and "@jack" work. */
function normalizeUsername(username: string): string {
  return username.trim().replace(/^@/, "");
}

// =============================================================================
// Demo dataset (module-level, active when !X_BEARER_TOKEN || X_DEMO=1)
// =============================================================================

/** ISO timestamp `hours` hours before module load — keeps demo posts fresh. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/**
 * Demo author profiles. Some deliberately have NO profile_image_url so the
 * viewer's colored-initial avatar fallback is exercised.
 */
const DEMO_USERS: XUserProfile[] = [
  {
    id: "1146602870",
    name: "Dr. Elena Vasquez",
    username: "astro_elena",
    profile_image_url:
      "https://pbs.twimg.com/profile_images/1729384756201349120/eV4kQz9c_normal.jpg",
    verified: true,
    description:
      "Astrophysicist @ ESO. Exoplanet atmospheres, JWST spectroscopy. Views are my own, orbits are Kepler's.",
    public_metrics: {
      followers_count: 184203,
      following_count: 512,
      tweet_count: 9421,
    },
  },
  {
    id: "88231404",
    name: "Marcus Chen",
    username: "marcusbuilds",
    // No profile_image_url — exercises the avatar fallback path.
    description:
      "Indie dev. Shipping small tools in public. Previously infra @ a big co.",
    public_metrics: {
      followers_count: 23417,
      following_count: 890,
      tweet_count: 15230,
    },
  },
  {
    id: "2244994945",
    name: "Priya Raghavan",
    username: "priya_ml",
    profile_image_url:
      "https://pbs.twimg.com/profile_images/1683902412887746560/8yBq2LtA_normal.jpg",
    verified: true,
    description:
      "ML researcher. Mixture-of-experts, efficient inference. Papers > hot takes.",
    public_metrics: {
      followers_count: 96780,
      following_count: 301,
      tweet_count: 4102,
    },
  },
  {
    id: "15804774",
    name: "Tom Osterberg",
    username: "tomo_kernel",
    // No profile_image_url — exercises the avatar fallback path.
    description: "Linux kernel developer. io_uring, schedulers, coffee.",
    public_metrics: {
      followers_count: 41022,
      following_count: 233,
      tweet_count: 22841,
    },
  },
  {
    id: "3108351",
    name: "Quanta Signals",
    username: "quantasignals",
    profile_image_url:
      "https://pbs.twimg.com/profile_images/1590000123456789012/Qs7pLm2N_normal.jpg",
    verified: true,
    description:
      "Daily signal from physics, math, and computer science research.",
    public_metrics: {
      followers_count: 512340,
      following_count: 87,
      tweet_count: 31200,
    },
  },
  {
    id: "742143",
    name: "Jia Park",
    username: "jiaparkdev",
    // No profile_image_url — exercises the avatar fallback path.
    description: "Frontend engineer. CSS is a programming language, fight me.",
    public_metrics: {
      followers_count: 18932,
      following_count: 1204,
      tweet_count: 8764,
    },
  },
  {
    id: "6253282",
    name: "Dr. Samuel Okoye",
    username: "sam_okoye",
    profile_image_url:
      "https://pbs.twimg.com/profile_images/1655501234567890123/sOk3yE9d_normal.jpg",
    verified: true,
    description:
      "Climate scientist. Sea ice, ocean heat content, and why both matter.",
    public_metrics: {
      followers_count: 77105,
      following_count: 645,
      tweet_count: 12980,
    },
  },
  {
    id: "9204812",
    name: "Lena Fischer",
    username: "lenafischer_",
    // No profile_image_url — exercises the avatar fallback path.
    description: "Robotics PhD candidate. Making robot hands less clumsy.",
    public_metrics: {
      followers_count: 9412,
      following_count: 388,
      tweet_count: 2201,
    },
  },
];

/** Look up a demo user profile by username (case-insensitive). */
function demoUser(username: string): XUserProfile | undefined {
  const wanted = normalizeUsername(username).toLowerCase();
  return DEMO_USERS.find((u) => u.username.toLowerCase() === wanted);
}

/** Author-only view of a demo user (drops profile fields). */
function demoAuthor(username: string): XAuthor {
  const user = demoUser(username)!;
  const { description: _d, public_metrics: _m, ...author } = user;
  return author;
}

/** Ten realistic demo posts, newest first, spread over recent hours/days. */
const DEMO_POSTS: XPost[] = [
  {
    id: "1876543210987654401",
    text: "New JWST NIRSpec data on WASP-39b just dropped. The CO2 feature at 4.3µm is even cleaner than in the ERS release — atmospheric metallicity looks ~10x solar. Full spectrum below. 🔭",
    author: demoAuthor("astro_elena"),
    created_at: hoursAgo(2),
    metrics: { likes: 4821, reposts: 1203, replies: 312, quotes: 98, views: 812345 },
    media: [
      {
        type: "photo",
        url: "https://pbs.twimg.com/media/GXk4v2WbEAA1a2b?format=jpg&name=large",
        preview_image_url:
          "https://pbs.twimg.com/media/GXk4v2WbEAA1a2b?format=jpg&name=medium",
      },
    ],
  },
  {
    id: "1876543210987654402",
    text: "Shipped tinylog v0.4 — structured logging for CLIs in a single 8KB file, zero deps. Now with span timing and NDJSON output. Repo here: https://t.co/9xQz2LmA1b",
    author: demoAuthor("marcusbuilds"),
    created_at: hoursAgo(3.5),
    metrics: { likes: 356, reposts: 62, replies: 41, quotes: 8, views: 28904 },
    urls: [
      {
        url: "https://t.co/9xQz2LmA1b",
        expanded_url: "https://github.com/marcusbuilds/tinylog",
        display_url: "github.com/marcusbuilds/t…",
      },
    ],
  },
  {
    id: "1876543210987654403",
    text: "Our new paper is out: routing collapse in sparse MoE models is mostly an optimizer artifact, not a capacity problem. A 2-line fix to the router LR schedule recovers 94% of expert utilization. Preprint: https://t.co/4kPz8WnB2c",
    author: demoAuthor("priya_ml"),
    created_at: hoursAgo(5),
    metrics: { likes: 2103, reposts: 587, replies: 164, quotes: 121, views: 340211 },
    urls: [
      {
        url: "https://t.co/4kPz8WnB2c",
        expanded_url: "https://arxiv.org/abs/2506.11482",
        display_url: "arxiv.org/abs/2506.11482",
      },
    ],
  },
  {
    id: "1876543210987654404",
    text: "io_uring in 6.16: zero-copy receive finally lands for TCP. Early numbers on our test rig show 38% less CPU at 100Gbps line rate. A decade of plumbing for this moment.",
    author: demoAuthor("tomo_kernel"),
    created_at: hoursAgo(8),
    metrics: { likes: 1876, reposts: 412, replies: 203, quotes: 45, views: 195023 },
  },
  {
    id: "1876543210987654405",
    text: "Researchers demonstrate 1.2-millisecond quantum coherence in a silicon spin qubit at 1.5K — no dilution refrigerator required. If it replicates, this changes the cost curve for scaling. 🧪",
    author: demoAuthor("quantasignals"),
    created_at: hoursAgo(12),
    metrics: { likes: 6540, reposts: 2210, replies: 388, quotes: 260, views: 1204567 },
    media: [
      {
        type: "photo",
        url: "https://pbs.twimg.com/media/GXj8r5TaMAEq9pV?format=jpg&name=large",
        preview_image_url:
          "https://pbs.twimg.com/media/GXj8r5TaMAEq9pV?format=jpg&name=medium",
      },
    ],
  },
  {
    id: "1876543210987654406",
    text: "CSS anchor positioning is now in all three engines. We can finally delete 400 lines of tooltip-placement JavaScript and replace it with 6 lines of CSS. What a time to be alive.",
    author: demoAuthor("jiaparkdev"),
    created_at: hoursAgo(18),
    metrics: { likes: 3204, reposts: 845, replies: 97, quotes: 66, views: 412876 },
  },
  {
    id: "1876543210987654407",
    text: "Antarctic sea-ice extent is tracking 1.9M km² below the 1981–2010 median for the third consecutive winter. This is no longer an outlier — it's a regime shift. Our analysis in @Nature this week: https://t.co/7mRt3KcD5e",
    author: demoAuthor("sam_okoye"),
    created_at: hoursAgo(26),
    metrics: { likes: 5112, reposts: 2890, replies: 641, quotes: 402, views: 987654 },
    urls: [
      {
        url: "https://t.co/7mRt3KcD5e",
        expanded_url:
          "https://www.nature.com/articles/s41586-026-04412-1",
        display_url: "nature.com/articles/s4158…",
      },
    ],
  },
  {
    id: "1876543210987654408",
    text: "Our robot hand just buttoned a shirt for the first time. 27 attempts, 1 success, and I cried a little. Tactile-feedback policy trained entirely in sim. Video from the lab:",
    author: demoAuthor("lenafischer_"),
    created_at: hoursAgo(34),
    metrics: { likes: 8931, reposts: 1764, replies: 289, quotes: 154, views: 1567890 },
    media: [
      {
        type: "video",
        preview_image_url:
          "https://pbs.twimg.com/ext_tw_video_thumb/1876543098765432107/pu/img/kL9mNo2Pq.jpg",
      },
    ],
  },
  {
    id: "1876543210987654409",
    text: "PSA for observers: the ESO archive now serves calibrated MUSE cubes within 24h of observation. No more reducing your own data at 2am before a proposal deadline. This quietly fixes half of astronomy's reproducibility problem.",
    author: demoAuthor("astro_elena"),
    created_at: hoursAgo(47),
    metrics: { likes: 1420, reposts: 388, replies: 76, quotes: 22, views: 156789 },
  },
  {
    id: "1876543210987654410",
    text: "Spent the weekend profiling instead of guessing. The 'slow database' was a JSON serializer called in a loop. It is ALWAYS a serializer called in a loop. Measure first, friends.",
    author: demoAuthor("marcusbuilds"),
    created_at: hoursAgo(60),
    metrics: { likes: 2764, reposts: 531, replies: 148, quotes: 89, views: 389012 },
  },
];

/** ~8 plausible demo trends for get_trends. */
const DEMO_TRENDS: XTrend[] = [
  { trend_name: "#OpenSource", tweet_count: 125400 },
  { trend_name: "JWST", tweet_count: 88200 },
  { trend_name: "#MachineLearning", tweet_count: 74600 },
  { trend_name: "Quantum Computing", tweet_count: 51300 },
  { trend_name: "Linux 6.16", tweet_count: 32800 },
  { trend_name: "Starship", tweet_count: 141900 },
  { trend_name: "#ClimateAction", tweet_count: 46100 },
  { trend_name: "CRISPR" }, // no tweet_count — exercises the optional field
];

/**
 * Page through a demo post list DEMO_PAGE_SIZE at a time using an opaque
 * token of the form "demo-page-N" (N is the 1-based page to return next).
 */
function demoPaginate(posts: XPost[], nextToken?: string): PostsPage {
  let page = 1;
  const match = nextToken?.match(/^demo-page-(\d+)$/);
  if (match) page = Math.max(1, parseInt(match[1], 10));

  const offset = (page - 1) * DEMO_PAGE_SIZE;
  const slice = posts.slice(offset, offset + DEMO_PAGE_SIZE);
  const hasMore = offset + DEMO_PAGE_SIZE < posts.length;

  return {
    posts: slice,
    ...(hasMore ? { next_token: `demo-page-${page + 1}` } : {}),
    mode: "demo",
  };
}

/**
 * Demo search: match query words (whole words, so short terms like "ai"
 * don't match inside "trained") against post text and author fields.
 * Falls back to the full canned set when nothing matches, so the viewer's
 * search box always has something to render offline.
 */
function demoSearch(query: string): XPost[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(
      (t) =>
        new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    );
  if (terms.length === 0) return DEMO_POSTS;

  const matches = DEMO_POSTS.filter((post) => {
    const haystack =
      `${post.text} ${post.author.name} ${post.author.username}`.toLowerCase();
    return terms.some((term) => term.test(haystack));
  });
  return matches.length > 0 ? matches : DEMO_POSTS;
}

/**
 * Demo user timeline: posts authored by the username, or the full canned
 * set for unknown usernames (keeps the viewer functional offline).
 */
function demoUserPosts(username: string): XPost[] {
  const wanted = normalizeUsername(username).toLowerCase();
  const matches = DEMO_POSTS.filter(
    (post) => post.author.username.toLowerCase() === wanted,
  );
  return matches.length > 0 ? matches : DEMO_POSTS;
}

// =============================================================================
// Shared post-fetching (used by search_posts / get_user_posts /
// display_timeline / fetch_posts so all four behave identically)
// =============================================================================

async function fetchPostsForSource(args: {
  source: "search" | "user";
  query?: string;
  username?: string;
  max_results?: number;
  next_token?: string;
}): Promise<PostsPage> {
  const { source, query, username, max_results = 10, next_token } = args;

  if (source === "search" && !query) {
    throw new XApiError('source "search" requires a `query`.');
  }
  if (source === "user" && !username) {
    throw new XApiError('source "user" requires a `username`.');
  }

  if (isDemoMode()) {
    const posts =
      source === "search" ? demoSearch(query!) : demoUserPosts(username!);
    return demoPaginate(posts, next_token);
  }

  if (source === "search") {
    const payload = await xApiGet("/tweets/search/recent", {
      query: query!,
      max_results,
      next_token,
      ...TWEET_FIELD_PARAMS,
    });
    return { ...mapTweetsPayload(payload), mode: "live" };
  }

  // source === "user": resolve the username to an id, then fetch the timeline.
  const handle = normalizeUsername(username!);
  const userPayload = await xApiGet(
    `/users/by/username/${encodeURIComponent(handle)}`,
  );
  const userId = userPayload?.data?.id;
  if (!userId) {
    throw new XApiError(`X user not found: @${handle}`);
  }
  const payload = await xApiGet(`/users/${userId}/tweets`, {
    max_results,
    // The user-timeline endpoint calls its pagination cursor pagination_token
    // (search calls it next_token); we normalize both to next_token outward.
    pagination_token: next_token,
    ...TWEET_FIELD_PARAMS,
  });
  return { ...mapTweetsPayload(payload), mode: "live" };
}

// =============================================================================
// Result helpers
// =============================================================================

/** Uniform failure result: clear text + isError, never a thrown exception. */
function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Compact human-readable digest of a posts page for text content. */
function summarizePosts(page: PostsPage, heading: string): string {
  const lines = page.posts.map((post) => {
    const text =
      post.text.length > 100 ? `${post.text.slice(0, 100)}…` : post.text;
    return `- @${post.author.username} (${post.metrics.likes} likes): ${text.replace(/\s+/g, " ")}`;
  });
  const modeNote = page.mode === "demo" ? " [demo data]" : "";
  // Note: next_token is surfaced only in structuredContent. The model-facing
  // tools (search_posts / get_user_posts) accept no next_token input, so a
  // textual "more available via next_token" hint would invite invalid calls.
  return `${heading}${modeNote}\n${lines.join("\n")}`;
}

// =============================================================================
// MCP Server Factory
// =============================================================================

// Cached across createServer() calls — in stateless HTTP deployments a fresh
// server is created per request and per-instance caches would be useless.
let cachedAppHtml: string | undefined;

/**
 * Creates a new MCP server instance with all X tools and the timeline
 * viewer UI resource registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "X Apps Server",
    version: "1.0.0",
  });

  // Shared input fragment: max_results per the X API search window (10–100).
  const maxResultsSchema = z
    .number()
    .int()
    .min(10)
    .max(100)
    .default(10)
    .describe("Number of posts to return (10–100, default 10)");

  // ---------------------------------------------------------------------------
  // Tool 1: search_posts — recent post search
  // ---------------------------------------------------------------------------
  server.registerTool(
    "search_posts",
    {
      title: "Search Posts",
      description:
        "Search recent X (Twitter) posts by keyword/query. Returns normalized posts with " +
        "author, metrics, media and URLs. Use display_timeline instead when the user wants " +
        "to SEE the posts in an interactive viewer.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Search query (X search syntax supported in live mode)"),
        max_results: maxResultsSchema,
      },
      outputSchema: {
        posts: z.array(PostSchema),
        next_token: z
          .string()
          .optional()
          .describe("Opaque pagination token for the next page"),
        mode: ModeSchema,
      },
    },
    async ({ query, max_results }): Promise<CallToolResult> => {
      try {
        const page = await fetchPostsForSource({
          source: "search",
          query,
          max_results,
        });
        return {
          content: [
            {
              type: "text",
              text: summarizePosts(
                page,
                `Found ${page.posts.length} posts for "${query}":`,
              ),
            },
          ],
          structuredContent: page as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 2: get_user — user profile lookup
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_user",
    {
      title: "Get User",
      description:
        "Look up an X (Twitter) user profile by username (with or without the leading @). " +
        "Returns name, avatar, verification status, bio and follower counts.",
      inputSchema: {
        username: z.string().min(1).describe("X username, e.g. 'nasa' or '@nasa'"),
      },
      outputSchema: {
        user: UserProfileSchema,
      },
    },
    async ({ username }): Promise<CallToolResult> => {
      try {
        const handle = normalizeUsername(username);
        let user: XUserProfile;

        if (isDemoMode()) {
          // Return the matching demo author, or a plausible generic profile.
          user = demoUser(handle) ?? {
            id: "1000000000000000000",
            name: handle,
            username: handle,
            description: "Demo profile (no X_BEARER_TOKEN configured).",
            public_metrics: {
              followers_count: 1234,
              following_count: 256,
              tweet_count: 789,
            },
          };
        } else {
          const payload = await xApiGet(
            `/users/by/username/${encodeURIComponent(handle)}`,
            {
              "user.fields":
                "name,username,profile_image_url,verified,description,public_metrics",
            },
          );
          const data = payload?.data;
          if (!data) throw new XApiError(`X user not found: @${handle}`);
          user = {
            ...mapAuthor(data),
            ...(data.description ? { description: data.description } : {}),
            ...(data.public_metrics
              ? {
                  public_metrics: {
                    followers_count: data.public_metrics.followers_count ?? 0,
                    following_count: data.public_metrics.following_count ?? 0,
                    tweet_count: data.public_metrics.tweet_count ?? 0,
                  },
                }
              : {}),
          };
        }

        const followers = user.public_metrics?.followers_count;
        const text =
          `@${user.username} — ${user.name}` +
          (user.verified ? " (verified)" : "") +
          (followers !== undefined
            ? `, ${followers.toLocaleString()} followers`
            : "") +
          (user.description ? `. ${user.description}` : "") +
          (isDemoMode() ? " [demo data]" : "");

        return {
          content: [{ type: "text", text }],
          structuredContent: { user } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 3: get_user_posts — a user's recent posts
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_user_posts",
    {
      title: "Get User Posts",
      description:
        "Fetch recent posts from an X (Twitter) user's timeline by username. " +
        "Use display_timeline instead when the user wants to SEE the posts in an interactive viewer.",
      inputSchema: {
        username: z.string().min(1).describe("X username, e.g. 'nasa' or '@nasa'"),
        max_results: maxResultsSchema,
      },
      outputSchema: {
        posts: z.array(PostSchema),
        next_token: z
          .string()
          .optional()
          .describe("Opaque pagination token for the next page"),
        mode: ModeSchema,
      },
    },
    async ({ username, max_results }): Promise<CallToolResult> => {
      try {
        const page = await fetchPostsForSource({
          source: "user",
          username,
          max_results,
        });
        return {
          content: [
            {
              type: "text",
              text: summarizePosts(
                page,
                `Latest ${page.posts.length} posts from @${normalizeUsername(username)}:`,
              ),
            },
          ],
          structuredContent: page as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 4: get_trends — trending topics by location
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_trends",
    {
      title: "Get Trends",
      description:
        "Get trending topics on X (Twitter) for a location identified by WOEID " +
        "(Where On Earth ID). Default WOEID 1 is worldwide.",
      inputSchema: {
        woeid: z
          .number()
          .int()
          .default(1)
          .describe("Where On Earth ID (default 1 = worldwide)"),
      },
      outputSchema: {
        trends: z.array(TrendSchema),
        mode: ModeSchema,
      },
    },
    async ({ woeid }): Promise<CallToolResult> => {
      try {
        let trends: XTrend[];
        let mode: "live" | "demo";

        if (isDemoMode()) {
          trends = DEMO_TRENDS;
          mode = "demo";
        } else {
          const payload = await xApiGet(`/trends/by/woeid/${woeid}`);
          trends = (payload?.data ?? []).map((t: any) => ({
            trend_name: t.trend_name ?? String(t.name ?? ""),
            ...(typeof t.tweet_count === "number"
              ? { tweet_count: t.tweet_count }
              : {}),
          }));
          mode = "live";
        }

        const lines = trends.map(
          (t) =>
            `- ${t.trend_name}` +
            (t.tweet_count !== undefined
              ? ` (${t.tweet_count.toLocaleString()} posts)`
              : ""),
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Trending (WOEID ${woeid})${mode === "demo" ? " [demo data]" : ""}:\n` +
                lines.join("\n"),
            },
          ],
          structuredContent: { trends, mode } as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 5: display_timeline — THE app tool (renders the viewer UI)
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "display_timeline",
    {
      title: "Display Timeline",
      description:
        "Show X (Twitter) posts in an interactive timeline viewer. Fetches posts " +
        "server-side from a search query or a user's timeline and renders them as " +
        "cards with avatars, media, and engagement metrics. Prefer this over " +
        "search_posts/get_user_posts whenever the user wants to look at posts.",
      inputSchema: {
        source: z
          .enum(["search", "user"])
          .describe('"search" for a keyword search, "user" for a user timeline'),
        query: z
          .string()
          .optional()
          .describe('Search query (required when source is "search")'),
        username: z
          .string()
          .optional()
          .describe('X username (required when source is "user")'),
        max_results: maxResultsSchema.optional(),
      },
      outputSchema: z.object({
        source: z.enum(["search", "user"]),
        query: z.string().optional(),
        username: z.string().optional(),
        posts: z.array(PostSchema),
        next_token: z.string().optional(),
        mode: ModeSchema,
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ source, query, username, max_results }): Promise<CallToolResult> => {
      try {
        const page = await fetchPostsForSource({
          source,
          query,
          username,
          max_results,
        });

        const label =
          source === "search"
            ? `search "${query}"`
            : `@${normalizeUsername(username!)}`;
        const structuredContent = {
          source,
          ...(query !== undefined ? { query } : {}),
          ...(username !== undefined
            ? { username: normalizeUsername(username) }
            : {}),
          posts: page.posts,
          ...(page.next_token ? { next_token: page.next_token } : {}),
          mode: page.mode,
        };

        return {
          content: [
            {
              type: "text",
              text: `Showing ${page.posts.length} posts for ${label}${page.mode === "demo" ? " (demo data)" : ""}.`,
            },
          ],
          structuredContent: structuredContent as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 6: fetch_posts — app-only (hidden from the model)
  // Used by the viewer iframe for its search box, refresh, and "Load more".
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "fetch_posts",
    {
      title: "Fetch Posts",
      description:
        "Fetch a page of X posts for the timeline viewer (search or user timeline, " +
        "with pagination). The model should NOT call this tool directly.",
      inputSchema: {
        source: z
          .enum(["search", "user"])
          .describe('"search" for a keyword search, "user" for a user timeline'),
        query: z
          .string()
          .optional()
          .describe('Search query (required when source is "search")'),
        username: z
          .string()
          .optional()
          .describe('X username (required when source is "user")'),
        max_results: maxResultsSchema.optional(),
        next_token: z
          .string()
          .optional()
          .describe("Pagination token from a previous result"),
      },
      outputSchema: z.object({
        posts: z.array(PostSchema),
        next_token: z.string().optional(),
        mode: ModeSchema,
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({
      source,
      query,
      username,
      max_results,
      next_token,
    }): Promise<CallToolResult> => {
      try {
        const page = await fetchPostsForSource({
          source,
          query,
          username,
          max_results,
          next_token,
        });
        return {
          content: [
            {
              type: "text",
              text: `Fetched ${page.posts.length} posts (${page.mode} mode)${page.next_token ? ", more available" : ""}.`,
            },
          ],
          structuredContent: page as any,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // UI resource: the bundled timeline viewer HTML
  // ---------------------------------------------------------------------------
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = (cachedAppHtml ??= await fs.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      ));
      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  // Avatars and media previews are <img> loads from X's CDN
                  // → resourceDomains. connectDomains kept in sync per the
                  // interface contract.
                  connectDomains: ["https://pbs.twimg.com"],
                  resourceDomains: [
                    "https://pbs.twimg.com",
                    "https://abs.twimg.com",
                  ],
                },
              },
            },
          },
        ],
      };
    },
  );

  return server;
}
