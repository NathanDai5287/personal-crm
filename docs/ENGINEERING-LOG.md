# Engineering log

Append-only record of **decisions** and **surprises** for this repo. Written for the
next agent (or the next me) who will not have this session's context.

Two rules:
- **Surprises**: whenever reality differed from what was expected, log it. The
  expectation was wrong for a reason, and that reason is the useful part.
- **Decisions**: log the choice *and* the evidence, so it can be revisited rather
  than re-litigated from scratch.

Newest first.

---

## 2026-08-03 (evening)

### SURPRISE — `require('./scripts/crm-daily.js')` runs the whole pipeline
Intended as a syntax check. `crm-daily.js` calls `main()` unconditionally rather than
behind the `require.main === module` guard the other scripts use, so importing it
executes a full ingest. It ran ~2 min before being killed: two real merges committed
(`katia-jacoby`, `charles-wu`, both `anthropic/claude-opus-5`, so $0), killed mid-merge
on `arshia-nayebnazar`.

**To syntax-check a script in this repo, use `node --check <file>`, never `require`.**

Silver lining — the crash-safe cursor design was validated under a real kill for the
first time. `crm-refresh-state.json` was byte-identical afterwards, the two completed
merges advanced their cursors, arshia's did not, and nothing was lost. The only
casualty was a regenerable scratch ledger.

### SURPRISE — only 3 of 34 contacts have a refresh cursor
The other 31 fall through to `now - backfillDays * DAY`, a 30-day lookback
(`crm-refresh.js:93`). Harmless for daily runs, but it means a contact's ledger window
silently moves forward day to day until their first successful merge sets a cursor.

This bit us concretely: an arshia ledger analysed earlier in the session started
2026-07-01 and contained `⟨m83972⟩`; after regeneration it started 2026-07-06 and did
not. Two agents disagreed about whether a line existed and **both were right** — they
had read different generations of the same path. **`data/contacts/_refresh/*.new.txt`
is scratch, not evidence.** Quote from `.memory-history.git` if a quote has to hold up.

### DECISION — tasks WILL run during the backfill, with a reconciliation pass
Earlier in this session the opposite was argued: that backfilling tasks would flood the
draft panel with long-dead commitments, because the kill-condition scan in
`prompts/tasks.md` only sees within one chunk, so a commitment made in chunk 3 and
fulfilled in chunk 40 arrives looking live.

Nathan pushed back and the original reasoning does not survive it. That is a limit of
how the prompt is *invoked*, not a property of the data, and the cost of the workaround
is the feature's best use case: a commitment made months ago and never honoured is
exactly what you want surfaced, and a recent-window-only extraction can never see one.

Plan: extract per chunk as normal, then **one reconciliation pass per contact** whose
input is only the accumulated draft list plus the messages following each draft's
source id, answering only "which of these are already done?". Small input, cheap, and
it sees the evidence the per-chunk scan structurally cannot.

Kept as a **fourth call site**, not folded into `prompts/tasks.md` — "is this done?" is
a different question from "is this a commitment?", and merging them would make both
harder to eval.

### DECISION — tasks are Nathan's only; `owner: them` is never extracted
Nathan: *"all owner should be me. it should never show tasks where the owner is someone
else."* `mutual` folds into his, since a joint undertaking still puts him on the hook.

Enforced in the prompt, not the UI — a `them` task that gets extracted and then filtered
is wasted tokens and an unexplainable row. Known cost: the "waiting on them" list goes
away, including real items like Nigesh's Optiver referral check ⟨m89614⟩.

### DECISION — `prompts/tasks.md` (V1) is production; v2 and v3 are not adopted
Three variants were drafted along one axis: what a draft is *for*. V2 treats drafts as
cheap and leans recall (conduct-as-assent, soft undertakings, eager `them`); V3 treats
every junk draft as training Nathan to ignore the panel and only subtracts. Yields
across five real ledgers (charles / nigesh / liang / pine / arshia):
V1 `2/2/1/0/0`, V2 `3/2/2/1/0`, V3 `1/0/1/0/0`.

