---
name: digital-twin-page
description: Maintain git-backed AI Persona state via assets/chat-config.json — display profile (pageProfile) and published AI config (publishedConfig). Embed appearance moved to assets/embed-config.json.
---

# AI Persona Skill

## Portable Git contract (schema v2)

Author new and cross-environment persona assets with stable model identity:

```json
{
  "schemaVersion": 2,
  "resourceKey": "persona.example",
  "publishedConfig": {
    "agentTopology": {
      "slashCommands": [{
        "trigger": "/run",
        "workflowRef": { "kind": "workflow", "resourceKey": "workflow.example.run-v2" }
      }]
    }
  },
  "pageProfile": {}
}
```

- Never write `pageId`, `userId`, `commandId`, `automationId`, `actionId`, or any other database identifier into a portable Git definition.
- Register the portable bundle in `references/registry.json` schema v2. The file must contain **exactly one Workflow, one Pipeline, and one List**. Every entry requires `kind`, `resourceKey`, repository URL, branch, asset path, an immutable `revision`, and the SHA-256 `definitionFingerprint` of the referenced JSON definition. Do not add `team_agent`, `primary`, or `dependsOn` here — extra authoring repos belong in generated `references/workspace.json`.
- `revision` and `definitionFingerprint` are owned by **workspace publish**, which recomputes both and writes them with the matching gitlinks in one validated root commit. Run `node scripts/publish-workspace.js publish` (or Gabriel **Publish workspace**); do not hand-edit them. Creating a child repository in Gabriel only marks the workspace dirty — nothing else advances the persona lock, so a pin stays on its last published commit until you publish. Never point a fingerprint at a moving branch alone.
- The two publishers pin from different sources, deliberately. `scripts/publish-workspace.js` pins the commit **checked out** in each submodule, because that is what you built and tested in this clone. Gabriel's server publish has no working tree and pins each child's **branch head**. After you commit and push a child they agree; they differ only when a submodule is intentionally held on an older commit.
- A submodule sitting **behind** its origin is a normal pin and does not block publish. What blocks is a child commit that exists only in your clone — nobody else could resolve that pin — so push the child first.
- Treat `resourceKey` as stable model identity. Gabriel allocates local page/action IDs during import and stores them only in environment-local bindings and runtime records.
- Keep logical command triggers and workflow task/stage IDs stable; these are model identifiers, not database identifiers.
- Run the portability validator before publishing. An unresolved dependency must fail before the Persona is activated; never guess a local ID.
- Legacy schema v1 is same-environment compatibility only. Do not copy it between environments and do not create new v1 exports.

## Goal
Maintain one AI Persona configuration per repository. The `assets/chat-config.json` file is the source of truth for the page's **display profile** (`pageProfile`: title, description, avatar, banners, tags, taxonomy) and **published AI runtime** (`publishedConfig`: assistant name, prompts, voice, connectors, tools, etc.) when a git repository is connected.

Embed appearance is no longer owned by this file. For hero copy, themes, backgrounds, public about panels, conversion blocks, and widget appearance, use the separate embed config skill and edit `assets/embed-config.json`.

This skill scope is **chat-config.json**, the portable `references/registry.json` triple, and the generated authoring graph in `references/workspace.json`. Workflow endpoint bindings and task orchestration for team agents are covered by the **team-agents** skill, which ships inside each linked team-agent repository under `references/team-agents/`. This repository owns the *depth-1 gitlink*; the team-agent repository owns its definition. Team agents are **not** portable registry rows. See **Linked repositories** below.

**Slash-command debug/docs are out of scope here.** Do not create or edit `assets/slash-connections/` (or any slash-command connection debug graphs) in this repository. Those live in each command's bound **workflow** repository as `assets/slash-connections.json`, owned by the **workflow-builder** skill (`server/skills/workflow-builder/`). Runtime registration of slash commands (`publishedConfig.agentTopology.slashCommands`: trigger, label, enabled, action linkage) still round-trips in `chat-config.json` when present — that registration is not the debug graph.

### Never author page/master-skill Canvas

The page-backed Canvas mode (`blueprintRef: "page"`) and its page-level master-skill
dependency are deprecated compatibility code. Coding agents must never add a master
skill or `taskExecutionBlueprint` merely to make an Operator slash command run.

Canvas task definitions belong to the command's workflow repository. There they must
use `blueprintRef: "inline"` in every Canvas capability and terminal aggregate. Stable
identity belongs in `canvasTask.sequenceId`; never put a page id, sequence id, product
name, or other custom string in `blueprintRef`. This page repository owns only slash
command registration and must not duplicate the Canvas task catalog.

For a default first-use command, keep the command enabled and use
`launchPolicy.invocationPolicy: "first_use"`, `autoOpenIntake: true`, a bumped
`commandVersion`, and `firstUseCompletion: "execution_started"`. Only one
automatic command is allowed per persona. The command must use the standard
`operator_action` workflow path; never add page-level form discovery, direct
submission tools, acquisition recipes, or Canvas task definitions here.

Existing-case identity is also outside Persona configuration. Do not add a locator
column, URL-normalization rule, or `existingCasePolicy` object to
`assets/chat-config.json` or the slash-command details UI. The command's workflow
Canvas references a stable `existingCasePolicyId`; the selected Pipeline owns and
configures that policy under **Pipeline → Manage → Config → Existing-case detection**.
Changing `form_url` to another resource locator therefore belongs to the Pipeline
and its bound List schema, not to `PersonaOperatorSlashCommandsPanel`.

