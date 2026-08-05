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

## 2026-08-04

### DECISION — the full-ledger tasks pass is DELETED, not retired
Nathan: *"lets just scan for 'make sure'. i will just say it in the future. it is not
important that every past task is picked up"* and then *"lets remove the LLM pass that will
scrape all messages."*

Deleted: `prompts/tasks.md` (27KB, four rounds of amendments), `tasks-v2.md`, `tasks-v3.md`,
`evals/tasks-run.js`, `evals/tasks-fixtures.js`, `evals/label-ui.js`. Recoverable from git
at 2303da2. Kept: `lib/task-trigger.js`, `prompts/tasks-trigger.md` (1,237 words),
`evals/tasks-contam.js` (decoupled from the deleted fixtures module), and
`data/_eval-tasks/` — the frozen ledgers are still the only corpus the contamination guard
can compare against, and Nathan's six hand labels document why the design changed.

WHY IT DIED, since the effort was substantial. The pass asked an LLM to judge which
commitments deserved tracking. That has no stable answer: every amendment was Nathan
correcting the model's *taste* — whose commitments count, is it routine, is it important
enough, was that a refusal. Taste was the wrong thing to automate. The eval built to
settle it landed at 80% adjusted precision / 67% recall on six tasks, which is respectable
and still not a list you would trust unreviewed.

The replacement inverts the split: **a regex decides WHETHER, the model decides WHAT.**

### SURPRISE — bare "make sure to X" means YOU make sure
The first trigger pattern accepted it. Against the real archive it fires 25 times in two
years and essentially none are tasks, because English drops the subject in imperatives:
"make sure to drink water", "make sure to take the 280", "make sure to wear a swimsuit in
case you get wet", "make sure to carry a firearm". A todo list of advice Nathan gave other
people is precisely the failure the simplification was meant to escape.

