import { z } from "zod";

/** A project-bound Collector credential, supplied only by host configuration. */
export interface CollectorAccess {
  readonly project: string;
  readonly apiKey: string;
}

const headerValue = z.string().min(1).regex(/^[\x20-\x7e]+$/u)
  .refine((value) => value === value.trim());
const ProjectsSchema = z.array(z.strictObject({
  project: headerValue,
  apiKey: headerValue,
  subjects: z.array(z.string().min(1).refine((value) => value === value.trim())).min(1),
})).min(1);

/** Safe to return to a caller; never includes subjects, projects or credentials. */
export class CollectorAccessError extends Error {
  constructor() {
    super("No Collector project is assigned to this account. Contact the qyl operator.");
    this.name = "CollectorAccessError";
  }
}

/**
 * Opt-in subject-to-project access. Absence retains the single-project setup;
 * present-but-invalid configuration and unassigned callers never fall back.
 * Values stay in the host's secret configuration, not in tool arguments.
 */
export function readCollectorProjects(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<string, CollectorAccess> | undefined {
  const raw = environment["MCP_COLLECTOR_PROJECTS"];
  if (raw === undefined) return undefined;
  let parsed: z.infer<typeof ProjectsSchema>;
  try {
    parsed = ProjectsSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("MCP_COLLECTOR_PROJECTS must be a valid nonempty project access configuration");
  }

  const accessBySubject = new Map<string, CollectorAccess>();
  const projects = new Set<string>();
  const credentials = new Set<string>();
  for (const entry of parsed) {
    if (projects.has(entry.project) || credentials.has(entry.apiKey)) {
      throw new Error("MCP_COLLECTOR_PROJECTS contains a duplicate project or credential");
    }
    projects.add(entry.project);
    credentials.add(entry.apiKey);
    const access = Object.freeze({ project: entry.project, apiKey: entry.apiKey });
    for (const subject of entry.subjects) {
      if (accessBySubject.has(subject)) {
        throw new Error("MCP_COLLECTOR_PROJECTS assigns a subject more than once");
      }
      accessBySubject.set(subject, access);
    }
  }
  return accessBySubject;
}

/** Pass only the subject from verified SDK AuthInfo, never request metadata. */
export function collectorAccessForSubject(
  subject: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CollectorAccess | undefined {
  const projects = readCollectorProjects(environment);
  if (projects === undefined) return undefined;
  const access = typeof subject === "string" ? projects.get(subject) : undefined;
  if (access === undefined) throw new CollectorAccessError();
  return access;
}
