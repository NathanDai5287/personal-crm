# Scripts reference

Every runnable script in `scripts/`, what it does, and whether it spends model
tokens. Run all of them from the repo root as `node scripts/<name>.js`.

## How the pipeline fits together

```
Signal Desktop DB
      │  crm-archive.js  (SWEEP — no model)
      ▼
  data/crm.db  ── the append-only archive of record (never deleted; the one
      │            irreplaceable file — it keeps messages Signal has purged)
      │
      ├─ crm-refresh.js → crm-merge.js   (INGEST — model)
      │      reads new messages, writes the PROSE KNOWLEDGE of a profile:
      │      ## What I know · ## Talking points · ## Open questions · metadata
      │      (never touches ## Timeline)
      │
      └─ crm-compact.js                  (TIMELINE — model)
             builds & maintains the CHRONOLOGY of a profile:
             ## Timeline (Recent raw → Daily → Weekly → Older) + Group activity
```

**Ingest and compact write different halves of the profile and are independent
passes.** A full `crm-daily.js` run ingests every contact, then compacts every
contact; the two are not interleaved per week, and interleaving would produce
identical output (no cross-dependency).

## Every job that can be run

Each of these is a dial on the dashboard's Pipeline tab with its own **▸ run**
button (scoped to the checked roster, or everyone).

