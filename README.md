<!-- atlas-models-sync: skip-file — this doc quotes the marker syntax; never rewrite it -->
# AtlasCloudAI org-wide automation

Shared GitHub automation for AtlasCloudAI repositories.

## Live model-catalog sync (`update-models-readme`)

Keeps the "Supported Models" sections of our repos in sync with the **live**
model catalog (`GET https://api.atlascloud.ai/api/v1/models`) instead of
hand-written, perpetually stale lists.

- Script: [`scripts/update-models-readme.mjs`](scripts/update-models-readme.mjs) (zero-dependency Node ≥ 18)
- Reusable workflow: [`.github/workflows/update-models-readme.yml`](.github/workflows/update-models-readme.yml)
- Currently onboarded: `mcp-server`, `atlas-cloud-skills`, `cli`

### How it works

1. A thin caller workflow in each repo runs daily (cron) or on demand (`workflow_dispatch`).
2. It calls the reusable workflow here, which fetches the live catalog, filters
   `display_console`, groups models by platform category, and rewrites every
   `ATLAS-MODELS` marker block found in the repo's markdown files.
3. If (and only if) the catalog changed, it commits with the caller repo's own
   `GITHUB_TOKEN`. No secrets, no cross-repo PATs.

### Onboarding a new repo (2 steps)

**1.** Wrap the section you want auto-updated in markers (attributes optional):

```markdown
<!-- ATLAS-MODELS:START lang=en campaign=my-repo -->
(anything here is overwritten)
<!-- ATLAS-MODELS:END -->
```

Attributes: `lang=en|zh-CN|ja|ko|es|fr` · `campaign=<utm_campaign>` ·
`groups=video,image,3d,llm,audio` (subset/order) · `featured=<n>` (names per line).
Multiple blocks per file and multiple files per repo are fine — every block is found automatically.

**2.** Add `.github/workflows/sync-models.yml`:

```yaml
name: sync-models
on:
  schedule:
    - cron: "17 2 * * *"
  workflow_dispatch: {}
permissions:
  contents: write
jobs:
  sync:
    uses: AtlasCloudAI/.github/.github/workflows/update-models-readme.yml@main
```

### Escape hatch

A markdown file that needs to QUOTE the marker syntax without being rewritten (like this
README) can opt out entirely by containing the literal directive `atlas-models-sync: skip-file`
anywhere in the file (put it in an HTML comment).

### Design notes

- **New platform categories are never dropped**: categories the script doesn't
  recognize are auto-collected into a "More" group (opt-in via `groups=...,more`),
  so when the platform launches a new modality the READMEs pick it up without a
  script change.
- **Featured names are data-driven**: per category group, model families are
  ranked by the platform's own `priority` field — no hand-curated lists to rot.
- **No date stamps inside blocks**: reruns are byte-identical unless the catalog
  actually changed, so the cron stays silent on quiet days.
- **Fail-closed**: any API error aborts before touching files.