Persona Chat apps configured in the Identity/Reach editor may be reused by a
workflow-authored Canvas task for `responseCollection.mode: "channels_only"`.
That runtime use is runner-specific: it requires the authenticated runner's
linked external identity and sends a single-use questionnaire URL scoped to one
Canvas decision. It must not inject the questionnaire or its answers into the
Persona's general chat conversation. The channel list belongs to the workflow
task, while `chat-config.json` continues to own only the normal Chat app
configuration and slash-command registration.

## Using this skill in coding agents

Gabriel Operator skills are designed for Claude Code, Codex, Cursor, Hermes, OpenClaw, and any agent that supports skill packs. Work in the git-backed AI Persona repository connected to your Gabriel page.

### Install the skill pack

| Agent | Install |
|-------|---------|
| **Claude Code** | `npx skills add go-code-bot/go-digital-twin-page-skills` |
| **Codex** | `codex plugin marketplace add Gabriel-Operator/gabriel-operator-coding-agent-plugin --sparse .agents/plugins` then install the Gabriel Operator plugin |
| **Cursor** | `npx github:go-code-bot/go-digital-twin-page-skills add ./my-digital-twin-page` or copy into `.cursor/skills/digital-twin-page/` |
| **Hermes / generic CLI** | `npx github:go-code-bot/go-digital-twin-page-skills add ./my-digital-twin-page` |
| **OpenClaw** | `npx skills add go-code-bot/go-digital-twin-page-skills` then `openclaw gateway connect --url https://your-openclaw-gateway` |
| **Gabriel Operator monorepo** | `cp -R server/skills/digital-twin-page ./your-git-repo/` |

Alternative curl installer:

```bash
curl -fsSL https://raw.githubusercontent.com/go-code-bot/go-digital-twin-page-skills/main/install.sh | bash
```

### Modify with your coding agent

1. Clone the persona repository and run `git submodule update --init`.
2. Read `references/workspace.json` (generated authoring graph) and `references/registry.json` (portable Workflow + Pipeline + List only).
3. Edit the **owning child** repository — `assets/chat-config.json` here, or the matching submodule under `references/`. Do not hand-edit `workspace.json`.
4. Preserve `schemaVersion: 2`, `resourceKey`, portable refs, and logical command identities. Never add a local `pageId`, `appId`, `endpointId`, or `actionId` to Git.
5. Commit and push **the child first**. Then publish the workspace lock:

```bash
node scripts/publish-workspace.js validate
node scripts/publish-workspace.js publish
```

A failed validate leaves the currently published persona root untouched. Publish is
all-or-nothing: it plans the pinned registry, manifest, and unlink set in memory, and if any
step fails — including the commit itself — it restores `HEAD`, the index, and the generated
files rather than leaving the tree half-written.

**Every child must be a clean, published checkout.** Publish refuses a child with
uncommitted changes, no `origin`, or a commit that exists only in your clone. A pin sitting
*behind* origin is fine — that is what a pin is; only unpushed commits block, because nobody
else could resolve them.

**Validation is split by trust.** Locally, each child's own validator scripts run
(`validate-pipeline.js`, `validate-list.js` plus `validate-records.js` when the list has
rows, `validate-workflow.ts`, and both `validate-team-agent.ts` and
`validate-task-orchestration.ts`), because you already trust your own clone. A child that
ships a `SKILL.md` but no validator fails; a hand-made child without one is skipped loudly.
`scripts/validate-portable-bundle.js` additionally checks the whole
Persona → Workflow → Pipeline → List chain, not just each file's header. The server never
executes child scripts — it performs the equivalent structural checks on JSON read at the
pinned revision.

### Removing a repository from the workspace

Publish unlinks a stale gitlink and its `.gitmodules` section so the lock stays consistent,
but never deletes the directory — it may still hold work you have not pushed. Remove the
leftover checkout explicitly:

```bash
node scripts/publish-workspace.js prune
```

`prune` only removes a directory under `references/` that publish already unlinked and that
the current graph does not claim. It refuses portable registry paths and anything outside
`references/`.

### Working across the whole graph

One clone reaches every definition and every skill pack, so a change that spans the
Pipeline, its List, and the Workflow that maps between them can be written and validated
in a single working tree:

```bash
git clone <persona-repo> && cd <persona-repo>
git submodule update --init
```

1. Read the child `SKILL.md` for whichever asset you are editing — each submodule ships
   its own skill pack (`references/pipelines/*/SKILL.md`, `references/workflows/*/SKILL.md`
   with its `actions/` guides, `references/team-agents/*/SKILL.md` with its `nodes/` guides).
2. Make the change in the child repository that owns the definition. Keep the linked
   assets consistent as you go: a Pipeline column that a Workflow maps into must exist in
   the bound List schema too.
3. Run each child's validator before committing (`node scripts/validate-pipeline.js`,
   `node scripts/validate-list.js`, `npx tsx scripts/validate-workflow.ts`).
4. **Commit child-first, then publish the workspace.** Commit and push inside each submodule. Then run `node scripts/publish-workspace.js publish` so this repository's gitlinks, `workspace.json`, and portable fingerprints advance in **one** root commit. Do not hand-bump `revision` rows or treat a persona-root commit as an atomic multi-repo publish.
5. Extra workflows and team agents live in generated `references/workspace.json`. They are same-environment authoring. Cross-environment import materializes only the portable triple in `registry.json`.

