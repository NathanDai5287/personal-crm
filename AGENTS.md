# personal-crm — agent orientation

**Read `docs/ENGINEERING-LOG.md` before changing anything.** It records decisions and,
more importantly, the places where this codebase did not behave as expected. Several
of those are non-obvious and cost real debugging time.

**Append to that log as you work.** Two triggers:
- You expected X, got Y → log it, with why the expectation was wrong.
- You made a decision that closes off an alternative → log it, with the evidence.

**`docs/ROADMAP.md` lists what is planned but NOT built.** When you ship something,
delete its entry — Nathan uses that file to answer "did we ever do that?", so a stale
item is worse than a missing one. New plans go in, shipped work moves to the log.

## Shape of the system

Signal messages → `data/crm.db` (append-only archive, **never deleted**) → chunked
ledgers → an LLM merge writes per-person markdown in `data/contacts/<slug>.md`.

**Three LLM call sites.** Everything else is deterministic.
- `scripts/crm-merge.js` → `prompts/merge.md` (read+edit tools)
- `scripts/crm-timeline.js` → `prompts/compact.md` (no tools, stdin; prompt file keeps its old name)
- `scripts/crm-tasks.js` → `prompts/tasks.md` (no tools, stdin, JSON out → `tasks` table)

## The four jobs (the mental model)

The system runs exactly **four periodic jobs**, defined once in **`lib/jobs.js`**
(the single source of truth — `run-toggles`, `run-models`, and the dashboard all
read from it). Each job runs on its own cycle. The two **paid** jobs (ingest, todo)
carry an enable switch (`lib/run-toggles`): an automatic run whose switch is off is
skipped; a hand-started run from the dashboard passes `--force` and always proceeds.
The two **free** sweeps carry NO switch — they always run, because pausing archiving
would risk losing disappearing messages for no cost saving.

| Job | Script | Model? | Switch? | What it does |
|---|---|---|---|---|
| **sweep** | `crm-archive.js` | no | no (always on) | copy new Signal messages into `crm.db` |
| **deep-sweep** | `crm-archive.js --deep` | no | no (always on) | re-walk ALL history (catch reused row ids) |
| **ingest** | `crm-daily.js` | yes | yes | read waiting messages into a profile: **merge** then **timeline** |
| **todo** | `crm-todo-scan.js` | yes | yes | scan for "make sure …" commitments (model only on a match) |

**`ingest` has two halves: MERGE (the prose profile) and TIMELINE (the
chronology).** They are not separate jobs. `crm-daily.js` runs the merge, then
invokes `crm-timeline.js` for the same contact(s). The Timeline step therefore has
**no schedule and no enable flag of its own** — it runs because ingest runs, and
the ingest switch (and ingest's model choice) govern it.

Do NOT reintroduce a standalone "compact"/"compaction" job. That name is gone: the
step is **Timeline**, the script is `crm-timeline.js`, and it lives inside ingest.
(The prompt file `prompts/compact.md`, the on-disk state `data/crm-compact-state.json`
and backup dir `data/_compact-backup/`, and the `evals/compact-*.js` harness keep
the old spelling on purpose — renaming them would orphan data or is out of scope.)

## Vocabulary (use these exact terms)

- **Sweep** — copy messages from Signal into the archive (`crm-archive.js`).
  Deterministic, NO AI. A **deep sweep** (`--deep`) ignores per-conversation cursors
  and re-checks all history (used to backfill the archive itself).
- **Archive** — `crm.db`; the append-only mirror of every swept message. Source of
  truth. Nothing downstream reads Signal directly.
- **Ingest** — the umbrella act of turning a contact's UNMERGED archived messages
  into profile updates. Not a mode and not one call. **Ingest ≡ backfill ≡
  play-forward**: the same code path, differing only in how much is pending and the
  effective date.
- **Run** — one execution of the **ingest** job (`crm-daily.js`): archive-first sweep
  → plan → whatever merges the gate releases → the Timeline half. (Ingest sweeps
  inline so it never reads a stale archive; the standalone `sweep`/`deep-sweep` jobs
  keep the archive fresh between ingests.) The **cron/timer** only fires jobs on a
  schedule; it makes no cadence decisions.
- **Gate** — the cadence policy in the planner (`gateBuckets`): release a merge once
  a contact's backlog crosses **N** messages after the **floor**, or the **ceiling**
  forces it. A pure function of (backlog, merge frontier, effective date). Floor/
  ceiling are measured in whole 04:00-Pacific **days** (`dayNumber`), never hours.
- **Effective date** — the "now" a gate evaluation runs against. A live run uses
  today; a backfill deterministically replays past effective dates. What you called
  a "sub-job with a different effective date" is a **bucket** (below).
- **Bucket** — the set of messages the gate releases in one fire (chronological). A
  bucket is split into one or more chunks.
- **Chunk** — the messages fed to ONE merge: whole Pacific weeks, ≤40k tokens
  (`planChunks`). **One chunk = one merge = one git commit.** Small bucket → one
  chunk; big bucket → several.
- **Merge** — ONE model call (`crm-merge.js`) that reads a profile + one chunk's
  ledger and rewrites What-I-know / Talking-points / Open-questions with citations.
  The atomic PAID unit; cost tracks the number of merges.
- **Backfill** — ingest of a contact whose merge frontier is empty or far behind
  (catching up a lot at once). A large pending set, not a special mode.
- **Play-forward** — ingest running incrementally, run after run, each handling what
  newly came due. The steady state.
- **Merge frontier** — the explicit `(contact, message)` set already merged (the
  `merged` table). The lossless, chronological replacement for the old rowid
  **cursor** — that term is RETIRED; don't reintroduce it.
- **Rebuild** — deliberately clear a contact's profile + merge frontier and ingest
  from scratch. The paid op to regenerate profiles (after a prompt change or a move).
- **Timeline** — ingest's second half (`crm-timeline.js`): the model step that
  condenses aged-out messages into one-line `## Timeline` entries. NOT a merge, and
  NOT a separate job — it runs inside ingest. (Was called "compaction".)

## BACKFILL == PLAY-IT-FORWARD (governing design principle)

**Ingest is a pure function of `(archive contents, per-contact cursor)` — never of
when, or how often, the cron runs.** One from-scratch pass over the whole history
must emit the *byte-identical* sequence of merges that running the job day-by-day
from the start would have. There is no separate "backfill mode": a backfill is the
same code with an old/absent cursor, and the cron is dumb — it only fires; every
cadence decision lives in the planner (`lib/weeks.js` `gateBuckets`,
`scripts/crm-refresh.js` `planContact`). This is what makes the pipeline
reproducible, lets a wiped profile rebuild exactly, and makes a backfill cost the
same as having run it live. If you reach for `Date.now()`, "is this the first run?",
or wall-clock cadence to decide *what* to merge — stop, that breaks it.

How it works, and what to preserve if you touch it:
- **The merge frontier is the `merged` table** (`crm.db`; `lib/archive.js`), an
  explicit set of (contact, message) pairs already merged — NOT a rowid cursor.
  That is what makes ingest lossless: a message linked-device sync inserts late with
  an OLD `sent_at` is just "not yet merged", so it's picked up next run. (An earlier
  single rowid-watermark design stranded such rows; don't reintroduce it.)
- **Process the backlog oldest-first (`sent_at`, then `id`)** so profiles build in
  chronological order — a bulk-imported old history merges first, not last.
- **The age clock is a pure function of the frontier**: `MAX(sent_at)` over the
  contact's merged rows. Never use the fire day or wall-clock time.
- **Fire-before-add** — release the pile *without* the row that trips the gate, so a
  bucket always ends on a whole day before its trigger, and a one-shot backfill and
  an early live run cut it at the identical row.
- **Full group context**: a contact's group messages pull EVERY speaker (minus the
  old bot), so their lines have context. A group message therefore merges once per
  tracked member of that group — which is why the frontier is per (contact, message).

