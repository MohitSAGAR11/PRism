# Eval fixtures

`cases.json` is the scoreboard. Prompts and models are both trivial to change
and impossible to judge by eye — a tweak that fixes one PR routinely breaks two
others, and swapping a model is a one-line change whose effect on quality is
invisible without numbers. This directory is what makes those changes
measurable.

```bash
cp fixtures/cases.example.json fixtures/cases.json
# edit with real refs and real line numbers
npm run eval -- --models stealth/ox-alpha,poolside/laguna-s-2.1:free
```

`cases.json` is gitignored on purpose. Labels stay local until you decide to
share them.

## Format

```json
[
  {
    "ref": "owner/repo#123",
    "expected": [
      { "file": "src/a.ts", "line": 42, "category": "bug", "note": "why this label exists" }
    ]
  }
]
```

`category` and `note` are optional to the parser. Write them anyway — see below.

A case with `"expected": []` is not wasted. A PR that genuinely contains nothing
worth reporting is the hardest case to pass, because staying quiet is most of
what makes a reviewer tolerable. Include a few.

## How to label honestly

**1. Pick PRs whose outcome you already know.** Either one where a human
reviewer caught something real in the thread, or the parent commit of a bug-fix
PR — the bug is provably there, and the fix tells you exactly what it was.
Labelling from your own reading of unfamiliar code means you are scoring the
model against your guess.

**2. Read the line number off the plumbing check, never off the GitHub UI.**

```bash
npm run check:plumbing -- owner/repo#123 --show-prompt
```

The number in the rendered gutter is the head-revision line the model will
actually be told to cite. The GitHub web UI can disagree with it, and a label
that is off by four lines silently scores a correct finding as a miss. The
harness allows ±3 lines of tolerance; do not spend it on a bad label.

**3. Always write a `note`.** Not for the parser — for you, in three months,
looking at a row that regressed and trying to remember whether the label was
right in the first place. Say what the defect is and why you believe it.

**4. Label at least a dozen cases, across a few languages, before trusting a
number.** Below that, one lucky or unlucky match swings the percentage by double
digits and a model comparison is noise, not signal.

## Reading the results

`recall` is `matched / total expected` — did it find the known defects.
`precision` is `matched / (matched + unlabelled)`.

**"unlabelled" is not the same as "wrong."** It counts reported findings that no
label mentions, and some of them are real defects nobody has labelled yet. So
treat the precision column as a lower bound, and read the unlabelled findings by
hand for at least one model. Promoting the good ones into `cases.json` is how
this scoreboard gets more accurate over time instead of staying frozen at
day-one quality.

The one habit that matters: every prompt or model change gets merged only after
the numbers say it helped.