A single working tree is what this buys you — not atomic commits across remotes. Changing a Pipeline and its Workflow together is still two child commits plus one workspace publish here.

**Example prompts:**
- *"Update the twin's system prompt and first message for a grocery-shopping persona."*
- *"Change the page title, description, and profile picture URL in pageProfile."*
- **OpenClaw:** *"Clone the persona, run git submodule update --init, read workspace.json, edit the owning child, commit and push that child, then run node scripts/publish-workspace.js publish."*

### Sync to Gabriel

1. Commit and push `assets/chat-config.json` to the default branch.
2. Gabriel pulls the file into the live page database projection automatically on sync, or use **Sync to Git** from the AI Persona Git binding modal in the UI.
3. For edits made in the UI first, use **Sync to Git** to push the current database state back to the repository.

**Optional — run via dedicated computer or managed agents:** When `computerConfig` is enabled or a supervisor has a sandbox provider configured, your twin can execute skill mentors in a sandbox harness. See **Dedicated Computer** and **Gemini Antigravity Managed Agents** below for runtime paths; those are triggered from Gabriel after config sync, not from local CLI alone.

## Canonical Files
- `/SKILL.md`
- `/README.md` — human overview; **installation** via `npx` / `curl` / `install.sh` (same pattern as `server/skills/team-agents/`)
- `/cli.js`, `/install.sh`, `/package.json` — optional CLI pack to scaffold this tree into another repo (publish `go-digital-twin-page-skills` or copy from monorepo)
- `/scripts/`
- `/references/` — linked repositories, as git submodules (see **Linked repositories** below)
- `/assets/chat-config.json` — unified snapshot for profile + publish (this document)

## Linked repositories (`references/`)

Every repository this AI Persona depends on is linked into `references/` as a **git
submodule**, so one clone reaches the whole workspace — every definition and every skill
pack. Links are written by the product when the author creates the child repository —
never add or edit `.gitmodules` by hand.

```text
references/registry.json               ← portable only: exactly one workflow, pipeline, list
references/workspace.json              ← generated depth-1 authoring graph (ignored by import)
references/README.md                   ← generated from workspace.json
references/chat-config-contract.json   ← machine-readable contract for chat-config.json
references/pipelines/<resource-key>/   ← submodule: pipeline-builder repo
references/lists/<resource-key>/       ← submodule: list-builder repo
references/workflows/<resource-key>/   ← submodule: workflow-builder repo (primary + extras, once each)
references/team-agents/<key>/          ← submodule: git-bound team agents only
```

```bash
git submodule update --init
```

**All links are depth 1.** Every repository — including a team agent's child workflows —
is a direct submodule of this Persona, never a submodule of another submodule, so
`--recursive` is not required and a workflow reached by two team agents appears once.
The dependency *graph* is recorded in generated `references/workspace.json`, not by
directory nesting and not by extra rows on `registry.json`.

Submodule directories are named after the stable **resource key** when portable, or the
git remote slug when the child is workspace-only. The readable name lives in
`workspace.json` and the generated `references/README.md` table.

### Portable registry vs authoring graph

`registry.json` is the **strict portable bundle**. Import materializes exactly those three
repositories. Do not add team agents or extra slash-command workflows to it.

`workspace.json` is **generated**. Authors and agents do not hand-edit it. Publish
(Gabriel **Publish workspace** or `node scripts/publish-workspace.js publish`) regenerates
it after validation. Failed validation does not write a persona root commit.

```json
{
  "schemaVersion": 2,
  "repos": [
    {
      "kind": "pipeline",
      "resourceKey": "pipeline.example.filer-v2",
      "displayName": "Filer pipeline",
      "path": "references/pipelines/pipeline-example-filer-v2",
      "repositoryUrl": "https://github.com/me/filer-pipeline.git",
      "branch": "main",
      "assetPath": "assets/pipeline.json",
      "revision": "bfef019f3e71d337577a2de75bf3cbea0b12c7fb",
      "definitionFingerprint": "aa9a5793…"
    }
  ]
}
```

`kind` is one of `workflow`, `pipeline`, `list`. Never `team_agent`.

### Team agents

The Persona repository owns a team agent's **depth-1 gitlink** after workspace publish;
the team-agent repository owns its definition (`assets/team-agent.json`,
`assets/task-orchestration.json`) and is edited through the **team-agents** skill in that
submodule.

A team-agent definition still carries environment-local ids (`appId`, `endpointId`, and
`data.config.actionId` on native connector nodes). Those ids stay in Gabriel bindings.
They must never be copied into `workspace.json`. Missing Git binding is an unresolved
workspace row and **blocks publish**. `schema-form:*` pipeline endpoints are built-ins,
not git dependencies.

## Minimal payload example
`/assets/chat-config.json` is a single JSON object. A typical file looks like:

```json
{
  "schemaVersion": 2,
  "resourceKey": "persona.example",
  "publishedConfig": {
    "name": "...",
    "firstMessage": "...",
    "systemPrompt": "..."
  },
  "pageProfile": {
    "title": "...",
    "description": "...",
    "longDescription": "",
    "profilePicture": null,
    "bannerImage": null,
    "bannerType": null,
    "tags": [],
    "category": "",
    "subcategory": ""
  },
  "commitMessage": "Update chat config",
  "updatedAt": 1700000000000
}
```

Optional keys the backend may add or preserve when syncing:
- `endpointSummaries` — informational array (see root keys below).
- `includedAgents` — **deprecated**; do not rely on it for new work.

---

