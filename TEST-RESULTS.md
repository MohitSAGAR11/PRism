# PRism field test — 2026-08-25

End-to-end test of whether the reviewer actually reviews pull requests.

- **Repo under test:** https://github.com/MohitSAGAR11/prism-scratch (private)
- **PR:** #2, branch `add-orders`
- **Models:** `stealth/ox-alpha` (find) + `poolside/laguna-s-2.1:free` (verify)
- **Total spend:** $0.0000

## Verdict

**It works.** It found every defect that mattered, placed all three comments on
exactly the right lines, and found a real bug nobody planted.

Two defects turned up in the tool itself. One is significant: cross-push
de-duplication — the mechanism that stops the bot repeating itself — worked on
only one of three findings.

| | |
|---|---|
| Comments on correct lines | 3 / 3 |
| Unplanted real bugs found | 1 |
| Deduped on second push | 1 / 3 |
| Verify verdict inverted | once |

---

## Part 1 — before touching a PR

Cheapest checks first, so a break stops the run before it costs anything.

### Step 0 — offline suite and typecheck

```bash
npm run typecheck && npm test
```

```
✓ tests/diff.test.ts     (15 tests)
✓ tests/filters.test.ts  (14 tests)
✓ tests/review.test.ts   (26 tests)
✓ tests/collect.test.ts  (11 tests)
✓ tests/llm.test.ts      (21 tests)

Test Files  5 passed (5)
     Tests  87 passed (87)
```

**PASS** — typecheck silent, 87/87 green.

### Step 1 — can these two models serve at all?

The most valuable paid test, because neither model advertises
`structured_outputs`. Isolates a routing failure from a pipeline bug.

```bash
npm run check:model
```

```
stealth/ox-alpha
  context window     1,048,576
  output mode        json_object
  reasoning effort   sent
  usage              277 in (128 cached) / 497 out / $0.0000
  RESULT             ok

poolside/laguna-s-2.1:free
  context window     262,144
  output mode        prompt_only
  reasoning effort   omitted
  RESULT             ok

all 2 model(s) returned schema-valid JSON
```

**PASS** — both route and return schema-valid JSON. Prompt caching engaged too
(`128 cached`).

### Step 2 — fetching and filtering, zero tokens

```bash
npm run check:plumbing -- 'facebook/react#37349'
```

```
PR #37349: Bump brace-expansion from 1.1.8 to 1.1.18
1 changed file(s): 0 reviewable, 1 skipped
  skip  scripts/bench/yarn.lock (generated or vendored)
Total anchorable lines: 0
Budget 65280 tokens -> 0 request group(s)
```

**PASS** — a lockfile-only PR produces zero request groups, so it costs exactly
nothing. Filtering really does happen before any model call.

---

## Part 2 — the live run

### Step 3 — create the repo, plant three defects

```bash
gh repo create prism-scratch --private --clone
# wrote src/orders.ts, committed, pushed, opened PR
```

Three deliberate defects of different shapes, so each finding category can be
judged on its own:

```
14:  for (let i = 0; i <= orders.length; i += 1) {   # off-by-one
23:  return sum / orders.length;                     # divides by zero
30:    loaded.push(await fetchOrder(id));            # N+1, serial
```

**DONE** — PR opened against `main`.

