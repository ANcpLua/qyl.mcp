/**
 * Skills served by this server: the `io.modelcontextprotocol/skills` extension
 * (SEP-2640), in the static subset the OpenAI plugin portal imports when it
 * scans the server. `skills/list` publishes the catalog, `skills/get` one entry,
 * and every file of a skill is an ordinary `resources/read` under a `skill://`
 * URI whose text hashes to the digest the catalog advertised.
 *
 * The files live in `dist/skills/<name>/` (copied there by the build from the
 * repository's shared `submission/qyl/skills`, the same files the Anthropic and
 * OpenAI plugin bundles ship), so the server, both directories and the npm
 * package carry one skill. The directory name must equal the skill's
 * front-matter `name`; the portal rejects a mismatch.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { McpServer, ServerCapabilities } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** `skill://<server>/<skill>/<path>`: the server segment names this server. */
const SKILL_URI_PREFIX = "skill://qyl/";
const SKILLS_DIR = path.join(import.meta.dirname, "skills");

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".txt": "text/plain",
};

export interface SkillResource {
  readonly uri: string;
  readonly digest: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface Skill {
  /** The `SKILL.md` URI; it identifies the skill in `skills/get`. */
  readonly uri: string;
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly resources: readonly SkillResource[];
}

const ListParamsSchema = z.looseObject({ cursor: z.string().optional() });
const GetParamsSchema = z.looseObject({ uri: z.string() });

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

/** `sha256:` plus 64 lowercase hex digits over the UTF-8 bytes, as the portal recomputes it. */
export function skillDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * The YAML front matter between the leading `---` lines, as flat string pairs.
 * A skill's front matter is `name` and `description`; nested YAML is not a
 * front-matter shape this server publishes, so a line without `key: value`
 * is a build error, not a silently dropped field.
 */
export function parseFrontmatter(markdown: string, file: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (match === null) throw new Error(`${file} has no YAML front matter`);
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (pair === null) throw new Error(`${file} front matter line is not "key: value": ${line}`);
    const value = pair[2].trim();
    frontmatter[pair[1]] = /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value;
  }
  if (!frontmatter["name"] || !frontmatter["description"]) {
    throw new Error(`${file} front matter needs name and description`);
  }
  return frontmatter;
}

function listFiles(directory: string, relative = ""): string[] {
  return readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    return entry.isDirectory() ? listFiles(directory, child) : [child];
  });
}

/** Reads every skill under `directory`; a missing directory is no skills. */
export function loadSkills(directory = SKILLS_DIR): Skill[] {
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const root = path.join(directory, name);
    const skillFile = path.join(root, "SKILL.md");
    const frontmatter = parseFrontmatter(readFileSync(skillFile, "utf8"), skillFile);
    if (frontmatter["name"] !== name) {
      throw new Error(`${skillFile}: front matter name "${frontmatter["name"]}" must equal the directory name "${name}"`);
    }
    const resources = listFiles(root).sort().map((file): SkillResource => {
      const text = readFileSync(path.join(root, file), "utf8");
      return {
        uri: `${SKILL_URI_PREFIX}${name}/${file}`,
        digest: skillDigest(text),
        mimeType: MIME_BY_EXTENSION[path.extname(file)] ?? "text/plain",
        text,
      };
    });
    return { uri: `${SKILL_URI_PREFIX}${name}/SKILL.md`, frontmatter, resources };
  });
}

function catalogEntry(skill: Skill): {
  uri: string;
  frontmatter: Record<string, string>;
  resources: { uri: string; digest: string }[];
} {
  return {
    uri: skill.uri,
    frontmatter: { ...skill.frontmatter },
    resources: skill.resources.map(({ uri, digest }) => ({ uri, digest })),
  };
}

// createServer() runs per hosted request; the files are read once per process.
let bundled: Skill[] | undefined;
function bundledSkills(): Skill[] {
  bundled ??= loadSkills();
  return bundled;
}

/** Advertise the extension, answer its two methods and serve every skill file as a resource. */
export function registerSkills(server: McpServer, skills: readonly Skill[] = bundledSkills()): void {
  // ServerCapabilities has no `extensions` key in the SDK yet; `server/discover` passes it through.
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} } } as unknown as ServerCapabilities);
  server.server.setRequestHandler("skills/list", { params: ListParamsSchema }, (params) => {
    // One page holds the whole catalog; a cursor can only be stale.
    if (params.cursor !== undefined) throw invalidParams("skills/list has a single page; omit cursor");
    return { skills: skills.map(catalogEntry) };
  });
  server.server.setRequestHandler("skills/get", { params: GetParamsSchema }, (params) => {
    const skill = skills.find((candidate) => candidate.uri === params.uri);
    if (skill === undefined) throw invalidParams(`unknown skill ${params.uri}`);
    return { skill: catalogEntry(skill) };
  });
  for (const skill of skills) {
    for (const resource of skill.resources) {
      server.registerResource(
        resource.uri,
        resource.uri,
        {
          title: `${skill.frontmatter["name"]} skill: ${path.basename(resource.uri)}`,
          description: resource.uri === skill.uri
            ? skill.frontmatter["description"]
            : `Supporting file of the ${skill.frontmatter["name"]} skill.`,
          mimeType: resource.mimeType,
        },
        () => ({ contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] }),
      );
    }
  }
}