## Chat configuration reference (`assets/chat-config.json`)

Use this section when editing the file by hand, generating patches, or reviewing diffs. **Ground truth in code:** TypeScript type `ChatConfigPayload` in `server/src/services/digital-twin-page-git/types.ts`; `publishedConfig` follows the page’s stored publish payload (same conceptual shape as `DigitalTwinConfig` in `app/routes/teams/$teamSlug/team-workspaces/$unitSlug/components/configureDigitalTwin.types.ts`).

### Validation rules (backend)
- **`schemaVersion`** must be `2` for new portable writers/readers.
- **`resourceKey`** must be the stable model identity. A local page id is resolved during import and never belongs in Git.
- **`publishedConfig`** is stored as a JSON object; unknown nested keys are generally preserved on round-trip unless the product strips them on save.
- **`pageProfile`** on **pull** is filtered to an allowlist and typed (see `pageProfile`); unknown keys are **ignored** for safety.

### Root object — every top-level key

| Key | Required | Purpose |
|-----|----------|---------|
| `schemaVersion` | yes | Portable protocol version; use `2`. |
| `resourceKey` | yes | Stable model-owned persona identity. |
| `publishedConfig` | yes | **Published assistant** runtime: prompts, model, voice, connectors, output integration, etc. (see dedicated section). |
| `pageProfile` | optional on old files; written on new syncs | **Page document display** fields (title, description, avatar, banners, tags) mirrored for git editing. |
| `endpointSummaries` | optional | Non-authoritative list of `{ "id": string, "name": string, "isPrimary"?: boolean }` for UI/diff context. Live workflow endpoints are **not** defined here. |
| `includedAgents` | optional | **Deprecated.** Legacy included agents list; do not build new features on it. |
| `commitMessage` | optional | Human-readable note for the last logical change (convention, not always enforced). |
| `updatedAt` | yes | Unix time in **milliseconds** when this snapshot was written. |

---

### `pageProfile` — every key (allowlisted)

These keys mirror the **public page record**. On sync from DB, all keys are always present for stable diffs. On **pull from git**, only these keys are applied; types must match or the key is skipped.

| Key | Type | What to change |
|-----|------|----------------|
| `title` | `string` | Public page / twin headline (SEO, cards, layout). |
| `description` | `string` | Short description (SEO, summaries). |
| `longDescription` | `string` | Longer plain-text description for the **page**. |
| `profilePicture` | `string \| null` | URL (or null) for avatar / brand image on the page shell. |
| `bannerImage` | `string \| null` | Banner image URL, or null. |
| `bannerType` | `"image" \| "gradient" \| null` | How the banner is rendered when present. |
| `tags` | `string[]` | Discovery / filter tags; only string elements are kept on pull. |
| `category` | `string` | Top-level taxonomy label. |
| `subcategory` | `string` | Secondary taxonomy label. |

**Never put in `pageProfile`:** `pageSlug`, `visibility`, `sharedWith`, credits, owner ids, API keys, Twilio secrets—those stay database-only.

---

### Embed appearance moved

Do not add or edit `chatEmbedConfig` in `assets/chat-config.json`. It is ignored by new chat-config pulls. Use the embed config repository instead, where every initial and follow-up embed change belongs in `assets/embed-config.json` under `chatEmbedConfig`.

---

### `publishedConfig` — what it is and how it is built

`publishedConfig` in git is the **published** assistant configuration blob stored on the page **plus** a few fields merged from **draft** `vapiAssistantConfig` so they appear in version control.

**Merge rules** (`server/src/services/digital-twin-page-git/chat-config-published-config.util.ts`):
1. Start from the page’s `publishedConfig` document (deep-cloned).
2. If draft `vapiAssistantConfig.outputIntegration.outputTabViewerDefaultsByUserId` exists, copy it onto `publishedConfig.outputTabViewerDefaultsByUserId`.
3. If draft has `webSearchEnabled`, `xSearchEnabled`, or `xSearchAllowedHandles`, copy those keys onto `publishedConfig` so voice/search flags round-trip in git.
4. If draft has `composioEnabledToolkitSlugs`, `formUi`, `chatImageUpload`, or `agentTopology`, copy those keys onto `publishedConfig` so Composio toolkit allowlists, chat UI, and agent topology round-trip in git.
5. `computerConfig` and `emailConfig` are stored directly on the page and always round-trip in `publishedConfig` when present.

When a coding agent **edits git**, treat `publishedConfig` as the same shape the product uses after publish. The authoritative TypeScript interface is **`DigitalTwinConfig`** (`configureDigitalTwin.types.ts`). Below: **every field name** on that interface with a one-line meaning (optional fields marked by “optional” in prose).

#### Core assistant text and model
| Field | Purpose |
|-------|---------|
| `name` | Display name of the published assistant. |
| `voiceId` | Default TTS/voice id for the assistant where applicable. |
| `llmModel` | Chat LLM model id string. |
| `firstMessage` | Opening message users see when a session starts. |
| `systemPrompt` | System / developer instructions for chat behavior. |
| `temperature` | Sampling temperature for the chat model. |
| `language` | Optional locale / language hint for the assistant (e.g. `en`). |

#### Connectors, knowledge, mentors
| Field | Purpose |
|-------|---------|
| `nativeConnectorIds` | Optional list of native (in-product) connector ids enabled for tools. |
| `mcpServerIds` | Optional MCP server ids for tool servers. |
| `knowledgeBaseFileIds` | Attached knowledge base file ids for RAG-style retrieval. |
| `mentorIds` | Mentor ids when mentor routing is used. |
| `mentorSelections` | `{ id, name, icon? }[]` richer mentor picker state. |

