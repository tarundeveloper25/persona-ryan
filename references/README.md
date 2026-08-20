# AI Persona References

Each repository this AI Persona depends on is linked here as a **git submodule**, so a
coding agent can clone the persona and reach every pipeline, list, and Operator command
repository from one place.

```bash
git submodule update --init
```

Private submodules need credentials that can read the linked repositories.

## Linked repositories

| Kind | Name | Path | Branch |
|------|------|------|--------|
| command | Qualify a buyer | `references/commands/6a86eb6cb8a54c2e1a012033` | `main` |
| list | Buyer Qualification Cases | `references/lists/list-99eafe2c385b` | `main` |
| pipeline | Buyer Qualification Pipeline | `references/pipelines/pl-2c40bbc4835c` | `main` |

`registry.json` holds the same mapping as plain JSON, readable without fetching the
submodules. It is generated — edit the persona's pipelines, lists, and commands in the
product instead of editing this folder by hand.
