# Testing guide

How to exercise every feature, ordered **cheapest first** — so a break stops you
before it costs anything. Each tier assumes the ones before it passed.

| Tier | Needs | Cost | Proves |
|---|---|---|---|
| [0](#tier-0--offline) | nothing | free | the pure logic: diff parsing, filtering, grouping, fingerprints, routing |
| [0b](#tier-0b--endpoint-capability-logic) | nothing | free | requests are shaped to what the endpoint actually accepts |
| [1](#tier-1--real-github-zero-tokens) | a GitHub token | free | fetching, classification, anchoring, prompt assembly |
| [2](#tier-2--first-model-calls) | an OpenRouter key | cents | the models can serve at all, then a full review |
| [3](#tier-3--scratch-repo-end-to-end) | a scratch repo | cents | posting, line placement, and cross-push dedupe |
| [4](#tier-4--the-action-in-ci) | a repo secret | cents | the bundle, the workflow, the step summary |
| [5](#tier-5--the-eval-scoreboard) | labelled fixtures | dollars | whether a prompt or model change actually helped |

A running note: several checks below say *read the output*, not *check it exited
0*. Those are the ones that catch real bugs. Exit codes catch crashes; the
failures that matter here are the ones where everything "works" and the answer is
wrong.

---

## Tier 0 — offline

```bash
npm run typecheck     # must be silent
npm test              # 87 tests, 5 files
```

Per-file, when you want a fast loop:

```bash
npm test -- diff       # 15  the diff parser
npm test -- filters    # 14  skip rules and glob matching
npm test -- review     # 26  config, fingerprints, the bar, split routing, summary
npm test -- collect    # 11  grouping, context rendering, the concurrency pool
npm test -- llm        # 21  endpoint capabilities, usage accounting, budget
```

### What each group defends

When one of these fails, this is the invariant that broke — not just the file.

| Tests | Invariant | Symptom if it breaks |
|---|---|---|
| `diff` — line numbering | Added/context lines report the correct head-revision line | Every inline comment lands on the wrong line |
| `diff` — `commentableLines` | Deleted lines are never commentable | GitHub 422s and rejects the **whole** review |
| `diff` — no-newline marker | `\ No newline at end of file` moves neither counter | Off-by-one after any such hunk |
| `diff` — multi-hunk | Counters reset from each `@@` header | Second hunk in a file is misnumbered |
| `filters` — skip reasons | Every skip carries a reason | Files vanish from the review with no explanation |
| `filters` — glob anchoring | A glob matches whole paths, not substrings | `src/a.ts` ignored because `other/src/a.ts` matched |
| `review` — config strictness | An unknown key throws | A typo'd setting is silently ignored forever |
| `review` — fingerprints | Keyed on cited *content*, never the line number | Comments repeat on every push, or never resurface after a real edit |
| `review` — split routing | Unanchorable findings are demoted, not dropped or force-posted | Lost findings, or a 422 that kills the review |
| `review` — the ledger | Every reported fingerprint is written into the summary | Summary-only findings re-report on the next push |
| `collect` — grouping | No file is lost; an oversized file gets its own group | Silently unreviewed files |
| `collect` — `mapPool` | Input order preserved, concurrency respected | Findings attributed to the wrong file; rate limits |
| `llm` — output mode | Requests only ask for parameters the endpoint lists | **Zero successful model calls** |
| `llm` — catalogue failure | A catalogue miss is not fatal | A transient OpenRouter blip fails the review |

### Three things the suite can't check for you

Do these by hand once, and again after touching `github/diff.ts`.

**1. The anchoring trace.** For this patch:

```
@@ -1,3 +1,5 @@
 const a = 1;
 const b = 2;
+const c = 3;
+const d = 4;
 use(a);
```

The two added lines must report `newLine` **3** and **4**, and the trailing
context line must report `newLine` **5**, `oldLine` **3**. If that is off by one
in either direction, every inline comment downstream lands wrong — and the first
symptom is a 422 from GitHub weeks later, not a failing test today.

**2. No silent skips.** `partitionFiles` must never return a skipped file with an
empty `reason`. A skip nobody can explain reads to a PR author as "the bot
ignored my file".

**3. Nothing lost in grouping.** Assert *sorted input paths == sorted output
paths* across all groups — not a count comparison. A count can match by
coincidence while a file was swapped for a duplicate.

---

## Tier 0b — endpoint capability logic

This is the newest and riskiest logic, and it is entirely offline.

The problem it solves: on OpenRouter, structured-output and reasoning support is
per **endpoint**, not per model. Combined with
`provider: { require_parameters: true }`, asking for a parameter an endpoint
doesn't list doesn't degrade gracefully — **the request doesn't route at all.**
Both configured models are affected: neither advertises `structured_outputs`, and
`poolside/laguna-s-2.1:free` advertises no `response_format` either.

```bash
npm test -- llm
```

The three modes, and what must be true of each:

| Endpoint advertises | Mode | Request carries | Schema travels in |
|---|---|---|---|
| `structured_outputs` | `json_schema` | `response_format` + `require_parameters` | the request |
| `response_format` only | `json_object` | `response_format` + `require_parameters` | the prompt |
| neither | `prompt_only` | no `response_format`, no `require_parameters` | the prompt |

Four behaviours worth checking explicitly, because each one is a way to break
routing silently:

- `stealth/ox-alpha` → `json_object` (it has `response_format`, not
  `structured_outputs`).
- `poolside/laguna-s-2.1:free` → `prompt_only`, and `reasoning: {effort}` is
  **omitted** (it exposes `reasoning` but not `reasoning_effort`).
- A model missing from the catalogue → `json_schema`. An empty capability list
  means the lookup failed, not that the model supports nothing; degrading an
  unknown model would be the wrong default.
- With `fallback_models` set, the mode is the **weakest across the whole
  candidate list**. This is the subtle one: `require_parameters` filters
  endpoints, so a parameter the fallback can't honour doesn't degrade the
  fallback — it removes it, and the failover you configured silently isn't there.

The schema always travels somewhere, and the response is always re-validated with
zod plus one retry that feeds the error back. That client-side check is the only
guarantee that holds across every provider — OpenRouter documents `strict` as
enforced by some and advisory on others.

---

## Tier 1 — real GitHub, zero tokens

`scripts/plumbing-check.ts` runs everything except the model calls. It is the
tool to reach for whenever a live review comes back wrong and you need to know
whether the bug is in fetching/parsing or in the model.

```bash
npm run check:plumbing -- 'owner/repo#123'
npm run check:plumbing -- 'owner/repo#123' --show-prompt
```

Run three PRs of deliberately different shapes:

| PR shape | Required output |
|---|---|
| A small code change | non-zero anchorable line count, and **exactly one** request group |
| **Lockfile-only** | **0 reviewable files, 0 groups** |
| Opened from a fork | `fork=true` |

Two verified examples, so you have a known-good baseline to compare against.
(Both were open when this was written; if they have since merged, pick any PR of
the same shape.)

```
$ npm run check:plumbing -- 'honojs/hono#5294'
PR #5294: fix(request): preserve urlencoded media type when cloning ...
  author=chuanghiduoc head=7567298 fork=true
2 changed file(s): 2 reviewable, 0 skipped
  review src/request.test.ts - 1 hunk(s), 19 added, 25 commentable line(s)
  review src/request.ts - 1 hunk(s), 11 added, 17 commentable line(s)
Total anchorable lines: 42
Budget 65280 tokens -> 1 request group(s)
System prompt: 918 tokens (the cacheable prefix)
```

```
$ npm run check:plumbing -- 'facebook/react#37349'
PR #37349: Bump brace-expansion from 1.1.8 to 1.1.18 in /scripts/bench
1 changed file(s): 0 reviewable, 1 skipped
  skip  scripts/bench/yarn.lock (generated or vendored)
Total anchorable lines: 0
Budget 65280 tokens -> 0 request group(s)
```

Note the 918-token system prompt in the first one: that is **below** the
roughly 1,024-token minimum most providers require before they will cache a
prefix at all. Caching works in repos with real convention files and silently
does not in repos without them, so check `cachedTokens` in a usage line rather
than assuming.

The lockfile-only case is the important one. Zero groups is what proves the
filtering happens *before* any model call — which is why such a PR costs exactly
nothing. If it reports even one group, the cost model is wrong.

The script throws by itself if there is at least one reviewable file but the
anchorable total is zero, because that combination can only mean the diff parser
is broken.

**Then read the `--show-prompt` output.** Specifically: compare the gutter line
numbers in the rendered diff against what github.com shows for that same file and
hunk. This is the only check that catches a render path silently disagreeing with
the parse path. Exiting 0 is not the pass criterion here.

---

## Tier 2 — first model calls

### 2a. Can these models serve at all? (fractions of a cent)

Do this before any full review. It isolates a routing or structured-output
failure from a pipeline failure, and given how the capability logic works it is
the single most valuable paid test in this guide.

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
npm run check:model                                  # both configured defaults
npm run check:model -- stealth/ox-alpha              # one specific slug
```

Expected per model: the context window, `catalogue found`, the chosen output
mode, whether reasoning effort was sent, a `servedBy` slug, non-zero prompt
tokens, a schema-valid `value`, and `RESULT ok`.

Known-good baseline:

```
poolside/laguna-s-2.1:free   262,144      prompt_only   effort omitted
stealth/ox-alpha           1,048,576      json_object   effort sent
```

If a model reports `RESULT FAILED`, run the same slug against
`GET /api/v1/models` and compare `supported_parameters` against the mode table in
tier 0b before touching anything else. A failure here is almost always a
parameter the endpoint doesn't accept, not a bug in the review logic.

### 2b. A full review, dry (a few cents)

```bash
npm run review -- 'owner/repo#123'
```

Four things to verify — all four, not just that it exited cleanly:

1. **Every finding is schema-valid.** If it weren't, `completeStructured` would
   have thrown a `SchemaViolationError` instead of printing findings.
2. **The verify pass killed some findings.** Look for
   `N survived verification, M refuted`. If `M` is 0 across a couple of
   different PRs, `VERIFY_INSTRUCTIONS` is too lenient — tighten it until it
   refutes roughly 20% or more. That is a prompt problem, not a bug, and
   trusting the pipeline before you fix it means trusting unchecked findings.
3. **Every inline `path:line` really appears in that file's diff** on
   github.com. This is the live version of tier 1's anchorability assertion.
4. **Cost is in the right ballpark** — cents for a small diff, not dollars. If
   it's dollars, check whether `effort: high` is pointed at one enormous group.

A verified baseline, both passes exercised:

```
$ npm run review -- 'honojs/hono#5289'
  model=stealth/ox-alpha verify=poolside/laguna-s-2.1:free effort=high
  5 file(s) to review, 0 skipped
  context window 1048576, input budget ~534773 tokens
  1 request group(s)
  1 candidate finding(s)
  0 survived verification, 1 refuted
  ...
Models: poolside/laguna-s-2.1:free, stealth/ox-alpha
Usage: 24,900 in / 523 out / $0.0000
```

Both models appearing in the `Models:` line is the sign the verify pass really
ran on a different model. A refuted finding lands in the summary's *Dropped by
verification* block with the reason attached - read one, and judge whether the
refutation is sound. A verify pass that refutes everything is as much a problem
as one that refutes nothing.

Note the input budget: a million-token context window means almost any PR
becomes a single request group. That is correct, but it makes `effort: high` on
a large PR one expensive call rather than several cheap ones.

### 2c. Every CLI path

```bash
npm run review -- 'owner/repo#123' --post
npm run review -- 'owner/repo#123' --model stealth/ox-alpha
npm run review -- 'owner/repo#123' --verify-model poolside/laguna-s-2.1:free
npm run review -- 'owner/repo#123' --severity high
npm run review -- 'owner/repo#123' --max-inline 3
npm run review -- 'owner/repo#123' --quiet          # stdout stays clean
```

And the error paths, which are most of the surface a user actually hits. Each
must print **one** clear line and exit non-zero — never a stack trace.

| Command | Expected |
|---|---|
| `npx tsx src/cli.ts --help` | usage on stdout, exit **0** |
| `npx tsx src/cli.ts` | `missing pull request reference` |
| `npx tsx src/cli.ts 'not-a-valid-ref'` | `Expected a pull request reference like "owner/repo#123"` |
| `npx tsx src/cli.ts 'owner/repo#1' --severity nonsense` | `--severity must be one of low, medium, high, critical` |
| `npx tsx src/cli.ts 'owner/repo#1' --bogus` | `unknown option --bogus` |
| `OPENROUTER_API_KEY= npx tsx src/cli.ts 'a/b#1'` | `OPENROUTER_API_KEY is not set` |

`--quiet` matters more than it looks: progress goes to stderr so stdout stays
pipeable. `npm run review -- ... --quiet > review.md` should produce a clean file.

---

## Tier 3 — scratch repo end-to-end

Everything above can pass while posting is still broken. This tier is the only
way to test the fingerprint ledger, and **the second push is the part most people
skip and the part most likely to reveal a real bug.**

### Set up

```bash
gh repo create my-scratch-repo --private --clone
cd my-scratch-repo
git commit --allow-empty -m "init" && git push -u origin main
git checkout -b add-orders
mkdir -p src
```

Create `src/orders.ts` with three deliberate defects of different shapes, so each
finding category can be judged independently:

```ts
export interface Order {
  id: string;
  total: number;
}

async function fetchOrder(id: string): Promise<Order> {
  const res = await fetch(`https://api.example.com/orders/${id}`);
  return (await res.json()) as Order;
}

// Defect 1 (bug, off-by-one): `<=` reads one element past the end, so the last
// iteration dereferences undefined.
export function highestTotal(orders: Order[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= orders.length; i += 1) {
    if (orders[i].total > best) best = orders[i].total;
  }
  return best;
}

// Defect 2 (edge-case, empty input): no guard on an empty list, so the result
// is NaN rather than 0 or an error.
export function averageTotal(orders: Order[]): number {
  const sum = orders.reduce((acc, o) => acc + o.total, 0);
  return sum / orders.length;
}

// Defect 3 (performance, N+1): one request per id, serially, instead of one
// batched request.
export async function loadAll(ids: string[]): Promise<Order[]> {
  const loaded: Order[] = [];
  for (const id of ids) {
    loaded.push(await fetchOrder(id));
  }
  return loaded;
}
```

```bash
git add src/orders.ts && git commit -m "add order helpers" && git push -u origin add-orders
gh pr create --fill
```

### First review

```bash
cd ../pr-reviewer
npm run review -- 'you/my-scratch-repo#1' --post
```

Open the PR and check:

| Check | Pass criterion |
|---|---|
| Placement | Each comment sits on the line its finding cites — the loop bound, the division, the awaited call |
| Coverage | At least the off-by-one and the empty-list case are found. Verification refuting the N+1 is *not* a failure — read its `reason` and judge whether the refutation is sound |
| Failure scenarios | Every comment has a **Fails when:** line naming concrete inputs |
| Summary comment | Exists, even if every finding got an inline slot |
| Categories | Severity/category labels are plausible for each defect |

### Second review — the dedupe test

Push a commit that **inserts lines above** the defects without touching them.
That shifts every defect's line number while leaving the cited content identical,
which is exactly the case the fingerprint design exists for.

```bash
cd ../my-scratch-repo
# Prepend an unrelated helper at the TOP of src/orders.ts:
#   export function formatOrder(o: Order): string {
#     return `${o.id}: ${o.total}`;
#   }
git commit -am "add a formatter" && git push
cd ../pr-reviewer
npm run review -- 'you/my-scratch-repo#1' --post
```

| Check | Pass criterion |
|---|---|
| **No repeats (inline path)** | Not one previously posted comment appears again, despite every line number having moved |
| **No repeats (ledger path)** | A finding that was summary-only last push is also not repeated. This is the half that fails silently — the summary is rewritten each run, so without the ledger its fingerprints vanish |
| Duplicates section | The summary's *Already reported on an earlier push* block accounts for them |
| New code is reviewed | Findings in `formatOrder`, if any, are new — the run isn't skipping the file wholesale |

Then push a **third** commit and run once more. The ledger bug only manifests on
push two or three; running once and calling the feature done proves nothing.

### Forcing the 422 fallback

GitHub rejects an entire review if any single comment names a line outside the
diff, so the fallback matters more than it looks. To exercise it, temporarily
make `splitFindings` emit a line that can't anchor — e.g. in
`src/review/render.ts`, hardcode `line: f.line + 5000` where the inline comment
is built — then run with `--post`.

Expected: no crash, no lost findings. The summary comment gains an
`### Inline placement failed` section containing every finding with its
`path:line`, and the run logs
`inline placement was rejected; posted everything in the summary`. Revert the
edit afterwards.

---

## Tier 4 — the Action in CI

### The bundle loads

```bash
npm run build
node dist/index.js
```

Must print exactly `::error::Input required and not supplied: openrouter-api-key`
and exit non-zero. That specific message — not a stack trace, not a
module-resolution error — is what proves the ~8 MB bundle parsed and started
executing `main()`. Anything else means the bundling step is broken, not the
input validation.

### Stale `dist/` — the trap that ships fixes that do nothing

`dist/` is committed because the Action runtime loads `dist/index.js` with no
install step. It **must be rebuilt in the same commit as any `src/` change**, or
CI silently runs old code.

```bash
npm run build && git status --short dist/
```

If that prints changes after you thought you were done committing, your last
commit shipped stale code. Worth a pre-push hook.

### The workflow

Add `OPENROUTER_API_KEY` as a repository secret, then open any PR against this
repo. `.github/workflows/review.yml` fires on
`pull_request_target: [opened, synchronize, reopened]`.

| Check | Pass criterion |
|---|---|
| Trigger | The run appears on PR open and again on each push |
| Concurrency | A second push cancels the first still-running review |
| Step summary | Shows the headline, file/comment/refuted counts, models, and usage |
| Log | Shows the resolved model and verify model, group count, candidate count, `N survived / M refuted` |
| Outputs | `findings`, `inline-comments`, `cost-usd`, `models` are all set |
| Fork PR | A PR from a fork still posts (this is why `pull_request_target` is used) |

**Security regressions to check by reading the workflow**, since no test can
catch them:

- `permissions:` has `contents: read` and never `write`.
- The `actions/checkout` step has **no** `ref:` override.
- There is **no** install or build step in the job.

Any of the three would turn a prompt injection from "a wrong comment" into
arbitrary code execution with your secrets. The file has these commented inline
next to the lines they protect; if you find yourself deleting a comment to make
room for a step, that is the moment to stop.

---

## Tier 5 — the eval scoreboard

```bash
cp fixtures/cases.example.json fixtures/cases.json
# edit with real refs and real line numbers -- see fixtures/README.md
npm run eval -- --models stealth/ox-alpha,poolside/laguna-s-2.1:free
```

Read the line numbers off `npm run check:plumbing -- owner/repo#N --show-prompt`,
not off the GitHub UI — they can disagree, and a label off by four lines scores a
correct finding as a miss.

| Check | Pass criterion |
|---|---|
| Default model path | `npm run eval` with **no** `--models` runs against the configured default. It must not fail with an empty model slug |
| Sample size | At least a dozen labelled cases before you believe a percentage |
| Differentiation | Two models produce visibly different rows. If every model scores identically, suspect the harness before concluding the models are equivalent |
| Missed list | Read every entry under `missed by` |
| Unlabelled list | Read them for at least one model. Some are real defects nobody labelled — promoting those into `cases.json` is how the scoreboard stays honest instead of frozen at day-one quality |

Note that `precision` here is a lower bound: "unlabelled" counts findings your
fixture doesn't mention, which is not the same as "wrong".

---

## Troubleshooting

| Symptom | Likely cause | Isolate with |
|---|---|---|
| No successful model calls at all | The endpoint doesn't accept a requested parameter | Tier 2a — `npm run check:model` |
| `SchemaViolationError` after 2 attempts | Model can't hold the shape in prompt-only mode | Tier 0b — check the resolved mode; try a model with `structured_outputs` |
| Comments land on the wrong lines | Diff parser off-by-one | Tier 0 — the anchoring trace |
| Review posted nothing at all | 422 from an unanchorable comment | Tier 3 — the 422 fallback test |
| Comments repeat every push | Ledger not unioned forward | Tier 3 — second and third push |
| A finding never resurfaces after a real edit | Fingerprint keyed on too much | Tier 0 — `npm test -- review` |
| Files silently unreviewed | Skip rule or the file cap | Tier 1 — read the skip reasons |
| Verify refutes nothing | `VERIFY_INSTRUCTIONS` too lenient | Tier 2b — a prompt fix, not a code fix |
| Cost 10x expected | One huge group at `effort: high` | Tier 1 — group count and token sizes |
| Fix deployed, nothing changed | Stale `dist/` | Tier 4 — `npm run build && git status dist/` |
| Cache never hits | Prefix under the provider minimum, or something volatile in the system prompt | Check `cachedTokens` in the usage line across repeated runs |

## Checkpoint coverage

Every checkpoint from the original build guide, and where it lives here:

| Checkpoint | Tier |
|---|---|
| 0 scaffold, 1 diff parser, 2 filters/config, 3 tokens/pool | 0 |
| 4 first structured call | 2a |
| 5 grouping, 6 fingerprints, 7 the two passes, 8 render/split, 9 ledger | 0 |
| 10 plumbing check | 1 |
| 11 the bundle | 4 |
| 12 CLI error paths | 2c |
| 13 first real review | 2b |
| 14 scratch repo and the second push | 3 |
| 15 eval harness | 5 |