#### Task execution blueprint (orchestrated skills)
| Field | Purpose |
|-------|---------|
| `taskExecutionBlueprint` | **Deprecated for Canvas/Operator commands.** Historical page-level master-skill blueprint; do not add it to support new workflows. Existing unrelated legacy records may still round-trip until migrated. |
| `taskExecutionSourcePageId` | **Deprecated for Canvas/Operator commands.** Historical page blueprint inheritance reference; do not author for new workflows. |

#### Voice agent stack (LiveKit / telephony / xAI / Anam)
| Field | Purpose |
|-------|---------|
| `voiceAgentEnabled` | Master switch for voice agent sessions. |
| `voiceOnlyAgentEnabled` | Audio-only voice mode. |
| `digitalAvatarAgentEnabled` | Avatar video mode when supported. |
| `phoneAgentEnabled` | Telephony integration enabled. |
| `callButtonConfig` | Visitor-facing label and icon for the Talk option in the Calls launcher. |
| `phoneCallButtonConfig` | Visitor-facing label and icon for the Phone option in the Calls launcher. |
| `checkInScheduleConfig.appearance` | Label and icon for Checkin Mentor. |
| `coachConfig.appearance` | Label and icon for Coach. |
| `translateConfig.appearance` | Label and icon for Translate. |
| `twilioCredentialId` | Reference id to user’s saved Twilio credential (not the secret itself). |
| `livekitBackend` | `"gateway"` or `"xai-realtime"` backend selection. |
| `livekitKeyId` | Saved LiveKit key reference. |
| `xaiKeyId` | Saved xAI key reference. |
| `xaiVoice` | xAI realtime voice id. |
| `xaiVadThreshold` | Voice activity detection threshold. |
| `xaiVadPrefixPaddingMs` | VAD padding milliseconds. |
| `voiceBrowserToolsEnabled` | Allow browser-control tools in xAI realtime voice. |
| `webSearchEnabled` | xAI web search tool (may be merged from draft). |
| `xSearchEnabled` | xAI X/Twitter search tool (may be merged from draft). |
| `xSearchAllowedHandles` | Allowlist of X handles for search (may be merged from draft). |
| `imageAnalysisPrompt` | Custom prompt for image analysis tool. |
| `livekitUrl` / `livekitApiKey` / `livekitApiSecret` | LiveKit connection parameters when stored (prefer credential refs in production). |
| `anamKeyId` / `anamAvatarId` / `anamPersonaName` / `anamApiUrl` / `anamRenderVideo` / `anamVoiceId` / `anamLlmId` | Anam avatar plugin configuration. |
| `ttsModel` / `ttsVoice` / `ttsVoiceCustom` / `ttsLanguage` | Text-to-speech stack. |
| `sttModel` / `sttLanguage` | Speech-to-text stack. |
| `voiceProvider` | Voice stack provider key. |
| `vapiSquadId` / `vapiAssistantId` | Legacy Vapi ids when used. |
| `voiceLlmModel` | Separate LLM for voice path vs chat. |
| `backgroundAudio` | Ambient loop: `none`, `office`, `cafe`, `nature`. |

#### Providers and browser
| Field | Purpose |
|-------|---------|
| `browserProviderId` | Browser automation provider for goals/workflows. |
| `guardianRequirements` | Guardian policy requirements (browser, sites, credential types). |
| `geminiProviderId` | Gemini File Search provider id. |
| `geminiLiveProviderId` / `geminiLiveModel` / `geminiLiveVoice` / `geminiLiveWebSearchEnabled` | Gemini Live realtime voice configuration. |
| `xaiProviderId` | xAI File Search provider id. |
| `mem0ProviderId` | mem0 memory provider id. |
| `sandboxProviderId` | E2B sandbox provider id. |
| `chatCommandSettings` | Which slash-commands / tools are exposed in chat UI. Keys: `image`, `video`, `audio`, `search`, `deepsearch`, `deepresult`, `skillRun`; each value is `boolean`. Default for all keys is `false`. |
| `chatCommandModels` | Per-command model overrides: `Partial<Record<ChatCommandKey, string>>`. Same keys as `chatCommandSettings`; value is a model id string. Set per-tool in the Agents column. Takes precedence over the global `llmModel` for that command. |
| `chatCommandOptions` | Per-command extra options: `Partial<Record<ChatCommandKey, Record<string, unknown>>>`. Arbitrary key-value config per command (e.g. `video.durationSeconds`, `video.size`). Also set per-tool in the Agents column. |

#### Chat UI, forms, and agents
| Field | Purpose |
|-------|---------|
| `formUi` | Optional form/cart UI configuration used by the page chat surface; merged from draft so git has the active UI behavior. |
| `chatImageUpload` | Optional image-upload and image-resolver configuration for chat; merged from draft into git when present. |
| `agentTopology` | Runtime agent topology for multi-supervisor, built-in subagents, custom subagents, and **slash command registration** (`slashCommands`); merged from draft into git when present. Registration only — slash-command **debug graphs** are not stored in this file (see workflow-builder / `assets/slash-connections.json` on the bound workflow repo). |
| `computerConfig` | Dedicated computer / sandbox configuration. See **Dedicated Computer** section below. |
| `emailConfig` | Dedicated inbox configuration. See **Dedicated Inbox** section below. |