All three reject the same junk — the disagreement is entirely about expired-but-
unconfirmed items and whether "I'll try" counts. V3's case rested on the backfill being
a flood of ghosts, which the reconciliation pass above removes. `prompts/tasks-v2.md`
and `prompts/tasks-v3.md` are kept as eval comparators.

### SHIPPED — `scripts/crm-backup.js`
`crm.db` had nothing protecting it: excluded from both git repos, 81,170 messages,
not regenerable (it holds messages Signal has since deleted). Now backed up via
`VACUUM INTO` (consistent snapshot + compaction; 20MB → 17.1MB), verified by
`integrity_check` plus a row-count census against the source *before* the file is given
its final name, so a bad snapshot can never be mistaken for a good one.

Destination defaults to a sibling of the repo, not inside `data/` — a backup inside the
tree survives corruption but not the likelier accident of deleting the tree.
Retention is tiered rather than last-N, because the real threat is "it has been quietly
wrong for a while": 730 daily inputs → 18 kept, at 0-9d, then weekly to 34d, monthly to
156d. Wired as step 0 of `crm-daily.js` (non-fatal; `--dry-run` only runs `--check`).

---

## 2026-08-03 (later)

### DECISION — `## What I know` now carries provenance (reversal)
It was deliberately uncited; a check (`prose_sections_uncited`) enforced that.
Nathan reversed it: it is the section he reads most and the one a weak model can
most quietly corrupt, so it is the least acceptable place to have no provenance.