> Note: the first attempt (PR #1) was committed with the wrong author email. I
> rewrote both commits with `MohitSAGAR11 <mohitsagar378@gmail.com>` and
> force-pushed, which auto-closed PR #1. PR #2 replaced it. Nothing had been
> posted yet, so no review state was lost.

### Step 4 — confirm the lines are anchorable

```bash
npx tsx scripts/plumbing-check.ts 'MohitSAGAR11/prism-scratch#2'
```

```
1 changed file(s): 1 reviewable, 0 skipped
  review src/orders.ts - 1 hunk(s), 33 added, 33 commentable line(s)
Total anchorable lines: 33
System prompt: 797 tokens (the cacheable prefix)
  group 1: 1 file(s), user payload 838 tokens

plumbing OK - no model calls made
```

**PASS** — all 33 lines commentable, so 14, 23 and 30 are all reachable. A
comment landing wrong from here would be the model's fault, not the parser's.

### Step 5 — first review, posted for real

```bash
npx tsx src/cli.ts 'MohitSAGAR11/prism-scratch#2' --post
```

```
model=stealth/ox-alpha verify=poolside/laguna-s-2.1:free effort=high
1 request group(s)
5 candidate finding(s)
  verifying 1/5: Off-by-one loop bound reads past end of array
  verifying 2/5: averageTotal returns NaN for an empty array
  verifying 3/5: highestTotal returns -Infinity for an empty array
  verifying 4/5: loadAll fetches sequentially
  verifying 5/5: fetchOrder ignores HTTP status and casts body blindly
4 survived verification, 1 refuted
posted 3 inline comment(s)

Usage: 8,561 in (1,184 cached) / 1,482 out / $0.0000
```

**PASS** — three comments plus a summary comment. One finding fell below the
confidence bar, one was refuted.

### Step 6 — did the comments land on the right lines?

Read back from the GitHub API and cross-checked against the file, rather than
taken on the tool's word.

```bash
gh api repos/MohitSAGAR11/prism-scratch/pulls/2/comments \
  --jq '.[] | "\(.path):\(.line)  side=\(.side)  \(.body | split("\n")[0])"'
```

```
src/orders.ts:14  side=RIGHT  **high / bug** - Off-by-one loop bound reads past end of array
src/orders.ts:30  side=RIGHT  **medium / performance** - loadAll fetches sequentially
src/orders.ts:8   side=RIGHT  **medium / edge-case** - fetchOrder ignores HTTP status

# what is actually on those lines:
  8    return (await res.json()) as Order;
 14    for (let i = 0; i <= orders.length; i += 1) {
 30      loaded.push(await fetchOrder(id));
```

**PASS** — all three exact. Line 8 was not a planted defect; see Part 3.

### Step 7 — shift every line number, review again

A function inserted at the top of the file, so the defective code is untouched
but every line number moves. This is the case the whole fingerprint design
exists for, and it only fails on the second or third push.

```bash
# insert formatOrder at the top of src/orders.ts, commit, push
npx tsx src/cli.ts 'MohitSAGAR11/prism-scratch#2' --post
```

```
# defects moved down by 5, content byte-identical:
 8 -> 13    return (await res.json()) as Order;
14 -> 19    for (let i = 0; i <= orders.length; i += 1) {
23 -> 28    return sum / orders.length;
30 -> 35      loaded.push(await fetchOrder(id));

5 candidate finding(s)
3 survived verification, 2 refuted
posted 2 inline comment(s)

<details>Already reported on an earlier push (1)</details>
```

**PARTIAL** — one of three recognised as already reported. The other two were
posted a second time. Analysed below.

---

## Part 3 — what it caught unprompted

Two results that were not on the test plan, and say more about quality than the
planted defects do.

### A fourth real bug, at line 8

`fetchOrder` parses the response body and casts it to `Order` without ever
checking `res.ok`. A 404 or 500 body becomes an `Order` with an undefined
`total`, quietly corrupting everything downstream. I had not planted this — I
wrote the helper as scaffolding for the other three defects.

Its stated failure scenario:

> `loadAll(['missing-id'])` resolves successfully with
> `[{id:'missing-id', total:undefined}]`; `highestTotal` then compares
> `undefined > -Infinity` and returns `-Infinity` instead of failing.

### The verify pass caught two findings contradicting each other

Pass 1 reported both an off-by-one at line 14 *and* "highestTotal returns
`-Infinity` for an empty array". Pass 2 killed the second on the grounds that
the first makes it unreachable:

> The loop condition `i <= orders.length` causes an out-of-bounds access: when
> orders is empty, `orders[0]` is undefined, so `orders[0].total` throws a
> TypeError before the function can return. The function never actually returns
> `-Infinity`; it crashes instead.

That is correct, and it is cross-finding reasoning — exactly what the
adversarial second pass is for.

---

## Part 4 — defects found in the tool

### 1. De-duplication only works when the model repeats its own wording

**Significant.** A finding's identity is
`sha256(file | line-content | category | title)`. Three of those four are
stable. **`title` is model-generated free text** — so the same defect, on the
same line content, in the same category, gets a different hash the moment the
model rephrases its headline, and the ledger no longer recognises it.

Every inline comment on the PR after two runs:

| Line | Fingerprint | Title as posted | Run |
|---|---|---|---|
| 19 | `9e5b161205acf30c` | Off-by-one loop bound reads past end of array | 1 + 2 |
| 13 | `624018a837e4145e` | fetchOrder ignores HTTP status and casts body blindly | 1 |
| 13 | `9cb1f36eca3a7129` | fetchOrder does not check res.ok before casting to Order | 2 |
| 35 | `7fcec91504b61e38` | loadAll fetches sequentially | 1 |
| 35 | `8e04c8f47178d274` | loadAll fetches sequentially instead of concurrently | 2 |

The off-by-one deduped only because the model happened to phrase its title
identically twice. Nothing structural made that happen.

The implementation matches its specification exactly — the weakness is in the
design, not the code. Which is a little ironic, since the stated point of the
fingerprint is to key on *the content of the cited line* rather than anything
volatile; the title is precisely what reintroduces the volatility.

**Suggested fix:** drop `title` from the hash. The cost is that two genuinely
different bugs on the same line in the same category would collapse into one — a
far rarer event than a reworded title, which happened on two of three findings
here.

### 2. The verify model inverted its own verdict

On the second run it marked the empty-list division as **refuted**, then wrote a
reason arguing the finding is right:

> The finding **is correct**: averageTotal([]) calls orders.reduce with an empty
> array, yielding sum=0, then divides by orders.length (0), producing NaN. There
> is no guard, early return, or validation … The claim accurately describes the
> code.

So a real defect was dropped on a verdict that contradicts its own
justification. `poolside/laguna-s-2.1:free` is confusing the polarity of the
boolean.

That same defect also scored 50% confidence on run 1 — below the 0.7 bar — and
85% on run 2. Between the shaky confidence and the inverted verdict, **a genuine
planted bug was never reported to the PR at all**.

**Cheapest next test:** point `verify_model` at `stealth/ox-alpha` for one run.
That separates a model problem from a prompt problem.

---

## Part 5 — proven, and not

| Capability | State | Evidence |
|---|---|---|
| Diff parsing and line anchoring | pass | 3 of 3 comments on the exact right line |
| Two-pass find then refute | pass | 5 candidates → 4 survivors → 1 refuted, sound reasoning |
| Posting inline + summary | pass | Review and summary comment both landed |
| One-click suggestion blocks | pass | Off-by-one shipped an applicable patch |
| Required failure scenarios | pass | Every comment named concrete inputs |
| Filtering before spend | pass | Lockfile-only PR → 0 groups, 0 tokens |
| Rate-limit tolerance | pass | A 429 mid-test became a "Review errors" section, not a crash |
| Prompt caching | pass | 1,184 cached tokens on the review call |
| Repo config loading | pass | 404 on a missing `.github/ai-review.yml` handled silently |
| Cross-push de-duplication | **1 of 3** | Two findings re-posted after rewording |
| Verify verdict reliability | **flaky** | One inverted verdict dropped a real bug |
| Action running in CI | untested | Needs the repo secret and a push to the remote |
| 422 inline-placement fallback | untested | Never triggered — no comment ever missed the diff |

---

## Reproducing this

```bash
npm run typecheck && npm test
npm run check:model
npm run check:plumbing -- 'MohitSAGAR11/prism-scratch#2'
npx tsx src/cli.ts 'MohitSAGAR11/prism-scratch#2'            # dry run
npx tsx src/cli.ts 'MohitSAGAR11/prism-scratch#2' --post

# then read the placement back from GitHub, don't trust the tool:
gh api repos/MohitSAGAR11/prism-scratch/pulls/2/comments \
  --jq '.[] | "\(.path):\(.line)  \(.body | split("\n")[0])"'
```

The repo and PR are still in place, so a fix to either defect above can be
verified against the same pull request. Note that a **third** push is the real
proof for the de-duplication fix — the ledger only misbehaves across pushes, so
one run proves nothing.