#### Composio / Arcade MCP
| Field | Purpose |
|-------|---------|
| `composioChatToolsEnabled` | Toggle Composio toolkit tools in chat. |
| `composioKeyId` | Saved Composio key reference or sentinel like `default`. |
| `composioApiKey` | Raw key when not yet saved (avoid committing real secrets). |
| `thirdPartyAppToolsProvider` | Legacy single-provider selector: `"composio"` or `"arcade"`. Used when only one provider is active. |
| `enabledThirdPartyToolProviders` | Array form (newer): `Array<"composio" \| "arcade">`. Allows multiple providers to be active simultaneously. Both fields may coexist; `enabledThirdPartyToolProviders` is the authoritative list at runtime. |
| `composioEnabledToolkitSlugs` | Composio toolkit allowlist, e.g. `["gmail"]`. Only these toolkits appear in page chat `@` mentions. For SDK-session Composio, runtime tools are loaded only for toolkit slugs explicitly mentioned in the user message. Empty or omitted means no SDK-session Composio toolkit is available until a toolkit is selected. |
| `arcadeKeyId` | Saved Arcade key reference. |
| `composioToolRouterMcpUrl` | Legacy/provisioned Composio MCP URL path. Toolkit selection uses `composioEnabledToolkitSlugs` instead. |
| `arcadeMcpGatewayUrl` | Arcade MCP gateway URL. |

#### Output integration (Airtable / Notion / native / pipelines)
| Field | Purpose |
|-------|---------|
| `outputIntegration` | Full output integration object: connectors, `resultSets`, `dataLists`, `pipelineListBindings`, Airtable/Notion ids, etc. (see `OutputIntegrationConfig` in the same types file). |
| `outputTabViewerDefaultsByUserId` | Per-user Output tab defaults (`defaultPipelineId`, `defaultListByPipelineId`); **merged from draft** into git `publishedConfig` for visibility in repo. |

**Secrets:** Do not commit raw API keys, Twilio auth tokens, or private LiveKit secrets when avoidable; the product often uses **reference ids** (`*KeyId`, `*CredentialId`) pointing at user-stored credentials.

---

## Write-Through Behaviour
When a user edits configure/publish settings or page display fields in the UI, changes are saved to the database and then synced to this file automatically (500 ms debounce where implemented). **Pull from git** overwrites the database for `publishedConfig` and allowlisted **`pageProfile`** fields to match the file. Chat embed appearance changes sync through `assets/embed-config.json`.

## Ways to apply changes
1. **In-app editors** — UI saves to DB; debounced or explicit **Sync to Git** (e.g. from the AI Persona Git binding modal) pushes current DB state, including `pageProfile`, to the default branch. That full sync also rewrites the skill tree from the platform template (including this `SKILL.md`) and, for **page-primary** repositories only, deletes legacy `assets/team-agent.json`, `assets/task-orchestration.json`, and `skills/master/SKILL.md` if they are still present from older layouts. Per-endpoint bound repos keep those workflow files.
2. **Edit in repo** — Commit `assets/chat-config.json` on the bound branch, then use the product’s **Pull** action to hydrate the page document from git.
3. **Automation / CI** — Pipeline or agent updates the same JSON shape; pull or webhook-driven sync must respect `pageId` and branch binding rules enforced by the backend.

## Dedicated Computer (`computerConfig`)

An AI Persona can expose a **dedicated computer** (sandbox runtime) to chat and skill-run commands. The author configures this in the **Computer** tab of the Connectors column; the result is stored as `computerConfig` on the page and round-trips in `publishedConfig`.

### `computerConfig` shape (`DigitalTwinComputerConfig`)

| Field | Type | Purpose |
|-------|------|---------|
| `enabled` | `boolean` | Master switch. When `false`, `/skill-run` falls back to the conventional coding-agent harness with no dedicated computer. |
| `mode` | `"visitor_supplied" \| "author_provided" \| "hybrid"` | Computed from whether the author has pre-saved credentials. `visitor_supplied` = visitor must connect their own; `author_provided` = author credential used for all; `hybrid` = author credential saved but visitors may override. |
| `providers` | `DigitalTwinComputerProviderType[]` | Ordered allowlist of sandbox providers the visitor may choose from. |
| `defaultProvider` | `DigitalTwinComputerProviderType?` | Which provider is pre-selected in the visitor connection dialog. |
| `providerCredentialIds` | `Record<provider, string>?` | Author-saved credential ids keyed by provider (stored references, not raw keys). |
| `providerCredentialLabels` | `Record<provider, string>?` | Display labels for each saved author credential. |
| `footerButtonLabel` | `string?` | Custom label for the computer connect button in the chat footer. |
| `lockedModelSettings` | `boolean?` | When `true`, visitors cannot change provider, harness, or model — the author's preconfigured values are used. |
| `preconfiguredHarnessProvider` | `"gabriel_operator" \| "openclaw" \| "hermes"?` | Harness locked for visitors when `lockedModelSettings` is `true`. |
| `preconfiguredLlmModel` | `string?` | LLM / coding-agent model locked for visitors when `lockedModelSettings` is `true`. |
| `preconfiguredHarnessGatewayUrl` | `string?` | OpenClaw or Hermes gateway URL locked for visitors. |
| `autoProvisionMode` | `boolean?` | When `true`, a computer is automatically provisioned per session using the author's system credential; visitors see no setup form. |
| `geminiTools` | `Array<"code_execution" \| "google_search" \| "url_context">?` | Gemini-specific tool subset enabled for Antigravity sessions. Defaults to all three when absent. |