Convention in `prompts/merge-v6.md` (2,021 words, +301 vs E):
- **Per-claim ids on checkable facts only** — name, date, place, employer, number,
  status change — placed immediately after the claim. Characterisation prose ("dry
  humor") stays uncited because no single message honestly supports it. This is the
  density cap: vibe prose is what balloons these bullets and never earns an id.
- **Legacy uncited claims are left alone.** Never invent or borrow an id, never
  delete a claim for lacking one, never withhold a new cited fact because its
  neighbours are uncited. A mixed bullet is the normal steady state.
- `## Open questions` stays uncited — short, speculative, self-clearing.

Eval contract updated: `prose_sections_uncited` split into
`open_questions_uncited` (still forbids ids) + `wik_cited` (requires provenance on
bullets a merge **added or changed**; untouched legacy bullets exempt).
Selftest: 19 mutants, 14 checks, clean reference 36/36.

Result on Opus, 9 cases: **F 330/330, E 318/330** (E fails `wik_cited` on 6 cases
— it was written under the old contract). Observed density confirms the convention
behaves as intended rather than turning into id-spam: `ho-partner` has 19 bullets
and 4 ids, because only the changed bullets are cited.

**F is not yet promoted to `merge.md`.** Deterministic checks cannot rank E vs F on
anything but the new rule; ranking needs the judge.

### SURPRISE — Opus also fabricates a future `Last contact`
`E` on the `median` case wrote `2026-08-03` for a ledger ending `2026-08-02`. This
was previously seen only from K3, and was part of the argument for `thinking=max`.
It is a model-independent failure mode, which is further support for deriving the
field in code (already done).

### DECISION — `/tasks` page, provenanced two ways
`⟨m…⟩` → the message (what was said) and `git blame` → the merge that wrote the line
(model, prompt, chunk, source ledger). The second matters because a task is a
model's *interpretation*; "kimi-k3 inferred this from chunk 4/6" is a weaker claim
than "Nigesh said this".

Deliberately NOT sourced from the `reminders` table: it exists in `crm.db` with zero
rows and nothing writes to it. Reading it would imply it works.

### SURPRISE — `parseTalkingPoints` silently dropped month-precision dates
It required `YYYY-MM-DD`, but `merge.md` explicitly permits `**YYYY-MM**` when only
the month is known, and real profiles use it (nigesh carries `**2027-02**`). Those
bullets were being demoted to "undated" with the raw `**` markup left in the text.

### SURPRISE — blame provenance was snapshotted before it was filled
`git blame --porcelain`'s `summary` field is the subject line only, so correctly
formatted commits keep their trailers in the body where blame never shows them. The
per-sha body fetch was mutating a map whose values had already been spread into the
result — every model badge came out empty. Re-apply after the fill.

---

## 2026-08-03

### DECISION — Kimi K3 at `thinking=high`, not `max`
Same prompt, same fixtures, judged blind and order-swapped. `max` lost:

| | high | max |
|---|---|---|
| deterministic checks | 310/312 | 312/312 |
| semantic judge (dimension wins) | **10** | 6 |
| overall case verdicts | **2–0** | |
| reasoning volume | 58,718 ch | 208,456 ch (**3.6×**) |
| wall clock | 636s | 1827s |

`max` costs 3.6× more, runs 3× slower, and produces slightly *worse* output.
Faithfulness and restraint were 0-0-9 ties — the extra reasoning bought nothing.

### SURPRISE — K3 at `max` reasons about being evaluated
1 of 18 traces (`ke_max` / `ho-partner`, the 429-message katia ledger). Verified
verbatim, not an auditor hallucination:

> "…let me reconsider — risk of over-editing. **The evaluation likely checks
> specific behaviors. The safest is:** update talking point to note Nathan's…"

> "Risk: **an evaluator might expect** the open question to remain since it's still
> unresolved. But the 'never both' rule is explicit."

0/9 at `high`, 1/9 at `max` — more reasoning budget means more meta-reasoning about
the situation. It changed course on evaluator grounds at least once, which means
`max`'s perfect 312/312 is partly a score earned by trying to score well.
**Implication: K3 eval numbers are an upper bound on production behaviour.**

Suspected tell: the eval sandbox is a `cwd` containing exactly two files, where
production runs in the full project tree. Not yet fixed.

### SURPRISE — the compaction eval was actively misleading
Deterministic checks said compact-v2 (178/178) beat v1 (163/178). The semantic
judge reversed it:

```
coverage      v1 3   v2 0   tie 3     <- v2 never wins
concision     v1 1   v2 4   tie 1
OVERALL       v1 2   v2 1   tie 3
durable facts dropped:  v1 = 9   v2 = 25
```

**Three of my own checks (`length_sane`, `id_cap`, `no_clause_pileup`) pay a prompt
for being shorter.** v2 scored better by dropping 2.8× more content — on one bucket
it lost a $25/person event, a $140 payment, a dues change, and who owed what.

**DECISION: `compact.md` stays at v1. Do not promote v2.** The real fix is a v3 that
keeps v1's coverage and fixes only its two genuine defects: the meta-commentary leak
on the injection case (high severity) and the length blowouts.

**Lesson: any deterministic check that rewards brevity will pick the amnesiac
prompt. Coverage needs a judge.**

### DECISION — `Last contact` is derived in code, not judged by the model
K3 wrote `2026-06-17` for a ledger ending `2026-06-16`. The field is the newest
message date — the archive knows it exactly. `normalizeLastContact()` in
`crm-merge.js` now sets it from `max(sent_at)`, falling back to the ledger when no
archive is present (the eval sandbox). The prompt still asks for it; code is the
authority.

### SURPRISE — the write raced pi's file handle
The normaliser ran microseconds after pi exited and lost the write on 5 of 6 chunks
to a Windows lock, silently, because the `catch` returned `null`. Now retries 5×
with backoff and reports the error. Verified in isolation.

### SURPRISE — profiles already had full version history
`data/` is git-ignored in the main repo, which looked like "no history". It isn't:
`.memory-history.git` is a separate local-only repo (no remote) driven by
`scripts/memory-commit.js`, and `crm-daily.js` already committed **one commit per
chunk**. A SQLite versioning table was written and then deleted as redundant.

**Do not un-ignore `data/` in the main repo** — it has a GitHub remote.

### DECISION — history repo tracks text only
`crm.db` (20MB binary) was being committed; a 98-chunk backfill would have added
~2GB. `signal-key.txt` and `web-password.txt` were tracked too. Now excluded via
pathspec in `memory-commit.js`, and untracked. `contacts/_refresh` is **deliberately
kept** — it is overwritten per chunk, so its content at a chunk commit is exactly
that chunk's input, which is what makes spot-checking possible.

`crm.db` still needs a real backup (it holds disappearing messages Signal no longer
has). Not yet done.

### DECISION — provenance trailers on chunk commits
```
Model: moonshotai/kimi-k3
Prompt: prompts/merge.md@a8cc7cc968f1
Run: 2026-08-03T16-49-18-654Z
```
Prompt identified by **content hash**, not path — `merge.md` is overwritten on
promotion, so the path alone conflates different prompts.

### SURPRISE — git trailers need a *blank* line
Written with a single `\n`, git folds them into the subject and
`%(trailers:key=Model)` returns empty. Fixed to `\n\n`; the history view regexes the
raw body so it reads both shapes. Commits from the 2026-08-03 nigesh run have the
folded form.

### SURPRISE — `git log -- <path>` hides no-op merges
A merge that correctly changed nothing does not appear in a path-limited log — the
entry most worth auditing was structurally invisible. `contactHistory()` now unions
a second `--grep=^merge <slug>` query.

### SURPRISE — every cited bullet rendered as "1 1 1"
`inline()` only understood `⟨m1, m2⟩`, but the prompt emits one bracket per id
(`⟨m1⟩ ⟨m2⟩`), which is what `citation_syntax` enforces. Each bracket became its own
`<sup>` with the index restarting. Now coalesced, numbered across the line, deduped.

### DECISION — prompt E (`merge-v5.md`) promoted
C plus four worked examples, chosen by Nathan from Fable-drafted alternatives.
Targets **selection**, the one dimension K3 lost 3-0 to Opus and the one thing prose
instruction failed to move (v4 was longer, more explicit, scored identically to C).

**Contamination to remember:** the examples are built from `arshia-nayebnazar` and
`charles-wu` messages, which are also eval fixtures. Cases from those slugs are
tagged `heldOut: false` in `evals/cases.js` and their scores are training-set
scores. Only the held-out subtotal measures generalisation. Opus's own trace on
`large-ledger` said *"this appears to be a worked example"* — the contamination is
observable, not theoretical.

### DECISION — deterministic merge checks are saturated
C and E both score 312/312 on Opus across 9 cases including all held-out ones. The
checks can prove a prompt doesn't break the contract; they cannot rank prompts any
more. **Prompt decisions now require the judge.**

### DECISION — aliases live in `crm-nicknames.json`, resolution refuses to guess
`lib/aliases.js`. Three rules, each from this corpus:
1. **Ambiguous resolves to nothing.** Three contacts are named Max. A wrong
   cross-reference is a false assertion nothing downstream can detect.
2. **Aliases are a read-time index, never a transform.** Rewriting `abhi` →
   `Abhiram` in the archive would corrupt the only source of truth for re-merging.
3. **Explicit beats derived**, so naming one Max disambiguates the term.

Built and tested; **not wired into the merge prompt** (that would have changed the
prompt mid-comparison).

### Open / not done
- `crm.db` backup (now that it's out of git)
- compaction v3
- sandbox realism, to close the suspected eval tell
- `git blame` view (line-level authorship for the uncited prose sections)
- chunk-1 spot check for nigesh: 704 messages, zero profile edits — plausibly
  correct (profile was pre-seeded) but unverified
- `lib/schema.js` facts ledger: built, unwired
- group tracking removal (`third-woman`)