| Job | Runs | Cadence | Model | In run log |
|---|---|---|---|---|
| **Sweep** | `crm-archive.js [--only <slug>]` | top of every hour | no | yes (no-op ticks hidden) |
| **Deep sweep** | `crm-archive.js --deep` | daily 03:00 | no | yes |
| **Ingest** | `crm-daily.js --only <slug>` (merge **+** that contact's Timeline) | manual (weekly when the AI task is on) | yes | yes (ingest + timeline rows) |
| **Todo** | `crm-todo-scan.js` | top of every hour (after the sweep) | only when a "make sure" line matches (≈0.2×/mo) | yes (no-op ticks hidden) |
| _(full run)_ | `crm-daily.js` | Monday 04:00 (task currently unregistered) | yes | yes |

Ingest (`crm-daily --only`) now runs merge **and** that contact's Timeline
(`crm-compact --slug`); it skips only autopromote (an all-contact pass). The full
run does every contact's ingest + timeline. The standalone Timeline pass still
exists as `crm-compact.js` (below) for CLI use, but is no longer a separate
dashboard button.

Model cost: `MERGE_MODEL` / `COMPACT_MODEL` / the todo model default to
`moonshotai/kimi-k3` — **paid per token** (needs `MOONSHOT_API_KEY`). Override any
of them with `anthropic/claude-opus-5` (or another `anthropic/*`) for a $0
subscription run. The todo scan is regex-gated, so it calls the model only on a
"make sure" match (≈0.2×/month).

---

## Pipeline scripts

### `crm-archive.js` — sweep (no model)
Copies new messages from the Signal Desktop DB into `data/crm.db`, including
disappearing messages before they vanish. Append-only; safe to run constantly.
```
node scripts/crm-archive.js                 # incremental sweep of everyone
node scripts/crm-archive.js --deep          # ignore cursors, re-walk all history
node scripts/crm-archive.js --only <slug>   # one contact (or group:<slug>)
```

### `crm-daily.js` — the ingest orchestrator (model)
The full pipeline: snapshot → autopromote → refresh → per-contact merge with a
crash-safe cursor commit → compact → snapshot → logs. This is the only writer of
the ingest cursors (`crm-refresh-state.json`).
```
node scripts/crm-daily.js               # full run: ingest ALL, then timeline ALL
node scripts/crm-daily.js --only <slug> # one contact: merge + Timeline; skips autopromote
node scripts/crm-daily.js --dry-run     # plan only; never calls the model or writes
```

### `crm-refresh.js` — gated chunk planner / ledger writer (no model)
Turns "messages past a contact's cursor" into **gated merge buckets** and writes one
chunk's ledger at a time. The gate (`lib/weeks.js` `gateBuckets`) releases a merge
only once a contact's backlog crosses `INGEST_N` messages after `INGEST_FLOOR_DAYS`,
or `INGEST_CEILING_DAYS` forces it — so quiet contacts are not merged every active
week; each released bucket is then week/token-batched by `planChunks`. A library
first (`crm-daily` drives it in-process); running it directly just prints the plan.
**Ingest == backfill** (see `AGENTS.md`): the gate is a pure function of
`(archive, cursor)`, so a from-scratch backfill emits the byte-identical bucket
sequence as playing forward day by day. A contact with no cursor starts from message
0 (their whole history). (The eval harness can still pass an explicit `backfillDays`
window; `CRM_BACKFILL_DAYS` forces one.)
```
node scripts/crm-refresh.js                 # print the chunk plan for everyone
node scripts/crm-refresh.js --only <slug>   # ...for one contact
node scripts/crm-refresh.js --write-first   # also write each contact's first ledger
```

### `crm-merge.js` — merge one contact (model)
Folds one contact's ledger into their profile's prose sections via a headless
`pi` agent using `prompts/merge.md`. Writes `## What I know` / `## Talking
points` / `## Open questions` / metadata only — **never `## Timeline`**.
```
node scripts/crm-merge.js <slug>            # invoke the model
node scripts/crm-merge.js <slug> --dry-run  # print the argv it would run
```

### `crm-compact.js` — build & maintain the Timeline (model) — runs inside Ingest
Builds each conversation's `## Timeline` and keeps it at decreasing resolution
(Recent raw / Daily / Weekly / Older). One model call per aged-out day or week.
Also folds group day-summaries into participant profiles. **Real by default;
`--dry-run` previews. Backs up each file first.** (STANDARD CONTRACT — same
shape as ingest/todo; see the engineering log.)
```
node scripts/crm-compact.js                 # apply (default), all tracked contacts + groups
node scripts/crm-compact.js --dry-run       # preview only, no writes, no model
node scripts/crm-compact.js --slug <slug>   # one contact
node scripts/crm-compact.js --group <slug>  # one group
node scripts/crm-compact.js --no-llm        # structural only, skip summaries
```

---

## Admin & support scripts

### `crm-web.js` — the dashboard (no model itself)
Serves the web UI on `127.0.0.1:8787` behind HTTP basic auth and spawns the job
kinds above as child processes. Reads its password once at startup.
```
node scripts/crm-web.js
```

### `crm-wipe.js` — reset contacts / clear the runs ledger (no model)
The CLI-only destructive reset. Blanks a contact's profile to a stub, drops its
ingest cursor + compact state, and deletes its pending ledger; `crm.db` is never
touched, so a wiped contact rebuilds by re-ingesting. **Dry-run unless
`--write`, which first snapshots `data/` into the history repo.**
```
node scripts/crm-wipe.js <slug...>                  # preview
node scripts/crm-wipe.js <slug...> --write          # wipe those contacts
node scripts/crm-wipe.js --all --write              # every tracked contact
node scripts/crm-wipe.js <slug> --write --backfill  # wipe + arm a FULL re-ingest (cursor 0)
node scripts/crm-wipe.js --runs --write             # clear the whole runs ledger
```

### `crm-autopromote.js` — auto-track active contacts (no model)
Scans 1:1 Signal conversations; anyone untracked with enough recent back-and-forth
gets a stub profile, a `crm.db` row, and a slug in `crm-tracked.json`. Runs inside
the full daily pipeline. **Dry-run unless `--write`.**
```
node scripts/crm-autopromote.js             # list who would be promoted
node scripts/crm-autopromote.js --write      # actually promote
```

### `crm-todo-scan.js` — cheap commitment capture (model only when regex fires)
Reads `crm.db` directly and regex-scans for Nathan saying "make sure …"; the
model is invoked only on a match (≈0.2×/month). Meant to run frequently. **Real by
default; `--dry-run` previews** (STANDARD CONTRACT — same shape as ingest/compact).
A trigger must be ≥ `CRM_TODO_SETTLE_MIN` minutes old (default 5) before it is
extracted, so its discharge window can fill first — see the 2026-08-22
engineering-log entry.
```
node scripts/crm-todo-scan.js               # apply (default): extract + insert, advance cursor
node scripts/crm-todo-scan.js --dry-run      # preview: scan + report only, no writes, no model
node scripts/crm-todo-scan.js --since <id>   # rescan from an id, ignore the cursor
```

### `crm-tasks.js` — extract commitments from a ledger (model when triggered)
The ledger-based commitment extractor: a regex decides *whether*, the model
decides *what*. Returns JSON, writes draft tasks. **Dry-run unless `--write`.**
```
node scripts/crm-tasks.js --slug <slug>              # dry run
node scripts/crm-tasks.js --slug <slug> --write      # insert drafts
node scripts/crm-tasks.js --all --write              # every tracked contact
```

### `crm-backfill-stubs.js` — seed stub profiles (no model, one-time)
Mechanically creates one stub profile + `crm.db` row per named private Signal
contact. Used to bootstrap a fresh `data/contacts/`.
```
node scripts/crm-backfill-stubs.js
```

### `crm-transcript.js` — print an attributed transcript (no model)
Reconstructs who-said-what for any Signal conversation from the Signal DB.
```
node scripts/crm-transcript.js "<name substring>" [limit]
node scripts/crm-transcript.js --service <serviceId> [limit]   # a DM
node scripts/crm-transcript.js --conv <conversationId> [limit] # a group/DM
```

### `crm-backup.js` — protect crm.db (no model)
`VACUUM INTO` snapshot of `data/crm.db` to a sibling of the repo (it is excluded
from both git repos and is not regenerable). Verifies + prunes old backups.
```
node scripts/crm-backup.js                  # take, verify, prune
node scripts/crm-backup.js --check           # report only; exit 1 if newest is stale
node scripts/crm-backup.js --dest <dir>      # override destination (or CRM_BACKUP_DIR)
```

### `memory-commit.js` — snapshot data/ into history (no model)
Commits `data/` (excluding `crm.db`) to the isolated, remote-less
`.memory-history.git`. This is the recovery mechanism behind profile edits and
`crm-wipe`.
```
node scripts/memory-commit.js "<message>"
```

---

## Scheduling (Windows Task Scheduler)

PowerShell registrars in `tools/` (run once, from an elevated shell):

| Script | Task | Trigger | Runs |
|---|---|---|---|
| `register-archive-task.ps1` | Personal CRM Archive Sweep | top of every hour | `crm-archive.js` |
| `register-deep-sweep-task.ps1` | Personal CRM Deep Sweep | daily 03:00 | `crm-archive.js --deep` |
| `register-task.ps1` | Personal CRM Weekly AI | Monday 04:00 | `crm-daily.js` (ingest + compact) |

`register-task.ps1` (the model-spending weekly run) is intentionally **not
registered** right now — ingest and compact are triggered manually from the
dashboard. Sweeps are the only thing on a schedule.

`run-web-hidden.vbs` launches `crm-web.js` with no console window; a shortcut to
it in the Startup folder keeps the dashboard up across reboots.
