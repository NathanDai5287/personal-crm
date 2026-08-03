# Roadmap

Things planned but **not built**. Delete an item the moment it ships — the point of
this file is that "did we ever do that?" has a trustworthy answer.

Shipped work is recorded in `docs/ENGINEERING-LOG.md` instead.

Ordered roughly by how much they matter, not by effort.

---

## Blocking a full backfill

- [ ] **Compaction prompt v3.** Keep v1's coverage, fix only its two real defects:
  the meta-commentary leak on the injection case (high severity) and the length
  blowouts. Do NOT adopt v2 — the judge showed it drops 2.8× more durable content.
- [ ] **New merge checks, or the arena.** F now scores 100% on every held-out case, so
  the deterministic suite is saturated again. `wik_cited` bought exactly one prompt
  generation of headroom, and the lesson generalises: a check written to enforce a new
  rule will always be won by the prompt that adds that rule. Ranking the next merge
  prompt needs human preference labels, not another check.
- [ ] **Sandbox realism.** The eval sandbox is a `cwd` with two files; production is
  the full project tree. Suspected tell behind K3's evaluation-awareness at
  `thinking=max`. Until closed, every K3 eval number is an upper bound.

## Tasks / todo list

- [ ] **Reconciliation pass — the fourth LLM call site.** `prompts/tasks.md` only scans
  for kill conditions (fulfilled / cancelled / superseded) *within one chunk*, so a
  commitment made in chunk 3 and fulfilled in chunk 40 arrives looking live. Needed
  before tasks run over the backfill. Input is small and cheap: the accumulated draft
  list plus the messages after each draft's `source_msg_id`, answering only "which of
  these are already done?". Deliberately NOT folded into `tasks.md` — different
  question, and merging them makes both harder to eval.
- [ ] **Wire `crm-tasks.js` into `crm-daily.js`** as a step, after merge.
- [ ] **Tasks eval.** None exists. Easier than the merge eval because the output is JSON
  with a message id, so precision/recall against a hand-labelled gold set is exact — no
  judge needed for the primary metric, and no saturation problem. Layers: (1) precision,
  recall, precision split by `confidence` (if `explicit` and `probable` score the same,
  the field is decorative and should be cut), deadline accuracy; (2) a judged pass on
  title quality for true positives only. **`arshia-nayebnazar` and `charles-wu` are
  contaminated** — both were read while drafting the variants. Gold set must come from
  elsewhere. Labelling shortcut: mechanically extract every commitment-*shaped* line,
  hand Nathan a yes/no checklist (~60 decisions across 5 contacts).
- [ ] **`owner` column is now vestigial** — always `'nathan'` after the Nathan-only
  decision. Drop it, or keep it for a future waiting-on feature. Decide, don't drift.
- [ ] **Actionable-vs-context split.** `merge.md` currently lumps "things to do"
  and "things they mentioned that matter to them" into one `## Talking points`
  section, so the todo list still shows non-actions ("Patricia finally moved out").
  Fix is in the prompt: emit an explicit action or mark context separately.
- [ ] **Edit tasks in the UI** — add, reword, delete by hand. Only done/undone works
  today.
- [ ] **Snooze / hide** a task without marking it done.
- [ ] Decide what to do with the `reminders` table: `crm.db` has it, it has zero
  rows, nothing writes to it. Either wire it up or drop it.

## Manual overrides (designed, not built)

- [ ] **`<!--pinned-->`** — a line the merge may never touch. For invariants:
  birthday, hometown, how you met.
- [ ] **`<!--mine-->`** — Nathan's judgement. The merge may not reword or delete it,
  but may append an indented dated `⚠︎` note when the ledger contradicts it.
- [ ] **Enforce mechanically, not by prompt.** Extract pinned lines before the merge,
  restore them after, log violations. A prompt rule alone is a request.
- [ ] Checks `pinned_untouched` and `mine_preserved` (both high severity) + mutants.
- [ ] **Edit profiles from the dashboard** (textarea + POST). Reject writes to
  `## Timeline` — compaction owns it.

## Provenance / history

- [ ] **`git blame` view** — line-level authorship for the profile, tinted by model.
  Would make K3-vs-Opus prose erosion visible instead of theoretical.
- [ ] Backfill provenance trailers are only on commits from 2026-08-03 onward, and
  that run's are the folded (blank-line-less) variant. Cosmetic.

## Data model

- [ ] **Wire up `lib/schema.js`.** Built and unwired. Facts as store of record with
  typed identity (standing / periodic / snapshot) and supersession; markdown becomes
  a render. This is the real fix for corrections being durable, and for `What I know`
  growing without bound.
- [ ] **Wire aliases into the merge.** `lib/aliases.js` works (`abhi` →
  `abhiram-chalamalasetty`, `max` → ambiguous → refuses). Not passed to the prompt
  yet — doing so mid-comparison would have changed the prompt.
- [ ] **`What I know` never shrinks.** Contradictions get replaced but nothing is
  dropped for age. The only unbounded-growth section.
- [ ] **Timeline's purpose.** Its only real consumer is the merge (history context
  beyond the current chunk); Nathan does not read it. If the facts ledger lands, it
  likely stops earning its keep — revisit deleting it then, not before.

## Cleanup

- [ ] **Remove group tracking**: `third-woman` from `crm-tracked-groups.json`,
  `data/groups/`, `compactGroup`, `GROUPS_DIR`.
- [ ] **Voice-note transcription** — 44 notes currently ignored.
- [ ] Vestigial DB cleanup, subsumed by the facts table if that lands.
- [ ] Spot-check nigesh chunk 1: 704 messages, zero profile edits. Plausibly correct
  (profile was pre-seeded) but never verified.

## Model / cost strategy

- [ ] **Run the full backfill on Opus while it is free.** 98 chunks, ~80,777
  messages, $0 today vs ~$21 on K3 later. The single biggest cost lever and it
  expires when the subscription does.
- [ ] Then switch weekly incrementals to K3 at `thinking=high` (settled: `max` costs
  3.6× more, is slower, and scores *worse*).
- [ ] **Four-model free sweep** (Fable / Opus / Sonnet / Haiku) to pick the
  cheapest-adequate ongoing model before Claude access ends. Free, never run.
- [ ] **Non-Opus judge cross-check** to size self-preference bias in the original
  Opus-vs-K3 result (11–3 with 16 ties). Free via a Fable agent.