Requiring an explicit first-person subject: 25 -> 7. Restricting to future-commitment forms
(`i'll` / `i will` / `imma` / `i'm gonna` + make sure) — literally what he specified: 4 over
two years, 0.17/month. That also drops immediate self-checks ("lemme make sure walmart is
open") and past tense ("i need to make sure that i had it on the way in"), neither of which
is a commitment.

**Measure a trigger phrase against the real corpus before shipping it.** The phrase already
had a dominant meaning in his usage, and it was not the one we assumed.

### DECISION — silence is the failure mode, so it is made loud
A trigger design fails when Nathan thinks he flagged something and nothing happened. Two
guards: any line containing "make sure" that does not qualify is printed as a NEAR-MISS,
and a trigger the model returns nothing for is reported as DROPPED. The regex already
decided it is a task, so the model is not permitted to quietly disagree.

### OPEN — two costs Nathan has accepted, recorded so nobody re-litigates them
1. **Commitments others ask for are now invisible** unless he remembers the phrase at the
   moment of agreeing — and the moments he most needs a tracker are the ones where he agrees
   distractedly. He traded recall on forgotten commitments for precision. Forgotten
   commitments were arguably the product.
2. **No discharge detection.** The old prompt suppressed commitments the ledger showed
   fulfilled. Since tasks now only run forward, this is mostly moot — but a trigger followed
   by "sent it" three lines later still becomes a task.

---

## 2026-08-03 (night)

### DECISION — a prompt may never quote its own eval fixture, and this is now enforced
Three separate contaminations in one day, each caught only because someone went looking:
merge-v5's examples were built from two merge fixtures; `prompts/tasks.md` was given a
Charles exchange that was the **sole** strong candidate in the charles gold file; and the
audit of *that* fix found the Caden and Katia examples quoting seven and eight fixture
ids, including two of Nathan's six labelled tasks.

`evals/tasks-contam.js` compares every id a prompt cites against every frozen fixture and
exits non-zero on overlap; `evals/tasks-run.js` refuses to score unless it passes.
**Unticked overlap fails too** — a model recalling that a line is NOT a task inflates
precision exactly as surely as recalling that one is.

The rule: quoting CONTAMINATED contacts is fine, since they are excluded from gold;
quoting a gold fixture is not. Charles is both — contaminated below m90515, gold above —
and needs no special case, because the fixture holds only the upper range.

### DECISION — charles is gold via an id floor, not a time window
Nathan wanted the recent charles task as a datapoint, but charles was on the contaminated
list. Contamination turned out to have a **ceiling**: the ledger Fable read ended at
m90514 and the highest example id in any tasks prompt was m90393. `sinceId` floors a
fixture above that, so a contaminated contact is usable for anything the prompt author
never saw. A contaminated contact without a floor is still refused.

### SURPRISE — the candidate scan was stricter than the rule it exists to serve
Nathan asked why ⟨m90966⟩ "i'll find the guy … who slid into our dms on insta" was not a
strong candidate. Charles never asked; he complained — "its odd if they request we provide
it" — which a human reads as an implied need and a regex cannot. The **prompt** already
allowed "a clearly implied need", so the scan was the stricter of the two.

Measured across the five labelled fixtures: ask-only at 6 messages lookback put 12 of 161
candidates in the strong tier and caught 7 of Nathan's 8 ticks; ask+need at 15 puts 24
there and catches **8 of 8**. Doubling the skim to make the tier match his judgement is
the right trade.

**The scan decides nothing.** It picks what Nathan is shown; his ticks are ground truth;
the LLM pass is the extractor. Its only real failure mode is *not showing* a real
commitment, because then a correct extraction is scored a false positive.

### SURPRISE — `--retier` rewriting `ids=` corrupted the gold set
Re-tiering recomputes threads, and when a rule change merged two previously separate
entries, **both lines came out claiming the same ids** — two gold entries pointing at one
thread, double-counting on both sides of the score. Observed on charles, where "find the
DJ guy" (m90966) and "send the rush schedule" (m90973) are unrelated tasks minutes apart.

Thread membership is part of the frozen fixture. `--retier` now rewrites only `(tier)` and
`why=`; changing membership requires `--force`.

### DECISION — different asks are different threads
Time-and-tier clustering merged those two charles tasks. The signal that separates them is
that their **prompting messages differ**. Candidates with no ask attached may still merge
with each other, which is the run-on-musing case the span caps handle.

### DECISION — "reviewed" is separate from any tick
Nathan: *"i have not gone through ken chessmore yet, so those have been defaulted to no."*
"I read it and found nothing" and "I have not opened this" were both zero ticks, and the
difference decides whether a contact can be scored. ken-chessmore is the near-zero
**negative control** — the cleanest precision measurement available — and under the old
rule it could never have been used. Checklists carry `reviewed: yes|no`; the runner gates
on that, not on ticks.

### OPEN — the importance rubric disagrees with Nathan's own labels
The prompt anchors importance **2** with "building a small app a friend asked for"; Nathan
rated that same task **1**. Likewise the beta-link share is anchored at 1 while his
equivalent caden share is 2. Not a bug — but an importance mismatch in eval output may be
the PROMPT being miscalibrated rather than the model erring. Resolve by moving the anchors
to match his labels once there are more than six.

### OPEN — `prompts/tasks.md` has tripled, 9,557 -> 27,438 chars
Four amendments, each justified alone: Nathan-only owner, ask-gate + routine + importance,
the "make sure" opt-in + refusal rule, de-contamination. A 4,600-word prompt has its own
failure modes — later rules carrying less weight, examples crowding out the rules they
illustrate. v2/v3 remain ~1,600-word comparators, so the eval incidentally measures
whether the length buys anything.

---

## 2026-08-03 (evening, later)

### DECISION — tasks are ask-gated, non-routine, and carry an importance score
From Nathan after using the output: *"a lot of the todo items try to catch very
unserious or minor things, such as 'im getting of work at 6 and i'll come by 7'… it
should be things that the other person specifically asks and i confirm. it should not
be me saying things off the top of my head unprompted."*

`prompts/tasks.md` now requires FOUR parts, not three: a contact ask, Nathan's assent,
someone waiting, and **not routine coordination**. An unprompted announcement yields
nothing however concrete. The subtlety that needed spelling out: an offer Nathan makes
that the contact then accepts still counts — *the acceptance is the request*.

**Importance rescues a soft yes, never a no.** Nathan marked the Katia move-in ask as a
task even though his assent was "i'll check later… we'll see". So a hedge fails an
ordinary ask but passes an importance-3 one, at `probable`.

Contract is now SEVEN keys. `importance` 1-3, and it is wired end to end — it was
initially dropped on the floor by every layer below the prompt.
`ALTER TABLE` migration (CREATE TABLE IF NOT EXISTS is a no-op on an existing table),
`ORDER BY importance DESC`, badges on 3 and 1 only (2 is the common case and badging
everything is noise), editable in the UI because the model's guess at what matters is
exactly the judgement Nathan should overrule.

### SURPRISE — the eval unit was wrong, and Nathan's own labels proved it
He ticked m2998 and m3062 as separate commitments. They are one promise to build one
app. The Caden thread is four messages over two days and he marked one of them.

The gold set is now **threads, not messages**, and scoring matches an extraction to a
thread if it cites ANY member id — a prompt may reasonably pick a different turn as the
point of agreement. Per-message scoring would have counted his two-turn Caden thread as
two golds and reported 50% recall for a prompt that got it exactly right.

Applying his own rule mechanically: **158 candidates -> 10 with an ask -> 9 non-routine
-> 6 threads**, with all three of his real commitments surviving. The 96% cut is the
measurement that justified the prompt change, not a guess.

Weak candidates are kept and collapsed rather than deleted: gold-set recall is what
stops a correct extraction being scored a false positive.

### SURPRISE — thread clustering by time gap chains transitively
A conversation where each message is within the gap of the previous one collapses an
entire day into one "thread". Observed: nine candidates merged from "i'll become a
youtuber" onward into an unreviewable block. Gap alone is not enough — cap total span
and member count too.

### OPEN — the hardest routine-vs-real case, decided by inference
Katia's Outside Lands thread (m90304-m90350): a direct all-caps ask, plain assent
("im down", "aight lets go"), $300 tickets, future-dated. It passes every test yet
Nathan labelled every hang-out plan a non-task. Resolved by ruling that a social plan is
a task only where Nathan took on a concrete piece of making it happen — his labour is
what they are counting on, not his attendance. **This was inferred from his labels, not
stated by him.** Worth confirming.

---

## 2026-08-03 (evening)

### DECISION — `merge-v6` (F) promoted to `prompts/merge.md`
Was `merge-v5` (E). New sha `3ca8bfeaef7d`, 2,021 words.

Deterministic: F **294/294**, E 288/294 — F perfect on held-out *and* contaminated,
and 21% faster (296s vs 373s) despite being 300 words longer.

**That result is nearly circular and should not be read as "F is a better prompt."**
All six of E's failures are `wik_cited`, the check added because Nathan asked for
provenance on `## What I know` — and F is the variant whose purpose is to instruct
exactly that. It establishes that F does what F says, nothing more.

The non-circular half is the judge, and it is a **dead wash**: overall 2-2 with 4 ties;
dimensions E 6 / F 7 / **tie 27** of 40. Critically, **faithfulness ties on all eight
cases** — the worry was that citation pressure would spend the model's attention on
brackets at the cost of selection, and it did not. One unsupported claim flagged per
variant, so even there.

So F is promoted not because it wins but because it delivers the requested behaviour at
no measurable cost. `prompts/merge-v5.md` is retained as the comparator.

### SURPRISE — three flag-parsing footguns, one shape, one day
`arg()`-style parsing matches a flag exactly and falls through to a default otherwise,
so a near-miss is silently ignored and the run proceeds doing something *plausible*.

- `node evals/run.js --variants e,f` — the flag is `--variant`, singular. Ran the four
  default variants and reported a clean result for prompts nobody asked about.
- `node evals/judge.js latest` — defaults to pair `a,b`. A run containing only `e` and
  `f` skipped all eight cases and printed `E: 0  F: 0  tie: 0` with "No unsupported
  claims flagged", which is indistinguishable from a genuine tie.
- `crm-daily.js --dry-runn` performs a REAL run over all 34 contacts; `--onlly <slug>`
  widens a one-contact run to all of them.

All three now reject unknown flags before doing anything, and the judge exits 2 on zero
comparisons. **The eval tooling already refused paid models and unknown *variants* — the
gap was that nobody guarded the flag names themselves.** Worth checking for this shape
in any new script here.


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

---

## 2026-08-04 — model + context choice for the todo trigger

### SURPRISE — I predicted more context would not help, and was wrong
Asked whether k3's phantom deadline on the katia case could be fixed with more
context, I reasoned it could not: every decisive fact (Katia's ask, the
commitment, the hedge) sits within ±4 lines of the trigger, and the extra 34
prior messages are entirely off-topic — Tesla internships, a Florida weekend, a
broken phone. I said so before running it.

Then production-size context fixed it outright, for **both** models. k3's
invented `2026-08-14` became `null`; k2.6's title went from "Help Katia move in
on Aug 14-15" (the wrong task) to "Check availability to help Katia move in".

The lesson: **having the information available is not the same as having enough
surrounding material to calibrate against.** 25 messages of loose, hedgy planning
talk ("we should go to florida", "or maybe over the summer") appear to teach the
model that a casually-mentioned date in this conversation is not a commitment.
Sufficiency of information was the wrong frame; register was the operative one.

### SURPRISE — context is NOT monotonic
Same case, same golds, one sample per cell:

| context | k2.6 | k3 |
|---|---|---|
| 6/5 (fixture) | fields ok, title names the wrong task | deadline + importance MISS |
| **25/8 (production)** | **all ok** | **all ok** |
| 40/12 | fields ok, title names the wrong task | deadline + importance MISS |

Both models peak at exactly the production default and degrade on either side.
**Caveat recorded deliberately: this is 6 samples, no repeats.** The miss-hit-miss
pattern is as consistent with sampling noise as with a real optimum, and it was
reported that way rather than as a tuned finding.

### BUG — the eval had been measuring below production size
Fixture `before` values are 4–9; production is `BEFORE=25`. Because
`buildFixture` sliced only 6 messages, `findTriggers`' 25-cap never bound. So the
entire 8-fixture k2.6-vs-k3 comparison described a configuration the pipeline
never runs. Surfaced only because Nathan asked to vary context.

### BUG — the window was un-overridable, which made the question untestable
`extractFor` called `findTriggers(ledger)` with no options, hard-capping at 25/8
regardless of the ledger handed in. Widening a fixture past 25 was silently
trimmed. Had this not been caught first, the honest-looking answer would have
been "more context does not help" — from a test that never varied context. Nearly
a false negative produced by the measuring apparatus rather than the thing
measured.

### DECISION — k2.6, on failure severity rather than score
k2.6 and k3 tied 22/24 on the exactly-scored fields, trading one case each.
Chose k2.6 because its failure is milder: it inflated a blocked task from
importance 1 to 2, where k3 invented a deadline and promoted the task to 3. A
missing distinction is recoverable; a confident wrong date gets acted on.

**Cost was explicitly NOT the tiebreaker.** I had earlier framed k2.6 as "~6×
cheaper" as if that settled it; at ~0.2 triggers/month both models cost a
fraction of a cent per year, so the 6× is 6× of nothing. Retracted before it
influenced the decision.

### CORRECTION — k3 saw something in the fixture I had not
At 40/12 k3's description read *"then said 'nah' — confirm whether the ask still
stands."* Looking again at `m90034/m90035`, Katia writes "Or nag" then "Nah" —
she is offering Nathan an out. Genuine ambiguity in the source that I missed when
setting the gold values, found by the model, in the configuration I was arguing
against.

### OPEN — both models collapse two tasks into one
`builders-two` returns 1 task where Nathan said it should be 2, on k2.6 AND k3.
Identical failure across models means the prompt, not the model. This defeats the
reason `taskKey` hashes the title at all. Not fixed; on the roadmap.
