# qyl public submission preparation

Updated 8 October 2026. Three directory records are prepared from this
folder. None is uploaded, submitted, approved or published. Status is
recorded in the [evidence ledger](../MCP-V2-INTEROP-TODO.md); requirements
and the work order are in [goal-objective.md](../goal-objective.md).

| Record | Portal | Source | State |
| --- | --- | --- | --- |
| OPENAI_PLUGIN | https://platform.openai.com/plugins | `qyl/` as a ZIP | local draft |
| ANTHROPIC_CONNECTOR | https://claude.ai/directory/manage, kind "MCP connector" | `https://mcp.qyl.at/mcp` | not created |
| ANTHROPIC_PLUGIN | https://claude.ai/directory/manage, kind "Plugin bundle" | repository `ANcpLua/qyl.mcp`, plugin path `submission/qyl`, a branch or tag | not created |

## What `qyl/` contains today

- `plugin.json`: Agent Plugins 1.0 manifest with `$schema`, name `qyl`,
  version 1.0.0, and `extensions.com.openai` holding the listing copy, three
  default prompts, five positive and three negative review cases, release
  notes and the free-use declaration.
- `mcp.json`: one `streamable-http` server at `https://mcp.qyl.at/mcp`.
  Authentication is discovered from the server's 401 and resource metadata.
  No credentials are included.
- `assets/qyl-icon.png`: 1254 × 1254 PNG for listing and composer.

The package version (1.0.0) and the service version in `server/package.json`
(7.2.0) identify different artifacts.

## What `qyl/` still needs

- `skills/qyl-investigate/SKILL.md`: the agent workflow shared by both plugin
  formats (goal step 3).
- `.claude-plugin/plugin.json` (name, displayName, version, description,
  author, license), `.mcp.json` pointing at `https://mcp.qyl.at/mcp`,
  `README.md` with at least 40 words outside code blocks, and a `LICENSE`
  file: the Anthropic bundle (goal step 5).
- Listing text that matches the tools: qyl measures and correlates, the agent
  reasons and acts. No remediation, fixing or continuous monitoring is
  promised.
- For OpenAI review: website, support, privacy and terms URLs, the publisher
  identity, `review.demo_recording_url`, and the domain challenge at
  `https://mcp.qyl.at/.well-known/openai-apps-challenge`.
- For the Anthropic connector: test credentials for a fully populated
  account, documentation URL, privacy URL, support contact, icon, categories
  and slug.
- A ZIP check against the OpenAI portal validator, because the folder then
  also contains `.claude-plugin/`. Exclude it when zipping if the validator
  objects.

## Directory rules this folder is held to

- Separate read and write tools; `title` plus accurate `readOnlyHint` or
  `destructiveHint` on every tool; descriptions that match behavior and do
  not address the model.
- Tools call qyl's own APIs only. No actions in third-party systems.
- Responses proportional to the question; no raw dumps.
- No conversation data collected beyond what a tool needs, not even for
  logs.
- Free to use, no purchases, no financial transactions.

Sources:
[Anthropic connector checklist](https://claude.com/docs/connectors/building/review-criteria),
[Anthropic plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist),
[Anthropic directory policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy),
[OpenAI submission](https://developers.openai.com/plugins/deploy/submission),
[OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines),
[Submit a Claude plugin to OpenAI](https://developers.openai.com/plugins/guides/submit-claude-plugin).

## Owner actions

Publisher identity, public pages on qyl.at, the reviewer account, the demo
recording, attestations, submission and publication are the owner's. Agents
prepare the files above and record what is missing; they do not upload or
submit.
