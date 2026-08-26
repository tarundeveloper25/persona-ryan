# AI Persona References

This folder is a **depth-1 composition workspace**. Every linked repository is a git
submodule of this Persona — never a submodule of another submodule.

```bash
git submodule update --init
```

## Portable bundle (`registry.json`)

Import materializes one Workflow per distinct command workflowRef, plus exactly one Pipeline and one List.

| Kind | Resource key | Name | Path | Branch |
|---|---|---|---|---|
| list *(portable)* | `list.ryan.buyer-qualification-cases` | Buyer Qualification Cases | `references/lists/list-ryan-buyer-qualification-cases` | `main` |
| pipeline *(portable)* | `pipeline.ryan.buyer-qualification-pipeline` | Buyer Qualification Pipeline | `references/pipelines/pipeline-ryan-buyer-qualification-pipeline` | `main` |
| workflow *(portable)* | `workflow.ryan.qualify-a-buyer` | Qualify a buyer | `references/workflows/workflow-ryan-qualify-a-buyer` | `main` |

## Authoring graph (`workspace.json`)

Generated. Do not edit by hand. Extra workflows and team agents live here so one clone
reaches the whole graph. They are **not** cross-environment portable imports.

| Kind | Id | Name | Path | Branch |
|---|---|---|---|---|
| team_agent | `team_agent:ryan-calendar-suggest-slots` | ryan-calendar-suggest-slots | `references/team-agents/ryan-calendar-suggest-slots` | `main` |
| team_agent | `team_agent:ryan-gmail-read-inquiry` | ryan-gmail-read-inquiry | `references/team-agents/ryan-gmail-read-inquiry` | `main` |
| team_agent | `team_agent:ryan-sheets-check-budget` | ryan-sheets-check-budget | `references/team-agents/ryan-sheets-check-budget` | `main` |

Commit content in each child repository first, then **publish the workspace** so this
Persona lock (gitlinks, fingerprints, and `workspace.json`) advances in one root commit.