If you change `gateBuckets` or the planner, re-prove it: replay a real `(id, sent_at)`
series as one chronological pass vs. a weekly loop (simulating the `merged` set) and
assert identical buckets, identical coverage, and chronological, non-decreasing
bucket dates. All day math goes through `lib/weeks.js` `dayNumber` (04:00-Pacific,
DST-safe, absolute), never raw UTC.

## Things that will surprise you

- **`node --check <file>` to validate syntax — never `require`.** Scripts here have
  side effects on import unless guarded; `require('./scripts/crm-daily.js')` once ran a
  full ingest with real model calls.
- **`data/contacts/_refresh/*.new.txt` is scratch, not evidence.** Regenerated every
  run, and the window moves: only 3 of 34 contacts have a cursor, the rest fall back to
  a 30-day lookback. Two agents once disagreed about whether a line existed and both
  were right — different generations of the same path. Quote from `.memory-history.git`.
- **`crm.db` is backed up by `scripts/crm-backup.js`** (step 0 of the daily run), to a
  sibling directory of the repo, not into `data/`. `--check` exits 1 if stale.

- **Profiles have version history**, in `.memory-history.git` — a separate local-only
  repo, not the main one. One commit per merged chunk. `data/` is git-ignored in the
  main repo because that repo has a GitHub remote; keep it that way.
- **`data/` holds secrets** (`signal-key.txt`, `web-password.txt`) and 20MB of private
  messages. Never commit it to the main repo.
- **The Timeline step is recoverable.** It rewrites a profile's `## Timeline` to
  lower resolution; it never touches the archive. Backups in `data/_compact-backup/`.
- **Eval fixture contamination is real and tagged.** `prompts/past/merge-v5.md` embeds
  examples built from `arshia-nayebnazar` and `charles-wu` messages, which are also
  fixtures. `evals/cases.js` marks those `heldOut: false`. Read the held-out subtotal.
- **Deterministic merge checks are saturated** (312/312 for two different prompts).
  Ranking prompts now requires `evals/judge.js`.
- **Deterministic Timeline-step checks reward brevity** and will pick the prompt
  that drops the most content. Use `evals/compact-judge.js` (eval harness keeps the
  old name).

## Cost

`anthropic/*` models run on Nathan's Claude subscription — **$0 marginal**.
`moonshotai/*` bills per token. Eval runners **refuse** a paid model without
`--allow-paid`. Do not send paid requests without explicit approval.
