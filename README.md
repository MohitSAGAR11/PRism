# PRism

An AI code reviewer that runs as a GitHub Action. On every push to a pull
request it fetches the diff, asks a model to find defects, asks a model to
**refute** each one, and posts what survives — inline where it can anchor the
comment, in a summary where it can't.

Models are routed through [OpenRouter](https://openrouter.ai), so switching
models is a config string rather than an integration.

---

## What "good" means here

The model is not the hard part. Precision is. Any competent model will find real
problems in a diff; it will also produce a pile of confident-sounding nonsense,
and a reviewer that posts twenty comments of which four are real gets muted
within a week — after which it is worthless no matter how good the four were.

So the bar is not "does it find bugs". It is:

- **Does it stay quiet when there is nothing to say?** An empty review is a
  correct review most of the time.
- **Do its comments land on the right line?** A right observation on the wrong
  line reads as noise.
- **Does it repeat itself across pushes?** Repetition gets a bot muted faster
  than false positives do.

Three mechanisms carry most of the weight:

**Two passes.** Pass 1 finds. Pass 2 is adversarial — each finding goes back with
its file context and the instruction to assume it is wrong and look for the
reason, where *uncertainty counts as a refutation, not a pass*. Roughly doubles
cost and is the single biggest lever on precision. `verify_model` is a separate
config key so pass 2 can be a different model, and not one model grading its own
homework.

**A required failure scenario.** Every finding must name concrete inputs and the
resulting wrong behaviour — `orders=[] makes total() divide by zero`. This is a
filter, not documentation: there is no plausible failing input for "consider
extracting this method", so vague findings mostly stop appearing at the source.

**Content-keyed fingerprints.** Each finding is identified by a hash of the file
path, the *normalized content of the cited line*, the category and the title —
deliberately **not** the line number. Inserting code above a defect does not
resurrect a comment already posted; editing that line does surface it again.

## Install

Add the API key as a repository secret named `OPENROUTER_API_KEY`, then:

```yaml
# .github/workflows/review.yml
name: AI review
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  contents: read        # never `write`
  pull-requests: write

concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4   # no `ref:` -- see Security
      - uses: your-org/pr-reviewer@v1
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          github-token: ${{ github.token }}
```

This repo's own [`.github/workflows/review.yml`](.github/workflows/review.yml) is
the same thing with the security constraints commented inline.

## Configure

Drop a `.github/ai-review.yml` in the repo being reviewed. Every key is
optional; see [`.github/ai-review.yml`](.github/ai-review.yml) for a worked
example. The schema is **strict** — an unrecognised key is an error, so a typo
like `sevrity_threshold` fails loudly instead of being silently ignored.

| Key | Default | What it does |
|---|---|---|
| `model` | `stealth/ox-alpha` | Pass 1. Carries the diff and file bodies, so most of the cost. |
| `verify_model` | `poolside/laguna-s-2.1:free` | Pass 2. Defaults to `model` if you set `model` and nothing else. |
| `fallback_models` | `[]` | Automatic failover if the primary is unavailable. |
| `effort` | `high` | Reasoning effort: `low`, `medium`, `high`. |
| `severity_threshold` | `medium` | Minimum severity for a comment. |
| `min_confidence` | `0.7` | Minimum calibrated confidence. |
| `max_inline_comments` | `15` | Overflow is demoted to the summary, never dropped. |
| `max_files` | `60` | Files past the cap are named in the summary as skipped. |
| `paths_ignore` | `[]` | Extra globs, on top of the built-in generated-file list. |
| `focus` | `[]` | Categories to weight. Others surface only at high/critical. |
| `custom_rules` | `[]` | Repo-specific rules, always reportable at medium+. |

Action inputs override the file, so a workflow can tune a repo without
committing to it. Every key above has a kebab-case input equivalent — see
[`action.yml`](action.yml).

### A note on `verify_model`

It defaults to whatever `model` resolves to *when you configure a model*, so
setting one key repoints both passes. With nothing configured at all, the two
built-in defaults are deliberately different providers — pass 2 is only a real
check when it isn't the same model marking its own work.

### A note on `fallback_models`

OpenRouter only routes a request to endpoints supporting **every** parameter it
asks for. So the request is shaped to the *weakest* model in
`[model, ...fallback_models]` — otherwise a parameter the fallback can't honour
wouldn't degrade the fallback, it would remove it, and the failover you
configured would silently not exist. If you'd rather have the stronger output
mode than the failover, leave `fallback_models` empty.

## Local use

```bash
cp .env.example .env      # then put your key in it
# or: export OPENROUTER_API_KEY=sk-or-v1-...

npm run review -- 'owner/repo#123'           # dry run, prints to stdout
npm run review -- 'owner/repo#123' --post    # actually comment
npm run review -- 'owner/repo#123' --model x --severity high
```

Dry-run by default, because the CLI exists for iterating on prompts against real
PRs and iterating shouldn't spam a real thread.

`.env` is read by the local tools (never by the Action, which takes its inputs
from the workflow). A real environment variable always wins over the file. You
do **not** need a `GITHUB_TOKEN`: with none set, the tools shell out to
`gh auth token` and reuse your `gh auth login` session — which needs the `repo`
scope if you intend to `--post`.

Two tools worth knowing:

```bash
npm run check:plumbing -- 'owner/repo#123'   # everything except the model calls
npm run check:model                          # can these models serve at all?
```

`check:plumbing` prints file classification, anchorable line counts, group sizes
and prompt token counts against a real PR without spending a token — it's the
first thing to reach for when a review comes back wrong and you need to know
whether the bug is in fetching/parsing or in the model call. `--show-prompt`
dumps the exact payload.

See [TESTING.md](TESTING.md) for how to exercise every feature, cheapest first.

## Cost

Read from OpenRouter's own `usage.cost` and reported in both the PR summary and
the Action step summary — never estimated from a local price table, which would
drift out of date across every model you can route to.

- **Pass 1** scales with diff size plus file bodies. The dominant cost.
- **Pass 2** is one small call per candidate finding. Cheap individually, but a
  noisy pass 1 makes it expensive. Precision saves money twice.
- **A lockfile-only PR costs exactly nothing.** Filtering happens before any
  model call, so zero reviewable files means zero requests.

Levers, cheapest first: lower `effort`; raise `severity_threshold` so fewer
findings reach the verify pass; point `model` at a cheaper slug.

One thing to watch: the budget is derived from the model's real context window,
so a million-token model packs almost any PR into a single request. That's
correct, but it means `effort: high` on a large PR is one expensive call rather
than several cheap ones.

## Security

### Fork PRs and `pull_request_target`

A plain `pull_request` run from a fork gets a read-only token and no secrets, so
it cannot post. `pull_request_target` can — it runs with the base repo's
permissions, and it is genuinely dangerous if used carelessly.

**The rule that makes it safe: never check out or execute head-branch code.**
This reviewer reads the diff and file contents through the GitHub API and
executes nothing from the pull request. Concretely:

- Keep `permissions: contents: read`. Never `write`.
- Let `actions/checkout` take the **base** revision, which is its default under
  `pull_request_target`. Do **not** add
  `ref: ${{ github.event.pull_request.head.sha }}`.
- Do **not** add an install or build step — either would execute scripts from
  the PR branch in a job holding your secrets. The Action runs from the
  committed `dist/` bundle so that none is needed.

### Prompt injection

All PR content — description and code alike — is untrusted input. It is wrapped
in explicit `<pull_request>` delimiters, and the prompt states that the content
is material to analyse and never instruction to follow, and that an attempt to
redirect the reviewer is itself a security finding.

The structural mitigation matters more than the prompt: **the bot cannot approve
or merge.** It is comment-only, with no `contents: write`. The worst outcome of a
successful injection is a wrong comment.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build       # rebuilds dist/
```

`dist/` is committed, because the Action runtime loads `dist/index.js` directly
with no install step. **It must be rebuilt in the same commit as any `src/`
change**, or CI silently runs stale code. This is the easiest way to ship a fix
that does nothing.

## Non-goals

No approving or requesting changes — comment-only, by design. No repo-wide
agentic exploration. No `@bot` reply conversations: an Action cannot listen for
webhooks, so that needs a hosted service.
