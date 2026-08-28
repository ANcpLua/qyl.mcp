/**
 * Deterministic post-build verifier for hosted deployment guidance.
 *
 * The root README is the operator-facing source for deployment and OAuth
 * configuration. The public landing page, however, is served from the Vite
 * output in dist/, not from mcp-home.html. Checking the canonical deployment
 * section together with the shipped HTML catches both prose drift and a build
 * that publishes guidance different from its source.
 *
 * Run after `npm run build --workspace server`.
 */
import { readFile } from "node:fs/promises";

const builtLandingUrl = new URL("dist/mcp-home.html", import.meta.url);
const deploymentReadmeUrl = new URL("../README.md", import.meta.url);

const [builtLandingHtml, deploymentReadme] = await Promise.all([
  readRequiredBuildArtifact(builtLandingUrl, "public landing page"),
  readFile(deploymentReadmeUrl, "utf8"),
]);

const deploymentGuidance = markdownSection(deploymentReadme, "Deploying your own");
const failures = [];

requireMatch(
  "built landing page",
  builtLandingHtml,
  /Grant <code>qyl:control<\/code> separately to named clients/u,
  "must tell operators to grant qyl:control separately to named clients",
);
requireMatch(
  "built landing page",
  builtLandingHtml,
  /2026-07-28/u,
  "must name the only protocol revision the endpoint serves",
);
forbidMatch(
  "built landing page",
  builtLandingHtml,
  /stateless/iu,
  "must not describe the endpoint by the SDK's rejected legacy serving mode",
);

requireMatch(
  "deployment README",
  deploymentGuidance,
  /leave this out of the defaults/u,
  "must keep qyl:control out of the defaults",
);
requireMatch(
  "deployment README",
  deploymentGuidance,
  /Self-registering clients remain read-only by default/u,
  "must state the effective default client posture",
);
requireMatch(
  "deployment README",
  deploymentGuidance,
  /Dynamic Client Registration is open/u,
  "must disclose that Dynamic Client Registration is open",
);
requireMatch(
  "deployment README",
  deploymentGuidance,
  /dynamic_client_registration_security_mode` to `strict/u,
  "must name Auth0's strict DCR control",
);
requireMatch(
  "deployment README",
  deploymentGuidance,
  /traces, logs, sessions, and CI evidence/u,
  "must enumerate the evidence exposed by an open read grant",
);
requireMatch(
  "deployment README",
  deploymentGuidance,
  /accepts only the qyl production Auth0 issuer/u,
  "must state that arbitrary OAuth issuers are rejected",
);
forbidMatch(
  "deployment README",
  deploymentGuidance,
  /Grant both as the API's default/u,
  "must not grant qyl:control through the default third-party permission set",
);

if (failures.length > 0) {
  throw new Error(
    `verify:deployment-guidance failed (${failures.length} problem(s)):\n\n`
      + failures.map((failure) => `  - ${failure}`).join("\n")
      + "\n\n  Update the canonical deployment guidance and rebuild the server before retrying.",
  );
}

console.log(
  "verify:deployment-guidance: built landing page and deployment README preserve "
    + "separate workflow control, pinned issuer guidance, and the open-DCR warning.",
);

async function readRequiredBuildArtifact(url, label) {
  try {
    return await readFile(url, "utf8");
  } catch (cause) {
    throw missingBuildArtifact(label, url, cause);
  }
}

function missingBuildArtifact(label, url, cause) {
  return new Error(
    `verify:deployment-guidance: ${label} is unavailable at ${url.pathname}; `
      + "run the server build before this post-build verifier",
    { cause },
  );
}

function markdownSection(markdown, heading) {
  const headingPattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "mu");
  const match = headingPattern.exec(markdown);
  if (match === null) {
    throw new Error(`verify:deployment-guidance: README.md has no \"## ${heading}\" section`);
  }

  const start = match.index + match[0].length;
  const followingHeading = /^##\s+/mu.exec(markdown.slice(start));
  const end = followingHeading === null ? markdown.length : start + followingHeading.index;
  return markdown.slice(start, end).replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requireMatch(surface, content, pattern, requirement) {
  if (!pattern.test(content)) failures.push(`${surface} ${requirement}`);
}

function forbidMatch(surface, content, pattern, requirement) {
  if (pattern.test(content)) failures.push(`${surface} ${requirement}`);
}
