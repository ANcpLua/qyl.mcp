---
name: grounding-audit
description: Verify claims a repo makes about itself — doc comments, examples, README snippets, inline "this never happens" comments, test assertions on wording, CHANGELOG statements — against what the code and its dependencies actually do. Classify each as true, lie, stale, or unverifiable, fix them, and restructure so the same lie cannot recur. Use this whenever a comment asserts library or framework behavior, whenever a defensive check or workaround is justified by a comment rather than by a reproduction, after any refactor or dependency upgrade that changed observable behavior, when a test asserts prose instead of structure, and any time something reads plausible but you cannot verify it without looking. Reach for it especially when reviewing AI-written code, which states mechanisms confidently and is right about them only sometimes.
license: MIT
metadata:
  author: Alex + Codex
  version: "2.0.0"
  origin: |
    dotcov sweep, 2026-07-30 — a ToString doc-example showed a format the method
    never produced in any version.
    qyl.mcp review, 2026-08-20 — a doc comment asserted an SDK constructor
    behavior to justify a runtime guard; the constructor never took that
    argument in this codebase, so the guard could not fire. v2 exists because
    v1 could only check claims against local code, and this claim was about a
    third-party library.
---

# Grounding Audit

You are auditing **claims about the code, not the code itself**.

A repository holds two kinds of text: code, which does what it does, and assertions *about*
the code — doc comments, examples, README API sketches, inline explanations, test assertions on wording, architecture
notes. When an assertion is false, every reader builds on it. Humans trust it. Agents ingest it as ground truth and
write more code on top. Tests get written against it. That is not a code smell; it is **poisoned grounding** — the
reasoning downstream is corrupted even when every individual step is sound.

A false claim is worse than no claim, because it is load-bearing without being checked.

## When this fires

- A comment states how a **library or framework** behaves. You cannot verify it from the repo, and you did not verify it
  elsewhere either.
- A guard, retry, workaround, or defensive branch is justified by a comment rather than by a reproduction.
- A doc example's output looks *slightly* off from what the code suggests.
- A test asserts prose (`expect(msg).toContain("must be absolute")`) instead of structure.
- After a refactor, rename, or **dependency major upgrade**: every claim about the touched surface is now suspect.
- The plausibility trigger: something reads right but you would have to go look to be sure. Plausible-and-unchecked is
  what a lie looks like from the inside.

## Procedure

### 1. Inventory the claims

Collect every assertion about behavior in scope, in descending blast radius:

1. **Claims about dependencies** — "the SDK registers X at construction", "this API validates before the handler runs",
   "the framework retries on 429". Highest radius: they are the least checkable and the most confidently written.
2. **Claims that justify code** — the comment above a guard, a fallback, a sleep, a cache invalidation. If the claim is
   false, the code is dead or wrong, not just the comment.
3. **Literal example output** in docs, README snippets, and `@example` blocks.
4. **Test assertions encoding wording**, formats, or example values.
5. **Inline "always / never" claims** — "callers always pass absolute paths", "this cannot throw", "only reachable in
   tests".
6. **CHANGELOG or commit claims phrased as current state.** History as history stays; never rewrite the log.

### 2. Verify — the instrument depends on the claim

| Claim is about               | Verify against                                                | Never accept                                                                   |
|------------------------------|---------------------------------------------------------------|--------------------------------------------------------------------------------|
| Local behavior               | The implementation. Trace the exact path.                     | Adjacency — a comment near a function is not evidence about it                 |
| A dependency                 | Vendored docs, or the installed package source, file and line | Recall. Your training data holds older major versions that compile identically |
| An output string             | Execution, character for character                            | A remembered format. Culture, ordering, and punctuation are where lies hide    |
| A consumer ("X parses this") | Grep for the actual consumers and read them                   | The claim itself. Claims about who depends on what are the scariest ones       |
| A reachable state            | A reproduction, or a proof it cannot occur                    | "It could theoretically happen"                                                |

Environment-dependent behavior is a claim: an output documented as `62.0%` is a lie on a de-AT host if the formatting is
culture-sensitive.

For a claim about a dependency you cannot check cheaply, that is itself the finding. Record it UNVERIFIABLE and say so.
Do not guess and do not let the comment stand as if checked.

### 3. Classify

| Verdict              | Meaning                             | Action                                                                                                                                                                           |
|----------------------|-------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **TRUE**             | Matches behavior                    | Leave it; optionally pin it with a test                                                                                                                                          |
| **LIE**              | Never true in any reachable version | Fix now; trace what was built on it                                                                                                                                              |
| **LOAD-BEARING LIE** | A lie that justifies code           | Delete the claim **and the code it justifies**. A guard against an impossible state is not "harmless" — it costs runtime, misleads the next reader, and hides the real invariant |
| **STALE**            | Was true, drifted after a change    | Fix; name the change that orphaned it                                                                                                                                            |
| **UNVERIFIABLE**     | Cannot be checked from repo or docs | Rewrite so it is checkable, or delete it                                                                                                                                         |

For every lie and every stale claim, trace the **poisoning chain**: what else — tests, docs, consumer code, past
decisions, other comments — was written by someone who believed it? Each is a new audit target.

### 4. Fix — with direction rules

- **Code wins by default.** Docs are corrected to describe what the code does.
- **Exception:** when the claim documents *intent* and the code deviates in a way nobody chose, the code is the bug.
  Rule explicitly and say which way you ruled and why.
- **Third exception, new in v2:** when the claim is about a dependency and is simply wrong, the fix is usually neither —
  it is removing whatever was built on the misunderstanding, then re-solving the actual problem against the documented
  API.
- **Restructure so the lie cannot recur:**
    - Prose asserted in tests → structured assertions (codes, enums, computed booleans). Pin the canonical wording in
      **exactly one golden test**, so rewording is a one-test change.
    - Consumers parsing human-readable output → give them a structured API and document
      "branch on these, never parse the prose".
    - Environment-sensitive output documented as fixed → make it invariant and pin it under a hostile locale.
    - Doc examples → regenerate from execution, never from memory.
    - Dependency claims → replace the comment with a citation (doc path, or package file and line) so the next reader
      can re-check it in seconds instead of re-deriving it.

### 5. Report the sweep verdict

The verdict is the deliverable:

> **Sweep result:** N true / N lies / N load-bearing / N stale / N unverifiable.
> Consumers X and Y never depended on the false claim (verified by …). Poisoning was confined
> to {tests, docs, module Z}; fixed by {…}; recurrence prevented by {golden test / structured
> API / invariant output / citation}.

Name what was **checked and found clean** as explicitly as what was found wrong. "No consumer parses the reason prose"
is worth as much as a fix, because it bounds the blast radius and un-poisons the reasoning downstream.

## Rules

- **Read-only until every verdict is in.** Fix in a second pass, so early fixes do not bias later checks.
- **Never fix a claim by making it vaguer.** Vague is unverifiable, and unverifiable is a failure class, not a safe
  harbor.
- **A confident tone is not evidence.** Length, specificity, and a well-written rationale correlate with nothing. Treat
  a detailed mechanism claim exactly as skeptically as a terse one — more so, since detail is what makes a wrong claim
  survive review.
- **History is testimony about the past.** Audit CHANGELOG and commit messages only for claims phrased as current state.
- If a claim cannot be verified cheaply, say so. That is a finding, not a gap in the report.