### Supported sandbox providers (`DigitalTwinComputerProviderType`)

| Provider id | Runtime |
|-------------|---------|
| `gemini_managed_agents` | Gemini Antigravity — persistent managed-agent environments (see dedicated section below). |
| `claude_managed_agents` | Claude managed-agent sandbox runtime. |
| `openai_sandbox_agents` | OpenAI Sandbox Agents (bring-your-own OpenAI key). |
| `e2b` | E2B code sandbox — ephemeral skill execution. |
| `daytona` | Daytona dev-environment runtime. |
| `blaxel` | Blaxel serverless sandbox. |
| `modal` | Modal cloud sandbox. |

Providers `e2b`, `daytona`, `blaxel`, and `modal` also support a **harness** selection (`gabriel_operator`, `openclaw`, `hermes`) and an optional gateway URL for custom routing.

### Per-supervisor sandbox (`agentTopology.supervisorAgents[*]`)

Each supervisor agent in `agentTopology.supervisorAgents` can optionally run its own sandbox, **independent of the global `computerConfig`**. This is configured per-card in the Agents column. When set, the supervisor's sandbox takes priority over the global computer binding for that agent's `/skill-run` execution.

Additional fields on each `DigitalTwinSupervisorAgent` entry:

| Field | Type | Purpose |
|-------|------|---------|
| `sandboxProvider` | `DigitalTwinComputerProviderType?` | Sandbox to run this supervisor in. When absent, no sandbox is used regardless of `computerConfig`. |
| `sandboxGeminiCredentialId` | `string?` | RAG provider id (Gemini) used as the Gemini API key for this supervisor's Antigravity session. Bypasses the global computer binding when set. |
| `sandboxApiKeyId` | `string?` | Saved user sandbox provider id for non-Gemini providers. Resolved via `SandboxProvidersService` at run time. |
| `sandboxApiKeyLabel` | `string?` | Display label for the saved non-Gemini credential. |
| `sandboxLlmModel` | `string?` | LLM or managed-agent model id for this supervisor's sandbox (e.g. `antigravity-preview-05-2026`, `openai/gpt-5.5`). |
| `sandboxHarnessProvider` | `"gabriel_operator" \| "openclaw" \| "hermes"?` | Harness for `e2b`/`daytona`/`blaxel`/`modal` sandboxes. |
| `sandboxHarnessGatewayUrl` | `string?` | Gateway URL when harness is `openclaw` or `hermes`. |

**Routing logic (server, `skill-run.controller.ts`):**
- If `sandboxProvider === "gemini_managed_agents"` and `sandboxGeminiCredentialId` is set → resolves the Gemini API key directly via `RAGProvidersService.getGeminiCredentialsForProvider`, skipping the global computer binding.
- If `sandboxProvider === "gemini_managed_agents"` and no `sandboxGeminiCredentialId` → falls back to the global Gemini computer binding (requires the visitor to connect one via the Computer button).
- For other sandbox providers with `sandboxApiKeyId` → resolves via `SandboxProvidersService.resolveProviderCredential` and injects as `sandboxCredentialOverride`.
- `sandboxLlmModel`, `sandboxHarnessProvider`, `sandboxHarnessGatewayUrl` override the effective model/harness/gateway for that supervisor's run.

**Example `agentTopology` entry with per-supervisor Gemini sandbox:**

```json
{
  "agentTopology": {
    "supervisorAgents": [
      {
        "id": "research-supervisor",
        "label": "Research Supervisor",
        "role": "supervisor",
        "enabled": true,
        "instructions": "Coordinate research tasks using the Gemini Antigravity environment.",
        "sandboxProvider": "gemini_managed_agents",
        "sandboxGeminiCredentialId": "<rag-provider-id>",
        "sandboxLlmModel": "antigravity-preview-05-2026"
      }
    ]
  }
}
```

---

## Dedicated Inbox (`emailConfig`)

An AI Persona can expose a **dedicated email inbox** to chat agents. The author configures this in the **Email** tab of the Connectors column; the result is stored as `emailConfig` on the page and round-trips in `publishedConfig`.

### `emailConfig` shape (`DigitalTwinEmailConfig`)

| Field | Type | Purpose |
|-------|------|---------|
| `enabled` | `boolean` | Master switch for dedicated inbox features in chat. |
| `mode` | `"visitor_owned" \| "author_provided" \| "hybrid"` | `visitor_owned` = each visitor connects their own inbox; `author_provided` = author's connection used for all sessions; `hybrid` = author connection saved but visitor may override. |
| `providers` | `DigitalTwinEmailProviderType[]` | Allowed email providers. Defaults to both `["agentmail", "openmail"]`. |
| `authorConnectionIds` | `Record<provider, string>?` | Author-saved email connection ids keyed by provider. |
| `authorConnectionLabels` | `Record<provider, string>?` | Display labels for each saved author connection. |
| `identityFlowEnabled` | `boolean?` | When `true`, enables the identity-verification flow before granting inbox access. |
| `footerButtonLabel` | `string?` | Custom label for the inbox connect button in the chat footer. |

### Supported email providers (`DigitalTwinEmailProviderType`)

| Provider id | Description |
|-------------|-------------|
| `agentmail` | AgentMail — purpose-built agent inbox provider. |
| `openmail` | OpenMail — open email protocol inbox provider. |

**Secrets:** `authorConnectionIds` stores reference ids into the platform's email connection store, not raw tokens or passwords.

