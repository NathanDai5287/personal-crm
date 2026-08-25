# Roadmap

Things planned but **not built**. Delete an item the moment it ships — the point of
this file is that "did we ever do that?" has a trustworthy answer.

Shipped work is recorded in `docs/ENGINEERING-LOG.md` instead.

Ordered roughly by how much they matter, not by effort.

---

## Blocking a full backfill

- [ ] **Merge prompt v8** — same logic that blocked for ranges: the backfill rewrites
  every profile, and v8 changes every profile's *voice*, so shipping it after means
  running 98 chunks twice. From the first arena session (2026-08-04):
  - **Reader-is-you framing.** The prompt never says the profile's reader is Nathan.
    Write Nathan as "you", and stop accruing Nathan-self facts in other people's
    profiles — relationship state (offers, plans between the two) stays.
  - **Ban catch-all "recurring topics" bullets** — each topic earns its own bullet or
    is dropped.
  - Validate v8 vs G: deterministic checks as the floor, judge as a screen only (its
    F-lean inverted Nathan's blind votes 4 of 12), one arena session as the ranking
    signal — insights over tallies.
- [ ] **`nathan.md` self-pass — decide only the schema now.** The pass itself runs
  post-backfill (the archive rebuilds it anytime), but if the self-profile wants
  sections the contact template lacks, deciding that before the backfill is free and
  after it is not. Design agreed 2026-08-04: monthly wide-context pass, single
  writer, contact merges never touch it; skeleton from Timeline tiers, evidence
  from a raw pull of Nathan's own outgoing messages; big-picture only (goals,
  beliefs, preferences, career direction, cross-cutting relationship patterns).

(Timeline v3, sandbox realism, and provenance ranges all shipped 2026-08-04. The
K3 numbers are still upper bounds until the awareness rate is re-measured under the
realistic sandbox; that re-measure is PAID and is listed under Model / cost strategy
below.)

## Admin dashboard (planned 2026-08-05, functionality agreed)

Two overarching places: `/` = the CRM you read (Contacts, Tasks), `/admin` = what the
machine did. Existing deep links (`/c/<slug>/history`, `/c/<slug>/ledger/<sha>`, `/m/…`)
keep working; `/status`, `/runs`, `/actions` move under `/admin/*` with redirects.

- [ ] **A run log every runner writes to** — `lib/runlog.js`, monthly JSONL under
  `logs/runs/<YYYY-MM>.jsonl`. Today only `crm-daily` records anything (2 files), so the
  hourly sweep, Timeline and the todo scan are invisible; "a log of historical runs"
  cannot be built by reading harder. Fields: `id, kind, args, trigger, parentId,
  startedAt, endedAt, exitCode, ok, summary, logPath, recordPath`; `kind` ∈ archive |
  daily | merge-one | timeline | todo-scan | backup; `trigger` ∈ schedule | ui | cli.
  Written at BEGIN and again at END, so a killed run leaves a row with no `endedAt` —
  itself the signal. `parentId` because a daily run spawns a Timeline pass and a sweep.
  Quiet hourly sweeps still get a row (hidden behind a toggle): a MISSING row is how you
  learn Task Scheduler stopped firing, which nothing catches today.
- [ ] **Overview page** — health strip (last sweep + stale flag past 90 min, last daily
  run, last Timeline pass, last todo scan, backup age, archive rows + span, Signal running)
  over the per-contact table, with the triggers ON the row: `Archive` · `Preview`
  (free — `--only X --dry-run`) · `Merge`. Global row: full / dry / timeline / archive
  sweep (deep checkbox).
- [ ] **Stranded-message check on that page.** For each contact: Signal messages at or
  below the cursor that are absent from the archive. It found 669 on 2026-08-05 and
  nothing was reporting it. Distinguishes "the sweep ran" from "the sweep kept up".
- [ ] **`/status` counts pending from Signal, but the pipeline plans from the ARCHIVE** —
  so the number misses archived-but-expired messages and the page dies when Signal is
  closed. Switch to `buildArchiveQuery`, and import `MERGE_BACKFILL_DAYS` instead of
  re-declaring `BACKFILL_DAYS = 30` in `crm-web.js` (that mirror will start lying).
- [ ] **Job runner**: whitelisted kinds (never raw args), output streamed to
  `logs/jobs/<runId>.log` so it survives a server restart and the run row can link it,
  the existing single-job lock, `Sec-Fetch-Site` CSRF guard on the new POSTs.
- [ ] **A pipeline lock file** shared by daily + archive, so a manually triggered sweep
  and the hourly scheduled one cannot both write `crm.db`. The scheduled loser exits 0
  and logs "skipped, run in progress". (`PRAGMA busy_timeout` shipped 2026-08-05 and
  makes the collision survivable; the lock makes it orderly.)
- [ ] **Runs history pages** — all kinds, filterable; reuse the existing rich per-chunk
  detail view for `daily`, show captured output + summary for the rest.
- DECIDED: **destructive buttons stay CLI-only** for now — no clear-cursors, no
  clear-data in the UI (Nathan, 2026-08-05).

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

## Manual overrides (designed, not built)

- [ ] **`<!--pinned-->`** — a line the merge may never touch. For invariants:
  birthday, hometown, how you met.
- [ ] **`<!--mine-->`** — Nathan's judgement. The merge may not reword or delete it,
  but may append an indented dated `⚠︎` note when the ledger contradicts it.
- [ ] **Enforce mechanically, not by prompt.** Extract pinned lines before the merge,
  restore them after, log violations. A prompt rule alone is a request.
- [ ] Checks `pinned_untouched` and `mine_preserved` (both high severity) + mutants.
- [ ] **Edit profiles from the dashboard** (textarea + POST). Reject writes to
  `## Timeline` — the Timeline step owns it.

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
  `data/groups/`, `buildGroupTimeline`, `GROUPS_DIR`.
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
