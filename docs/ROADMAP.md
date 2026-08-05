# Roadmap

Things planned but **not built**. Delete an item the moment it ships — the point of
this file is that "did we ever do that?" has a trustworthy answer.

Shipped work is recorded in `docs/ENGINEERING-LOG.md` instead.

Ordered roughly by how much they matter, not by effort.

---

## Blocking a full backfill

(nothing — both blockers shipped 2026-08-04: compaction prompt v3, and sandbox
realism. The K3 numbers are still upper bounds until the awareness rate is
re-measured under the realistic sandbox; that re-measure is PAID and is listed under
Model / cost strategy below.)

## Tasks / todo list

- [ ] **One trigger yielding two tasks is collapsed to one.** `builders-two` (sign up for
  builders + share builders.cv) returns a single task from BOTH k2.6 and k3. Identical
  failure across two models means it is the prompt, not the model. This is the worst
  failure mode the table has — `taskKey` includes the title hash specifically so two tasks
  from one trigger cannot silently dedupe, and this defeats that at the source instead.
  Fix by sending Fable at `prompts/tasks-trigger.md` with both transcripts as evidence.
- [ ] **`evals/trigger-eval.js` fixtures still default to 4–9 messages of context**, below
  production's 25/8. `--before/--after` exist to override, but the defaults should match
  production or the scores describe a configuration the pipeline never runs. Raising them
  needs a check that a wider window does not pull a SECOND trigger into a fixture, which
  would change what `expectCount` means.
- [ ] **Snooze / hide** a task without marking it done.
- [ ] Decide what to do with the `reminders` table: `crm.db` has it, it has zero
  rows, nothing writes to it. Either wire it up or drop it.
- [ ] **`owner` column is vestigial** — always `'nathan'`. Drop it or keep it deliberately.

## Merge prompt v8 (from the first arena session, 2026-08-04)

- [ ] **Reader-is-you framing.** The prompt never says the profile's reader is Nathan.
  Write Nathan as "you", and stop accruing Nathan-self facts in other people's
  profiles — relationship state (offers, plans between the two) stays. This was
  Nathan's strongest arena note and no check can encode it.
- [ ] **Ban catch-all "recurring topics" bullets** — each topic earns its own bullet or
  is dropped.
- [ ] Rank v8 vs G in the arena on the 12-case set; the judge is a screen only — its
  F-lean inverted Nathan's blind votes 4 times in 12.

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

- [ ] **Cap-drift warning at read time** (spec §7): a later archive backfill can push a
  compliant range over 10 messages. `validateCitations` checks existence only — no
  thread or count logic — so nothing reports it. Near-zero risk once the backfill is a
  single clean pass, which is why it shipped without this.
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
- [ ] **Re-measure K3 `thinking=max` evaluation-awareness under the realistic
  sandbox.** PAID (`ke_max`, 9 cases). The sandbox is no longer a two-file `cwd`
  (shipped 2026-08-04), so the suspected tell is gone, but the awareness rate itself
  is unmeasured — nobody knows whether 1-of-18 dropped, held, or ROSE. Compare
  against `--bare-sandbox`, which reproduces the old tree, and audit the traces the
  same way as before. Until this runs, K3 numbers stay upper bounds; if the rate
  rises, the next suspects are AGENTS.md and `docs/ENGINEERING-LOG.md`, which the
  sandbox now carries and which describe the eval program.