---

## Gemini Antigravity Managed Agents

AI Personas that have a **Gemini managed agents** dedicated computer bound can register their `agentTopology` entries (supervisor agents and custom subagents) as individual Gemini managed agents via the `registerGeminiPageAgents` service function. Each registered agent is backed by the `antigravity-preview-05-2026` runtime, receives a stable ID derived from the page ID and agent ID, and is provisioned with:

- A **system instruction** built from the agent's `label`, `description`, `whenToUse`, `instructions`, and `tools`.
- An inline `.agents/AGENTS.md` that describes the agent role and instructs it to write output files to `/workspace/output/`.

### Managed agent ID format

```
dt-{last-8-chars-of-pageId}-{agent-id-slug}
```

Agent IDs are alphanumeric with hyphens, max ~40 characters, stable across re-registrations.

### Registering from server code

```typescript
import { registerGeminiPageAgents } from '../../services/gemini/gemini-managed-agent.service';

const results = await registerGeminiPageAgents({
  pageId: '<mongo-page-id>',
  apiKey: '<gemini-api-key>',
  agentTopology: publishedConfig.agentTopology,  // DigitalTwinAgentTopology
});
// results: Array<{ agentId, agentKey, label, success, error? }>
```

Only agents with `enabled !== false` are registered. Each call is idempotent — if the agent already exists it is deleted and recreated with the latest instructions.

### Slash commands in the sandbox (`/skill-run`)

The `/skill-run` endpoint resolves which sandbox to use in the following priority order:

1. **Per-supervisor sandbox** — if the primary enabled supervisor in `agentTopology.supervisorAgents` has a `sandboxProvider` set, that provider is used (see **Per-supervisor sandbox** above). This takes priority over the global computer binding.
2. **Global dedicated computer** — if `computerConfig.enabled` is `true` and the visitor has connected a runtime, that binding is used.
3. **No sandbox** — falls back to the conventional coding-agent harness (E2B, Daytona, etc. via `sandboxProviderId`).

**Gemini Antigravity path** (when resolved provider is `gemini_managed_agents`):

1. The user's selected skill mentors are mounted as inline `.agents/skills/<slug>/SKILL.md` sources in the Gemini environment.
2. `executeGeminiManagedAgent` is called with the prompt, mentor skill sources, the resolved API key, and the effective managed-agent model id (`sandboxLlmModel` from the supervisor, or the binding's `llmModel`, or `antigravity-preview-05-2026`).
3. After completion the environment snapshot is persisted to `page_generated_media` and output files are surfaced as downloadable attachments in the `skill-run-complete` SSE event.
4. When using the global computer binding (not a per-supervisor credential), `geminiEnvironmentId` and `geminiInteractionId` are saved back to the binding's `sessionMetadata` so subsequent runs continue in the same environment.

**Conventional coding-agent path** (all other sandbox providers):

Uses `executeCodingAgent` with the effective `harnessProvider`, `harnessGatewayUrl`, `llmModel`, and `sandboxCredentialOverride`. The credential override is sourced (in priority order) from: the global dedicated computer binding → the supervisor's `sandboxApiKeyId` resolved via `SandboxProvidersService`.

### Running a managed agent directly (REST / SDK)

```bash
# Inline (no registration required)
curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Api-Revision: 2026-05-20" \
  -d '{
    "agent": "antigravity-preview-05-2026",
    "input": "Run the requested skill task",
    "system_instruction": "<agent instructions>",
    "environment": { "type": "remote" }
  }'

# Via registered managed agent ID
curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Api-Revision: 2026-05-20" \
  -d '{
    "agent": "dt-abc12345-planner-supervisor",
    "input": "Analyze the grocery list and build a complete shopping bundle.",
    "environment": "remote"
  }'
```

Output files written to `/workspace/output/` inside the sandbox are extracted from the environment snapshot tar and served as downloadable assets via `/api/page-builder/digital-twin-computer/:pageId/gemini-environments/:environmentId/file`.

---

## Twilio Telephony
- AI Personas can be used with outbound Twilio phone flows, including direct agent phone calls and run callbacks.
- Twilio phone number selection is page-aware: if the page has a saved `twilioCredentialId` in `publishedConfig` or `vapiAssistantConfig`, that credential is used first; otherwise the backend falls back to the global Twilio environment configuration when allowed.
- Callback telephony is a special case and must not depend on the page's stored voice runtime settings.
- For `run_callback` calls, the voice runtime now uses the system telephony xAI configuration instead of the AI Persona's stored `voiceProvider`, `xaiKeyId`, `xaiVoice`, or other voice-runtime fields.
- For callbacks, the page/agent ID is still important for tools, knowledge-base context, and conversational context, but not for selecting the voice provider.
- Callback telephony still requires the caller/user to have a usable default xAI key available in their profile.
- Twilio telephony requires a public HTTPS backend URL so Twilio can reach the outbound TwiML/status endpoints and the media-stream websocket endpoint.

## Notes
- `pageId` must never be written into portable Git definitions. Schema v2 uses `resourceKey`.
- Passwords and public-access flags are not stored in git; they are managed via the database only (`visibility`, `sharedWith`, `pageSlug`, etc. remain DB-only).
- Default-branch updates sync back into the AI Persona configuration automatically when the product runs a sync to git.
- Older repos may omit `pageProfile` until the next successful sync or pull; the backend treats missing `pageProfile` as valid for reads and fills it on the next write.
