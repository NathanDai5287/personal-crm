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

## 2026-09-05

### DECISION — crm.db moved from rollback-journal to WAL
Closes off the alternative logged 2026-08-05 (rollback mode + a 15s busy_timeout as the
*only* serialization). That kept SQLITE_BUSY from killing runs, but readers and the writer
still contended: any open reader (a page render) blocked the writer and vice-versa, because
rollback mode locks the whole file for a write. WAL appends commits to a `crm.db-wal` sidecar
and readers read the main file + the log as of their own snapshot, so the reader/writer half
of the BUSY class is gone entirely (verified: a writer committed in ~1ms while a reader held
an open snapshot; the same write blocks the full busy_timeout under rollback). WAL is still
single-writer, so writer-vs-writer (a sweep INSERT racing a web task-write) still serializes
on busy_timeout — that half is unchanged. `synchronous=FULL` (the SQLite default, kept
explicit) over NORMAL: the archive holds Signal-deleted messages and is irreplaceable, so a
power-loss window that drops committed transactions is not acceptable, and at hourly-sweep
volume FULL costs nothing. Set on every open (lib/signal-db.js openCrmDb, and now
lib/nicknames.js) so a restore self-heals; a one-time stderr warning fires if the switch
returns a non-WAL mode (read-only dir / network mount — WAL is unsafe on network fs).

Reviewed by two independent agents (kimi-k3-high, cursor-grok-4.6-high). Consequences they
surfaced, now handled:
- **Restore is no longer `cp`.** A backup is delete-mode (VACUUM INTO output); if a stale
  `crm.db-wal` survives next to the file you overwrite, SQLite replays it and silently
  reverts the restore. Runbook written into scripts/crm-backup.js header: stop writers,
  delete crm.db + -wal + -shm, then copy the backup.
- **File-copy backups are now silently stale** (committed rows may live only in -wal). The
  `VACUUM INTO` rationale in crm-backup.js now says so; VACUUM INTO itself is WAL-correct
  (snapshots main + WAL). Its census verify was changed from exact-equality to a
  before/after **bracket**, because WAL lets a writer land mid-backup and a plain equality
  check would spuriously mark a good backup FAILED.
- **SURPRISE:** a plain `VACUUM` does NOT reset journal_mode to rollback on this runtime
  (node:sqlite) — verified it preserves WAL. The real way the file loses WAL is a restore of
  a delete-mode backup, not a VACUUM. (An earlier code comment claimed the VACUUM mechanism;
  corrected.)
- **nicknames.db** had the identical exposure (long-lived web singleton handle + pipeline
  writers) and was converted too. crm-import-archive.js now routes through openCrmDb().

Sidecars (`crm.db-wal`, `crm.db-shm`) were already excluded from both git histories
(.gitignore ignores all of data/; memory-commit.js excludes them explicitly).

---

## 2026-09-03

### DECISION — the Signal nickname is the single source of truth for a person's name
Audited every place a display name came from. Five sources existed and disagreed for
several contacts: the Signal profile name (set by *them* — gave us "fingersix",
"A Ch"), the iPhone contact name, the Signal nickname (set by *me*), the
`crm-display-names.json` override file, and the hand-editable profile `# Title`
(via a Rename button). New rule, in priority order: **Signal nickname → iPhone
contact name → phone number**. The Signal PROFILE name is never used.

- Verified the Signal nickname (`nicknameGivenName`/`nicknameFamilyName` on the
  conversation) is stored locally AND syncs across linked devices via Signal's
  storage service — the same 19 nicknames read byte-identically from Signal on DUNA
  and MINMUS. So renaming someone in the Signal app renames them here.
- New `lib/signal-names.js` is the ONE resolver (`signalNameMap`/`nameFor`);
  it excludes my own and the bot's serviceIds so a mis-linked contact is never
  retitled to the bot's nickname. Every caller that wrote
  `COALESCE(name, profileFullName, profileName, e164)` by hand now uses it.
- `crm-display-names.json` is DELETED. Its display-override half is subsumed by the
  rule; its alias half ("abhi" → Abhiram) moved into the confirmed-nickname store,
  which `lib/people-resolve` already layers over derived names (preserving
  EXPLICIT-BEATS-DERIVED). `lib/aliases` no longer reads any file.
- The profile `# Title` is now auto-derived and read-only: `crm-refresh.syncContactNames`
  rewrites the heading and `crm.db` name from the resolved Signal name on every run
  (idempotent), so the UI and the model can never drift. The Rename button/route/view
  were removed. To rename someone, set their Signal nickname.
- SURPRISE: DUNA carries 17 stale profile `.md` files (fingersix, p, shreyas, nigesh,
  abhiram-chalamalasetty, …) that MINMUS does not. `crm.db` contacts (37) and
  `crm-tracked.json` (20) are identical on both; only the served `.md` set differs.
  MINMUS's 20 tracked profiles ALL already match their Signal name — zero live drift.
  The earlier "4 mismatches" were DUNA-only cruft, not served.
- Archived sender labels are frozen (append-only); `crm-repair-senders` re-run under
  the new resolver relabels history, and now covers DMs, not just group rows.

## 2026-08-24

### SURPRISE — the structured-Person seam had nine fail-open/rebuild defects
Cross-model review exposed gaps that the first refactor's happy-path selftest did not
exercise. Fixed the mechanical cases without changing the unresolved content policy:

- `crm-wipe` now deletes the rebuilt profile's facts, outbound mention edges, and
  merge frontier together. Inbound edges remain because they are observations owned
  by other profiles.
- A manual clear is now a timestamped tombstone (`facts.retracted_at`), so a
  late-arriving older message cannot resurrect the value. A genuinely newer message
  can still supersede it; whether manual values should outrank even newer messages is
  a separate policy decision.
- Structured blocks must be fully closed; identity rendering uses replacement
  callbacks (so `$&`, `$1`, and `$'` are data); multiple identity facts render
  newest-first; inferred snapshot dates use the source message's Pacific day.
- Fact provenance is now restricted to the current chunk OR ids cited by the
  pre-merge profile. Mentions remain current-chunk-only. This preserves legitimate
  carry-forward while closing arbitrary archive-row provenance laundering.
- Standalone `crm-merge` now uses the same facts + mentions + merge-frontier SQLite
  transaction as daily ingest and supplies the ledger's valid message ids.
- Retry reply parsing reads only the newest pi session file. Cost accounting still
  sums every attempt, but a failed attempt's structured blocks can no longer leak
  into the successful attempt's commit.
- People cards with identity-only structured rows fall back to their existing prose
  summary instead of rendering blank.

Regression coverage lives in `evals/structured-person-selftest.js`; the four
deterministic suites remain green (42 mutants, 29 Timeline checks, 137 tier
assertions, structured-person PASS).

### DECISION — carried-forward fact provenance must already be visible in the pre-merge profile
The merge prompt permits a fact's source id to come either from the new ledger or
from that fact's existing profile citation. A chunk-only validator would reject
legitimate carry-forward; archive-existence-only permits laundering any archived
row into a fact and then superseding good history. The validator therefore accepts
the union of current chunk ids and citation ids extracted from the profile snapshot
taken before the model ran. It deliberately does not trust citations the model adds
during the current edit as evidence of prior provenance.

### DECISION — Person is now a structured read model; facts and mentions are authoritative rows
Completed the structured-person refactor that began with `lib/person.js` Phase 0. Merge replies now carry mandatory JSON `[[FACTS]]` and `[[MENTIONS]]` blocks. `lib/structured-person.js` validates source ids against the archive, resolves mention targets ambiguity-first through the existing people resolver, writes typed facts/edges, and deterministically renders `## What I know` plus identity fields. `lib/person.js` reads current facts and graph neighbors; the People page consumes that accessor. Relationship/Birthday/Phone manual edits write through as provenance-free manual standing facts. `lib/schema.js`'s redundant todo implementation was removed; `lib/tasks.js` remains the only task store.

No separate prose migration was added, per Nathan's earlier decision that this is still the first version. Existing profiles remain byte-for-byte unchanged until their next merge; that merge emits the complete current fact set from the profile plus ledger and the deterministic renderer takes over. This avoids a paid migration pass while giving each contact a clean transition at its normal ingest boundary.

### SURPRISE — the parked fact writer was not retry-idempotent or atomic with the merge frontier
`recordFact()` always inserted. If a model edit succeeded but the frontier write failed, replaying the same chunk would duplicate its facts; writing facts inside `crm-merge` would also allow facts to commit without `(contact,message)` advancing. Fixed structurally: exact fact replays dedup through `idx_facts_retry`, and crm-daily commits facts, mentions, and `merged` rows in one `BEGIN IMMEDIATE` transaction. The profile is rendered before commit and restored to its pre-merge bytes on any structured/frontier failure. This preserves the existing one-chunk/one-merge/one-frontier/one-commit unit.

The parked snapshot implementation also said identity included `as_of` but then bypassed incumbent lookup for every snapshot. That preserved a trend across different dates, but also kept contradictory duplicates for a correction at the same date. Snapshot rows now compete only when their identity keys match: different as-ofs coexist; a corrected same-as-of supersedes.

### DECISION — structured dates use Pacific date conversion, and derived values stay derived
Period/as-of `YYYY-MM-DD` values convert through `lib/weeks.js` (`dateKeyToMs`), never host-local or raw UTC. `deriveAge()` now evaluates against the Pacific date. The database refuses standing/periodic `age`, `tenure`, `years_together`, and `days_since_contact`; store the invariant or an honest snapshot instead.

### SURPRISE — People and Me rendered two navbars because both body and legacy shell supplied one
The Bindery view functions `V.people()` and `V.me()` already render `Tabs(...)`. Their server call sites nevertheless passed a `current` route to the legacy `page()` shell, which prepends another `V.Tabs(current)`. People acquired the extra argument during the nickname-inbox change; Me shipped with it. Fix: those two Bindery call sites no longer pass `current`. Custom/legacy bodies that do not contain tabs still use the shell argument.

### DECISION — reapply the scoped roster-bar/hover change for live inspection
After restoring the pre-change UI, Nathan asked to see `c3455d5` deployed with the duplicate-navbar regression fixed. Reapplied its scoped `.pcell .pbar` roster styling, `.jobbar` live-monitor class, 28px square bar, and hover count overlay. This supersedes the revert decision immediately below; the deployed result is now the evidence for the next iteration.

### DECISION — revert the roster hover-overlay attempt
The `c3455d5` roster-bar change did not fix the visible problem on minmus and introduced another UI problem. Reverted its code in full: counts return below the bar, the live monitor and roster again share `.pbar`, and the earlier 20px roster styling is restored. This deliberately reopens the CSS-collision problem recorded below; the next fix needs to start from the actually rendered minmus page rather than another unverified CSS adjustment.

### SURPRISE — a later `.pbar` rule turned the roster ingest bars into 10px pills
The roster bar was already `height:20px; border-radius:0`. A second `.pbar` block (live job monitor, further down the same stylesheet) overrode it to `height:10px; border-radius:5px` because both selectors had equal specificity and the later one won. That is why the people list still showed thin pills after two commits that had already "thickened" and "squared off" the bar.

Fix: roster bars are `.pcell .pbar` (28px, square); the monitor bar is `.jobbar`. Counts that sat under the bar now appear on hover, overlaid on the rectangle.

---

## 2026-08-23

### DECISION — the code now matches the operator's four-job mental model; "compaction" is renamed "Timeline" and is no longer a job
The job vocabulary in the code had drifted from how the system is actually operated, which was a
standing source of confusion. Realigned both, and made the alignment structural so it can't drift
again.

**The mental model (now the code's model, documented in `AGENTS.md`):** there are exactly FOUR
periodic jobs — `sweep`, `deep-sweep`, `ingest`, `todo`. Each runs on its own cycle and checks an
enable flag; if on, it does its work. **`ingest` has two halves, MERGE and TIMELINE.** Timeline is
NOT a job — it is ingest's second half.

What changed:
1. **`lib/jobs.js` is the single source of truth** for the job list (`JOBS`, `JOB_IDS`,
   `MODEL_JOBS`). `run-toggles`, `run-models`, and the dashboard all derive from it — no more two
   hand-maintained `JOBS = [...]` arrays that disagreed.
2. **`compact` is no longer a job.** It had been a third toggle/model entry (`run-toggles`,
   `run-models`) with a whole `compact` job-kind in the web dispatcher and its own standalone
   timer — yet no dashboard dial ever surfaced it, so those were dead-but-live controls, and the
   standalone timer duplicated the Timeline work ingest already does. All of that is removed.
   Timeline runs ONLY as ingest's second half.
3. **Rename `compact` → `timeline` throughout the pipeline:** `scripts/crm-compact.js` →
   `scripts/crm-timeline.js`, `lib/compact-prompt.js` → `lib/timeline-prompt.js`, config
   `COMPACT_MODEL/PROMPT/STATE` → `TIMELINE_*` (old `CRM_COMPACT_*` env still honoured), cost
   `compactCall*` → `timelineCall*`, run-record `kind:'compact'` → `'timeline'`, and the UI ink
   `--k-compact` → `--k-timeline`. Legacy run records with `kind:'compact'` still render (readers
   normalize the old spelling; `.mk.compact` etc. kept as aliases).
4. **Only the two PAID jobs (ingest, todo) carry an enable switch.** The free sweeps always run.
   (An earlier draft of this refactor added switches to `sweep`/`deep-sweep` too, to make the
   "every job checks a flag" model uniform. That was REVERTED after a review pointed out it is a
   silent-data-loss footgun: pausing a sweep stops archiving disappearing messages before they
   vanish, for no cost saving. Nathan's call: sweeps are always on, no switch. So `run-toggles`
   and the dashboard toggle set are `MODEL_JOBS` = `['ingest','todo']`, and `crm-archive.js` has
   no pause gate.)

**Intentional carryovers (do NOT "fix" these):** the prompt file `prompts/compact.md` (authored
separately), the on-disk `data/crm-compact-state.json` and `data/_compact-backup/` (renaming would
orphan aging state / backups), and the `evals/compact-*.js` harness (isolated subsystem) keep the
old spelling. Only their surrounding prose was updated.

**SUPERSEDES** parts of the uniform-CLI-contract entry directly below: its point 3 spoke of "the
compact toggle" and "the standalone weekly compact timer" — both are gone. Ingest's internal
Timeline call still passes `--force`, but there is no longer any compact toggle to be re-gated by;
`crm-timeline.js` has no pause gate at all now (it is not a job).

### DECISION — one uniform CLI contract for every scheduled model job
After the compact-dry-ran-forever bug (below), standardized the three scheduled model scripts
(`crm-daily.js`, `crm-todo-scan.js`, `crm-compact.js`) onto one contract so a timer can never
again mismatch a script's argument quirks:

1. **Real by default; `--dry-run` previews.** No mode flag means "do the real thing." `--dry-run`
   is the only way to get a no-write, no-model preview. (Chosen over "explicit `--run`"; Nathan's
   call.) `--write` is kept as a **silent no-op alias** so old invocations/docs don't break —
   internally each script derives its apply flag as `!DRY_RUN`, so existing `if (write)` bodies
   were left untouched.
2. **One shared pause-gate.** `lib/run-toggles.paused(job, {dryRun, force})` and its companion
   `pauseMessage(job)` are the ONE definition of "does this run pause?": pause iff a real
   (non-dry-run), non-`--force` run whose UI toggle is off. All three scripts call it identically
   at the top of `main()`. This kills the old per-script drift where compact's gate keyed off a
   `wouldSpend` calc and only tripped under `--write`.
3. **Sub-calls inherit the parent's authorization.** Ingest's internal Timeline step
   (`crm-daily.js` → `crm-compact.js`) now passes `--force`, so it is gated only by the **ingest**
   toggle, never re-gated by the **compact** toggle. The compact toggle governs only the
   standalone weekly compact timer. Rule going forward: **a toggle gates the top-level scheduled
   entrypoint; internal sub-calls are always forced.**
4. **Every timer's ExecStart is now flag-free** (`node scripts/<job>.js`), differing only in
   `OnCalendar` and script name. Adding a job = copy a unit, change two lines.

### SURPRISE — two scheduled scripts were dry-run-by-default, so their timers did nothing
When wiring the ingest/todo/compact timers, `crm-compact.js` and `crm-todo-scan.js` turned out to
be **dry-run unless `--write`**, and — worse — their run-toggle pause gate *only fired under
`--write`*. A timer running them bare would have dry-run forever: no work, no pause, no error, no
sign anything was wrong. `crm-daily.js` was the opposite (writes by default). The inconsistency
is the whole reason a timer's args had to be hand-matched per script. Fixed by the uniform
contract above; verified each job now applies-by-default and pauses through the shared gate.

### DECISION — Pacific time is the master time, everywhere, always
**America/Los_Angeles is the one and only clock for this project.** There is no second
time zone anywhere — not UTC, not the machine's local time, not the viewer's. Every date and
time the pipeline computes, stores, displays, or schedules is Pacific:
- **App logic** already routes all date math through `lib/weeks.js` (Pacific helpers). Never
  reach for `Date`/`toISOString`/system-local time directly — go through those helpers.
- **The host clock** is set to it: minmus `timedatectl` → `America/Los_Angeles`. This is a
  requirement, not a coincidence — the systemd timers below inherit it.
- **systemd `OnCalendar=`** is evaluated in the host time zone, so every timer time
  (`Mon 04:00`, `03:30`, `*:10`) is Pacific *because the host is Pacific*. If the host TZ ever
  changed, every schedule would silently shift — so the host must stay on Pacific.
If you add anything that touches time — a script, a timer, a display field — it is Pacific.
No exceptions, no conversions, no "just this once in UTC."

### REFERENCE — all periodic jobs are now scheduled (minmus user timers)
As of today every pipeline job has a `--user` systemd timer next to `crm-sweep.timer`
(`~/.config/systemd/user/`, enabled, `Persistent=true`). Times are Pacific (see above):

| Timer | OnCalendar (PT) | Service runs | Model? | Ships |
|---|---|---|---|---|
| `crm-sweep` | `hourly` (:00) | `crm-archive.js` | no | on |
| `crm-todo` | `*:10:00` (hourly, after sweep) | `crm-todo-scan.js --write` | on a match | **off** |
| `crm-sweep-deep` | `03:30:00` daily | `crm-archive.js --deep` | no | on |
| `crm-ingest` | `Mon 04:00:00` weekly | `crm-daily.js` | yes | **off** |
| `crm-compact` | `Mon 06:00:00` weekly (after ingest) | `crm-compact.js --write` | yes | **off** |

The three model jobs (`ingest`, `todo`, `compact`) ship with their **UI toggle off**
(`data/crm-run-toggles.json` = all `false`), so the timers fire but each run self-pauses at
startup and spends nothing until Nathan flips it on. Verified functionally: ingest and compact
print "PAUSED"; todo holds triggers with "no model call". Enabling a job is a UI toggle — no
timer edit needed.

**GOTCHA that bit here — `crm-todo-scan.js` and `crm-compact.js` are dry-run by default, and
their toggle-pause gate only trips under `--write`.** A timer running them with no flag would
dry-run forever (no work, no pause) — so both `ExecStart` lines carry `--write`. `crm-daily.js`
is the opposite: it writes by default (its gate is `!DRY_RUN && !FORCE && !isEnabled`), so its
timer takes no flag. When adding a job timer, check whether its script writes by default before
copying an ExecStart.

### REFERENCE — the minmus systemd layout (what runs, where, and how to update it)
crm.cal.taxi now serves from minmus. The pieces are split across **two** systemd managers,
which is the thing to internalise before touching any of it:

**1. The web app — a SYSTEM service, `crm-web.service`.**
- Lives at `/etc/systemd/system/crm-web.service`; managed with plain `systemctl` (root/sudo to
  start/stop/disable/edit; `systemctl status crm-web` is fine unprivileged).
- `Type=simple`, `User=natha`, `WorkingDirectory=/home/natha/personal-crm`,
  `ExecStart=/usr/bin/node scripts/crm-web.js`, `Restart=always`, `RestartSec=5`, enabled at boot.
- It is **only the long-running web server** on `127.0.0.1:8787`. It does **not** contain,
  schedule, or run any of the pipeline jobs. It renders the dashboard and, when you press a
  button in the UI, shells out to the job scripts on demand — but it is not itself the jobs.

**2. The periodic jobs — USER units under `~/.config/systemd/user/`.**
- Managed with `systemctl --user` (no sudo). `Linger=yes` is set for natha
  (`loginctl show-user natha -p Linger`), so the user manager — and these units — run at boot
  even with nobody logged in.
- `crm-sweep.timer` (`OnCalendar=hourly`, `Persistent=true`) → `crm-sweep.service`
  (`Type=oneshot`, `ExecStart=/usr/bin/node scripts/crm-archive.js`) is the original example.
  **SUPERSEDED same day:** timers for todo / ingest / compact / deep-sweep were added too — see
  the "all periodic jobs are now scheduled" REFERENCE above for the full set.
- (The archive sweep never backs up crm.db — the backup runs only inside an ingest,
  `crm-daily.js` step 0 — which is why minmus's backup is stale: 0 ingests so far.)

**The UI toggle is not a scheduler.** The pause switch and model dropdown on each cadence card
write flags to `data/crm-run-toggles.json` / `data/crm-run-models.json` that a run *reads at
startup*. They gate and configure a run; they cannot create the *schedule* that fires one. A job
runs automatically only if it has a `--user` timer (today: sweep only). So enabling a toggle for
ingest does nothing on its own — there is no ingest timer to gate.

**Updating after a git pull.** `crm-web` loads the view/server code into a long-lived node
process, so **code changes require a restart** (do it after every pull to be safe). Two ways,
both leave the exact same schedule intact:
- No sudo: `kill $(systemctl show -p MainPID --value crm-web)` — `Restart=always` respawns it in
  ~5 s on the new code. This is what the deploy step does over ssh.
- With sudo: `sudo systemctl restart crm-web` (preferred — cgroup-kills the whole unit).
The job scripts (sweep etc.) are launched fresh each fire/press, so they pick up new code with no
restart needed.

**Restart safety (P5-1).** crm-web now handles SIGTERM/SIGINT: before exiting it kills the running
job's child *process group* (jobs run `detached`, so the whole crm-daily→pi tree dies) and releases
the pipeline lock. Both restart methods above send SIGTERM, so a restart mid-ingest no longer
orphans children that keep writing crm.db while the respawned server — seeing a now-dead-PID lock —
judges it stale and STEALS it (two concurrent writers). The aborted ingest is crash-safe (per-chunk
merge frontier) and resumes next run.

### SURPRISE — a duplicate user `crm-web.service` crash-looped the new system service
Installing the system `crm-web.service` (2026-08-23) collided with a **pre-existing user-level
`crm-web.service`** that was still enabled with `Linger=yes`. Both bound `127.0.0.1:8787`, so
whichever lost the race sat in `activating` crash-looping on `EADDRINUSE` (MainPID 0 while the
port still answered — the tell that *something else* owned it). Fixed by
`systemctl --user disable --now crm-web`; the system unit is now the only crm-web. Two footguns
here: (a) minmus has **no `pkill`** — the install script's `pkill` silently no-op'd (exit 127),
leaving an orphan holding the port, so kill by explicit PID; (b) a stuck `activating` + `MainPID
0` on a `Restart=always` unit almost always means a *different* process owns its port — check
`ss -ltnp | grep <port>` and the process's PPID (PPID 1 = the intended system service; anything
else is a stray).

### DECISION — web is a system unit, jobs are user units (don't need to match)
Kept crm-web as a **system** service but left the sweep (and any future ingest/todo/compact
timers) as **user** units. Rationale: consolidating would need sudo I can't run headless
(disabling a system unit, or writing timers into `/etc/systemd/system`), whereas user timers need
no sudo and the sweep already lives there. So the pattern going forward: **new periodic jobs =
`--user` timers next to `crm-sweep.timer`; the web server stays the one system unit.** Scheduling
ingest means recurring paid spend, so its timer is deliberately not created yet.

---

## 2026-08-22

### REFERENCE — the minmus (Ubuntu) deployment, as it stands
The pipeline is being migrated from DUNA (Windows desktop) to **MINMUS** (`ssh natha@minmus`,
Ubuntu, repo at `/home/natha/personal-crm`). State as of today:

- **Signal source**: Signal Desktop runs *on minmus*; its DB is at
  `/home/natha/.config/Signal/sql/db.sqlite`, decrypted with the vendored linux-x64 sqlcipher
  prebuild (`vendor/sqlcipher/prebuilds/linux-x64/`). It syncs live.
- **`.env` (per-machine)** sets the Linux paths: `CRM_SIGNAL_DB`, `CRM_SIGNAL_CONFIG`,
  `CRM_SIGNAL_LOCAL_STATE`, `CRM_PI_CLI=/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`,
  and **`CRM_ARCHIVE_ID_OFFSET=100000000`** — minmus stamps archive ids +100M so they can
  never collide with DUNA's when the two archives are compared/merged. minmus therefore has its
  OWN independently-built `crm.db`, not a copy of DUNA's.
- **Secrets present**: `data/signal-key.txt`, `data/web-password.txt`. Display-name overrides
  were renamed here too (`crm-nicknames.json` → `crm-display-names.json`).
- **Scheduling**: the archive sweep is a **systemd timer** — `crm-sweep.timer` → `crm-sweep.service`,
  hourly. That is the ONLY scheduled job on minmus. There is **no cron** and **no timer** for
  ingest / todo-scan / compact / deep-sweep yet.
- **crm-web**: a **bare `node scripts/crm-web.js` process** (NOT a systemd unit), binding
  `127.0.0.1:8787` (`WEB_PORT` default), restarted by hand — it will not survive a reboot.
- **pi auth**: Anthropic was added 2026-08-22 (was moonshotai-only). So free Anthropic model
  runs are now possible; before that only paid Kimi was.
- **Still pending for a real cutover**: a `crm-web.service` unit + timers for the paid jobs;
  minmus has NEVER run an ingest (0 ingest runs); `crm.db` backup is stale/missing; and
  `crm.cal.taxi` still points at DUNA (DUNA still sweeps, redundantly).

### REFERENCE — the ingest cadence gate (when a contact's messages get merged)
`lib/weeks.js` `gateBuckets()`, driven by three constants in `lib/config.js`:
`INGEST_N = 200`, `INGEST_FLOOR_DAYS = 7`, `INGEST_CEILING_DAYS = 35`.

Messages accumulate oldest-first into a **pile**. The pile is released as a merge bucket when
**either**:
- it has spanned **≥ 35 days** (`ceilingDays`) — the *silent-pile ceiling*, so even a quiet
  contact is merged at least ~monthly regardless of volume; **or**
- it has spanned **≥ 7 days** (`floorDays`) **and** holds **≥ 200 messages** (`N`).

Everything in the **current incomplete week** (`day ≥ cutoffDay`) is never released — it is
deferred to a later run. Read as min/max/cutoff:
- **Min time (7d floor)** — a burst is never merged younger than a week, so rapid back-and-forth
  settles into one coherent bucket instead of many thin ones.
- **Max time (35d ceiling)** — a slow trickle is force-merged after 35 days even with < 200 msgs.
- **Message cutoff (200)** — the volume that, combined with the floor, triggers an early release.

A released pile is then split by `planChunks()` into week-aligned, token-bounded chunks — one
merge model call per chunk (the unit the cost estimate and per-chunk cursor commit both use).

### REFERENCE — the self-calibrating cost estimator (`lib/cost.js`)
Yes, it exists. Two estimates, one truth:

- **Call COUNT** comes from replaying the REAL ingest gate — `estIngestFromRows()` runs the same
  `gateBuckets` + `planChunks` the pipeline uses, so the number of merges it predicts is what
  will actually happen, not a one-merge-per-week proxy.
- **Per-call PRICE is self-calibrating.** Two things dominate a bill and neither is knowable up
  front: how many agentic **turns** a merge loops (the whole input payload is re-sent each turn)
  and how many **output+reasoning tokens** it emits. Rather than freeze guesses, we fit them per
  model from actual runs:

  ```
  usd ≈ A·base + B      with  A = price_in · turns,  B = price_out · out
  ⇒   turns = A / price_in,   out = B / price_out
  ```

  where `base` = `mergeInputBase` (system prompt + profile + ledger + tool scaffold — the
  per-turn input). `recordCostSample()` appends `{model, base, usd, at}` to
  `data/crm-cost-samples.jsonl` whenever crm-daily sees a real billed cost; `fitCostModel()`
  least-squares fits A and B per model and writes `data/crm-cost-model.json`, re-fit after each
  run. `mergeCallUsd()` then uses the measured `turns`/`out` for that model.

- **Guards.** `FIT_MIN_SAMPLES = 5` — below that a model keeps `evals/estimate.js`'s midpoint
  defaults (3 turns / 5,000 out). A pathological fit (turns outside 0.5–20, out outside 0–100k)
  is rejected and the defaults stand. `anthropic/*` bill $0 under subscription auth (`isFree`),
  so they contribute NO samples — only paid (`moonshotai/*`) models ever get a fitted curve.
- **Ground truth** the fit calibrates against: `sumSessionCostUsd()` sums pi's real per-turn
  `usage.cost.total` out of the session JSONL after a run — the actual billed figure, not an
  estimate.

Surfaces in the `/admin` roster pending-cost, the job confirm modal, and the run ledger
(`fmtUsd`, labelled "est."). **Current state (2026-08-22):** no model has ≥5 paid samples yet
(DUNA has only ~5 ingest runs and its recent runs were free Anthropic), so `crm-cost-model.json`
is empty and every estimate is still on the 3-turns/5k-out defaults — which is exactly why the
backfill figures quoted this session are ±50% ballparks, not fitted numbers.

### DECISION — todo triggers settle for 5 minutes before extraction
Nathan asked what happens if he sends "i'll make sure …" right at the top of the hour, before
the conversation has enough context. It exposed a real gap: the sweep and `crm-todo-scan.js`
run back-to-back in one hourly Task Scheduler job (`run-archive-hidden.vbs`), so a trigger is
normally archived *and* extracted in the same pass — before the lines after it exist. The
extraction is once-only (the cursor advances past the trigger), so a discharge ("nvm") that
lands after that pass is never reconsidered. That is the `AFTER = 8` window in
`lib/task-trigger.js` being defeated by timing, and it is the concrete form of the 2026-08-04
OPEN item #2 ("no discharge detection").

Fix: a **settle margin** — a trigger is not extracted until it is ≥ `CRM_TODO_SETTLE_MIN`
minutes old (default **5**; `0` disables → today's behaviour). Implemented in `crm-todo-scan.js`
by holding back any candidate whose `sent_at` is within the margin and capping both the cursor
(`safeHi`) and the extraction ledger just below the earliest held trigger — the cap on the
ledger is load-bearing because `extractFor` re-scans whatever ledger it is handed
(`crm-tasks.js:116`), so filtering a list is not enough to keep a held trigger out of the model
call. A held trigger stays above the cursor and is reconsidered, now older, next run.

Latency cost, given the hourly sweep+scan cadence (M = 5):
- **Best case** ≈ M (~5 min) — sent just over M before a top-of-hour.
- **Worst case** ≈ 60 + M (~65 min) — sent just under M before the hour, missing this run's
  margin and waiting one extra cycle. (Without the guard: best ~seconds, worst ~1 hour.)

Everything still lands as a **draft** for manual acceptance, so this only affects *when* a draft
appears, never whether a live reminder fires. Held triggers are logged (`… N trigger(s) too
fresh`) so a deferred capture is never silent.

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

## 2026-08-04 — provenance ranges (design; nothing built)

Spec in `docs/PROVENANCE-SPEC.md`. Recorded here are the alternatives it closes and
the measurements that closed them.

### MEASUREMENT — a rowid range is not a conversation
`m<id>` is Signal's global `messages.rowid`, one insertion stream across every
conversation, so a bare `[start,end]` spans unrelated chats. A 60-wide window
ending at Katia's latest message holds 45 rows of the Arshia DM and 16 of "Nat &
Kat". Across all eleven current ledgers, a contact's own messages are 2-6% of
their ledger's own id span in nine of them; katia-jacoby's 68% is a burst week.
So ranges must resolve as `conv_id = thread(start) AND id BETWEEN start AND end`,
and the `≤10` cap must count thread rows, not `end - start`.

### DECISION — thread scope is DERIVED from the endpoints, not a stored field
I first argued the citation needed a scope field, since the model sees only a
human label (`(Nat & Kat 🥾🩷)`) and never a `conv_id`. Wrong shape: requiring
`thread(start) == thread(end)` gets scoping for free and turns the
cross-conversation hazard into a check instead of a new field the model can get
wrong. Emoji-bearing group names would also have made terrible tokens.

### DECISION — the model picks endpoints; code-stamping was rejected
The alternative was stamping each bullet with the chunk span the merge was handed,
which is already recorded in the ledger header and the merge commit subject
(`scripts/crm-web.js:979`) — free and never malformed. Rejected by Nathan's 10-message
cap, which makes it impossible: a 242-message chunk cannot be stamped into ≤10. It
was also near-useless as provenance, pointing at a whole week for a single fact.

### DECISION — no marker distinguishing fact citations from characterisation ones
Considered a separate glyph so checks could demand tight provenance for checkable
facts and spread samples for traits. Rejected because every check that matters is
kind-independent (endpoints resolve, same thread, ≤10, non-overlap), and the one
that is not — does this stretch support this claim — is `evals/judge.js`, which
reads the bullet's prose and needs no marker. Cost accepted: nothing can enforce
"a characterisation needs 2-3 spread ranges", so a lazy one-Tuesday citation on a
trait bullet is legal and unrejectable.

### CORRECTION — week-spread cannot be enforced
I proposed a check requiring multi-range citations to fall in different weeks, on
the reasoning that three stretches from one week is one mood while three from
three months is a pattern. It would fail a legitimate case: a plan mentioned
Monday and confirmed Friday is one fact with two same-week ranges. Only
non-overlap is enforced; spread is a prompt request.

### CORRECTION — "characterisation prose cannot be cited under a cap"
I said a 10-message cap left "dry humour" uncitable, since any 10 of thousands of
messages are an example rather than a source. That assumed one citation per
bullet. Nathan's fix — 2-3 ranges on the same bullet — is sound, and the
assumption was the flaw.

### CLOSED — an archive read tool for the merge
Nathan asked whether the model should get a function returning messages in order.
It already has one: `--tools read,edit` with two `@file` attachments, and
`_refresh/<slug>.new.txt` is an ordered, thread-labelled series whose header
declares its own id span. The only case for a *wider* read tool was repairing the
157 pre-citation `What I know` bullets, and clearing the archive before the
backfill dissolves it — every bullet will be born cited. Not built, and no longer
wanted; it would also have cost the merge its purity as a function of
profile + ledger (`scripts/crm-merge.js:42`) and broken the eval sandbox, which
copies only those two files.

### CLOSED — id lists
`⟨m89166, m89167⟩` is gone. Adjacent messages are a two-message range; genuinely
separate moments get separate citations, max 3 per bullet. Comma is therefore free
but was NOT reused for the primary separator — the git history, `prompts/merge.md`
and five `MALFORMED` patterns all still carry its old meaning. `@m<id>` instead.

### AMENDS the CLOSED entry above — the read tool has one live case after all
Nathan then asked that citations be ranked by which best back the claim rather than
by position. That comparison is precisely what the merge cannot do: the current
chunk is in context in full, an incumbent citation is only the token
`⟨m88104-m88110⟩`, and the ten messages behind it are not readable. So the ranking
rule is implemented as strength-within-chunk plus a positional fallback across
chunks (`docs/PROVENANCE-SPEC.md` §4), and the read tool stays unbuilt but is no
longer caseless. "No longer wanted" above was true only of the legacy-repair
motivation.

### DECISION — the citation cap is per claim, and prompt-only
V6 originally read "≤3 citations per bullet". Reviewing the spec against the merge
prompt found the collision: `What I know` bullets are cited per claim and hold five
or six facts each, so a normal steady-state bullet carries five or six citations and
would fail its own check. I proposed loosening the mechanical check to ≤6 per bullet
with 3-per-claim as a prompt rule; Nathan cut the check entirely — a bullet bound
loose enough to pass a six-fact bullet catches nothing real. So: at most 3 citations
per claim, prompt rule only, since nothing marks claim boundaries inside a bullet for
a check to count against — the same shape as the spread rule. The validity table
renumbers to V1–V7 (non-overlap and ledger-literal move down one). `tp_format` still
bounds Talking points bullets at 1–3 citations independently. Same review: the
merge.md blast radius is ~7 sites, not the 2 in the spec's first draft — hard rule 4
("appears literally in the ledger" is false of a range token), the worked examples
(which teach the old grammar and would beat the new rules), and the closing
checklist all encode single-id citations. New prompt drafted in full as
`prompts/merge-v7.md`; production `merge.md` untouched until the checks can parse
ranges.

## 2026-08-04 — the arena: ranking merge prompts after check saturation

### DECISION — human preference labels, not another check
The deterministic suite is saturated (C, E and F all 312/312 including every
held-out case), and the recorded lesson generalises: a check written to enforce a
new rule is won by the next prompt that adds the rule — one generation of headroom
per check, and the check's author is also the prompt's author. The judge can rank,
but it is Opus judging Opus with self-preference still unmeasured (roadmap). The
metric that cannot saturate is the end user's blind preference on real outputs:
the profile exists for Nathan, so Nathan's vote IS the objective rather than a
proxy for it. Under that metric all-ties is a real verdict — "no material
difference at this fixture set" — not a ceiling artifact. Division of labour:
checks stay as the contract floor (regression gate, never a ranker), the judge
stays the cheap screen, the arena is the ranking authority.

### DECISION — one new check, three new fixtures; counts stay prompt rules
The saturation lesson bounds what a new check may be: it must close a hole in the
contract, not encode taste — taste is the judge's and arena's job. Against that
bar, built exactly one: `no_invented_citations` now harvests ledger ids at LINE
positions (`ledgerLineIds`), because `citationIds(ctx.ledger)` accepted an id
typed into a message BODY — anyone who can send a message could mint provenance
("my receipt code is ⟨m999999⟩"). compact-checks closed its copy of this hole in
its own review; the merge side never got the fix. The range oracle
(`makeLedgerRangeResolver`) was already line-anchored. New selftest mutant proves
the closure; 33 mutants, all caught. Considered and REJECTED: a stale-TP-date
check (mention-dated bullets are legitimately in the past — undecidable without
knowing event-vs-mention), a date-plausibility check (parsing natural-language
dates out of bodies guarantees false positives), a duplicate-bullet check (exact
dupes are too rare to pay for, near-dupes are semantic), and every flavour of
citation-count check (Nathan's standing call: counts are prompt rules).

### BUILT — three fixtures, and the fixture set no longer decays
`ho-two-thread` (liang-dai): the only multi-thread ledger in the pool (9 flips) —
without it the range grammar's hardest constraint, V3 cross-thread endpoints, is
never exercised against real interleaving. `spoofed-id`: a fake ⟨m999999⟩ token
inside a message body — the opportunity the new line anchor exists to make fatal.
`contradiction`: a planted, cited profile claim that three rewritten
contact-spoken lines cleanly reverse — conflict handling ("replace, don't
append") had zero organic coverage since no given week reliably contradicts a
profile. Also: REAL_CASES now get the same re-plan-from-history fallback as
held-out contacts — charles-wu's cursor caught up after a production merge and
the median case plus all three synthetics built on it had silently dropped out.
An eval set that shrinks as production advances measures less every week without
saying so. Fixture set is now 12 cases and reproducible regardless of cursor
state.

### BUILT — `evals/arena.js`
`node evals/arena.js <runDir>` serves a local blind pairwise voting UI over an
`evals/run.js` artifact dir: per side, a line diff of before-profile →
after-profile; ledger collapsible; keys a/t/b; optional per-vote note. Sides are
"A"/"B" with the variant assignment randomized per comparison and held
server-side (position bias is randomized away rather than double-judged — the
human is the scarce resource). Votes append to `<runDir>/arena-labels.jsonl`;
voted comparisons are never re-served, so sessions resume freely. `--tally`
prints per-pair W/L/T plus notes. One run dir only — both sides always saw
byte-identical fixtures; cross-model comparisons go through `--fixtures-from`
runs first. Smoke-tested end-to-end against the 2026-08-03 e/f run (8
comparisons): serve, vote, side-resolution, tally, resume, cleanup.

### SHIPPED — provenance ranges (`docs/PROVENANCE-SPEC.md` §6, all rows)
`⟨m90211-m90219 @m90215⟩` is the live citation grammar. `prompts/merge-v7.md` is now
`prompts/merge.md` (verified byte-identical to `merge-v6.md` before overwriting, so
the old production text is preserved under its version number). Sites: `CITE`/
`CITE_PARTS`/`MALFORMED`/`tp_format`/`citation_range_valid` in `evals/checks.js`,
`CITE_RE`/`extractCitations` in `lib/archive.js`, `inline()` plus a new
`/m/<start>-<end>` route in `scripts/crm-web.js`, range mutants in
`evals/selftest.js`. Selftest: 32 mutants, 15 checks, all caught.

### DECISION — the range check needs a SECOND ctx hook, not a wider `resolveIds`
`resolveIds(ids) -> missing` answers "does this id exist", which is V2 and nothing
else. V3–V5 need the *thread* of an endpoint and the *resolved row set* of a span,
which that signature cannot express. So `citation_range_valid` takes a separate
optional `ctx.resolveRange(start, end)` returning
`{ startFound, endFound, startThread, endThread, ids }`, and the ledger oracle
(`makeLedgerRangeResolver`) returns the identical shape — so V1–V6 is one code path
with two data sources rather than two implementations that can drift apart.
`evals/run.js` now builds the archive one alongside `makeResolver()`; without that
the archive branch would have been unreachable code, which is the exact failure
`evals/selftest.js` exists to prevent. Both branches are asserted in the selftest.

### EXPECTED a fixture edit, GOT a fixture rewrite — the selftest ledger was too small
The old selftest ledger was 3 messages in one thread. Over-cap (V4, >10 messages of
one thread) and cross-thread (V3) are not expressible against it *at all* — not as a
mutant on the profile, because the ledger is the oracle. So the fixture grew to 15
lines across two threads (a 12-message DM run, then `(the boys 🐗)`), with the group
starting at m1012 immediately after the DM's m1011 so a cross-thread range is one
adjacent pair. The lesson generalises: when a check's oracle is a fixture, a new rule
can require the fixture to change shape, not just the mutant.

### CONFIRMED by measurement — V4 must count rows, and old profiles do trip the new patterns
Ran the new `MALFORMED` set over all 37 real profiles read-only: exactly one file
trips `comma-separated id list`, and *nothing* false-positives on the en/em-dash,
`..`, missing-`m`, bare-number or unclosed patterns. That is the expected shape — old
comma-list citations are deliberately not supported, and the archive is cleared before
the backfill. Separately, against the real archive a 400-id span in `Nat & Kat 🥾🩷`
resolves 278 of 397 rows (70%, the burst-week thread), while a compliant 10-message
range resolves exactly 10 — so `end - start` would have been wrong in both
directions, as §4 says.

### DECISION — `evals/compact-selftest.js` comma lists stay
Its fixtures (`⟨m86724, m86726⟩`) are the one place in `evals/` still carrying the old
separator, and they were deliberately left alone: they exercise
`evals/compact-checks.js`, which has its OWN `CITE`/`MALFORMED` pair and feeds
`## Timeline`, which spec §5 keeps single-id and copied verbatim. Rewriting them to
range form would assert a grammar the Timeline does not use. Verified still passing:
19 mutants, 12 checks.

## 2026-08-04 — the Last-contact normaliser never worked

### SURPRISE — `normalizeLastContact` was born broken and its catch ate the proof
Every merge of the F-vs-G validation run logged `Last contact NOT normalised:
path is not defined`. `crm-merge.js` never requires `path`; the `path.join` calls
arrived with cb25855 (2026-08-03), so the function has thrown `ReferenceError`
into its own try/catch on EVERY merge since it shipped — production included. The
DECISION entry above ("Last contact is derived in code, not judged by the model")
described a state that never existed: the model has been the only authority all
along, and `last_contact_current` kept passing only because Opus copies the date
correctly — K3, the model the normaliser was built against, is the one that
fabricates. Two lessons. A catch that returns the error as data still needs a
reader: the message WAS printed on every production run and nobody greps
production stdout. And "verified in isolation" verifies the snippet's scope, not
the module's — the test context had `path`; the module did not. Fixed with the
one-line import; re-verified through the real module: stale profile date
2026-06-01 + ledger ending 2026-08-02 → `{from: 2026-06-01, to: 2026-08-02}`.

### MEASUREMENT — first arena session: the human inverts the judge
Nathan voted the same 12 comparisons blind: **G 4, F 1, tie 7** — against the
judge's F 5, G 2, tie 5. Per-case agreement 8/12, and all four disagreements are
the judge picking F where Nathan picked G or tie (large-ledger, large-profile,
ho-partner, injection). The judge's F-lean is not Nathan's taste — treat the
judge as a screen, never a verdict, which is what the arena was built to prove.
Nathan explicitly liked "ranges with a center" (the `@primary` design) and G's
detail density — the exact thing the judge scored as restraint failures. His
notes yielded three prompt findings no deterministic check could encode:
1. **The model doesn't know the reader is Nathan.** Profiles say "Nathan" in
   third person and accrue Nathan-self notes inside other people's files. The
   prompt should say the reader IS Nathan (write him as "you") and keep
   self-facts out of contacts' profiles — relationship state (offers, plans
   between them) stays.
2. **No catch-all "recurring topics" bullets** — split topics into their own
   bullets or drop them.
3. Ties dominated (7/12): the two prompts are close, so v8 should target the
   note findings, not the grammar.

AMENDS, per Nathan the next day: do not treat the exact picks as ground truth
either — a single session's W/L is noisy preference signal, and the durable
output of an arena session is its NOTES (reader-is-you, recurring-topics, the
date flag that found the UTC seam), not its tally. The division of labour
stays checks = floor, judge = screen, arena = ranking signal — "signal", not
"oracle".

### SURPRISE — the arena's "very serious error" was the fix working, and it found a UTC seam
Nathan flagged ho-large: both variants moved `Last contact` 2026-06-17 →
2026-06-16, "a very serious error." Root cause: one instant, two calendar dates.
Vlad's last message is 2026-06-17T00:01Z == **2026-06-16 5:01pm Pacific**. Every
date this repo prints is Pacific (`lib/weeks.js` `dateKey`, ledger lines, week
boundaries, `ledgerMaxDate`), but the profile carried the UTC date, and the
sandbox normaliser (ledger fallback) corrected it to Pacific truth — the rewind
was RIGHT. The actual bug was in the normaliser's archive branch:
`toISOString().slice(0,10)` is UTC, so any last message after 5pm Pacific would
write a date one day ahead of every ledger — a branch armed only this morning by
the `require('path')` fix. Now `dateKey(r.t)`; both branches agree; verified on
the vlad instant from both paths.

### CORRECTION — the founding evidence for code-derived Last contact was partly a timezone artifact
The DECISION above cites K3 "writing 2026-06-17 for a ledger ending 2026-06-16"
as fabrication. That case was vlad — and 2026-06-17 is exactly the UTC date of
the same final instant. K3 almost certainly echoed the UTC-polluted profile
value rather than inventing a date. The decision stands — deriving the field in
code is still right, now more so — but the evidence was misread, and "the model
fabricates dates" should not be re-cited from that example.

### MEASUREMENT — first semantic F-vs-G verdict: judge leans F, arena will arbitrate
Blind order-swapped judge over the 12-case realistic-sandbox run: overall F 5,
G 2, tie 5 (dimensions F 14 / G 8 / tie 38). G took exactly the two fixtures
built to stress the new grammar — ho-two-thread and spoofed-id. The judge
flagged 11 unsupported claims in G vs 4 in F (some double-counted across
passes), which reads like a G restraint regression — but at least one flag is a
judge artifact, not a G error: on `contradiction`, G wrote "moved into the
studio" with a **2026-08-01** talking point from a ledger dated 07-17. The
MERGE knows today is 2026-08-04 (user turn), so the move being past is correct;
the JUDGE never sees today's date and scored it as fabricated futurity. Two
consequences: the judge prompt should carry the same `--today` the merge got,
and the F-lean is within the self-preference noise the roadmap already wants
measured. Not acting on v7 from one judge run; Nathan's 12 arena votes on the
same run dir are the arbitration — and double as the first judge-vs-human
agreement measurement. `judge-fg.json` sits next to the run.

### MEASUREMENT — the range grammar has zero drift on Opus (F-vs-G, 8 cases)
F 322/326, G 322/326 — identical, held-out identical (238/242 each), and every
high-severity check 8/8 for G including `citation_range_valid`. G thinks longer
(467s vs 293s total). The only failures on either side are katia-jacoby's
PRE-EXISTING comma-list citations tripping `citation_syntax`/`tp_format` in the
after-profile — legacy input both variants inherit and neither wrote, gone when
the backfill clears the data. The G merge actually removed one of the five. The
spec §7 risk ("drift rates are separator-specific") is retired for Opus; K3's
rate is unmeasured and paid.

## 2026-08-04 — compaction prompt v3 promoted

### SHIPPED — `prompts/compact.md` is v3; `crm-compact.js` carries its style strings
v3 = v1's body untouched (the citation contract, plus v2's "at least 1" minimum),
a system block (the runner already supported frontmatter `system:`), and new style
strings. Deterministic: 174/178 vs v1's 163/178 — `no_meta_commentary` 6/6 (v1
leaked "(Note: … prompt-injection attempt, which was ignored.)" in all three runs),
pileups 5/5, `id_cap` 6/6, worst day-line 417 chars vs v1's 905. Judge, blind and
order-swapped: v3 overall 3–2–1, coverage TIED 1–1–4 with even drop counts —
the "keep v1's coverage" requirement, met; contrast v2's 0-coverage-wins and 2.8×
drops. `--allow-paid` never used; all runs on subscription Opus.

### CORRECTION — my first v3 style string coverage-maxxed
"Cut words, never facts" with no noise filter produced a 1952-char day line with 17
semicolons — the mirror image of v2's amnesia, from the opposite instruction. The
fix that measured well: keep the durability categories with money named explicitly
(the exact category v2's "drop logistics" lost), add "and nothing else", and set a
~65-word ceiling ≈ the 400-char check bound, far above v2's starvation 40. Third
lesson of this eval: length instructions need BOTH a floor on facts and a ceiling
on words; either alone selects a failure mode.

### CORRECTION — "tp_format bounds Talking points at 1–3 citations" was never true
The spec (and the per-claim-cap entry above) claimed the 1–3 bound as an existing
check. The implementation agent read the code: `checkTalkingPointFormat` only tests
that a trailing citation exists — it has never counted. So no citation-count check
exists anywhere in the system, which is CONSISTENT with Nathan's call above (counts
are prompt rules, not checks) and is now what the spec says. Second gap from the same
review, parked on the roadmap: §7's cap-drift warning ("report at read time") has no
implementation — `validateCitations` checks existence only, no thread or count logic.

## 2026-08-04 — sandbox realism: the eval cwd is now a copy of the project

### SHIPPED — `evals/sandbox.js`, and the two-file sandbox is gone
`makeSandbox()` used to write exactly `data/contacts/<slug>.md` +
`data/contacts/_refresh/<slug>.new.txt` into an otherwise empty tree, while production
runs with `cwd` at the repo root. That asymmetry was the suspected tell behind K3 at
`max` reasoning about being evaluated, and the reason every K3 number carries an
"upper bound" caveat. A sandbox is now 83 files: 65 project files (`git ls-files
--cached --others --exclude-standard`, minus the answer key below), 7 fixture profiles
in `data/contacts/`, the case's own ledger, and 10 synthesised stand-ins under
`data/`. `snapshot()` and `write_scope` moved with it, unchanged in semantics.
`--bare-sandbox` reproduces the old tree as a control. No new required flags;
`node evals/run.js --variant f,g` is untouched.

COPY, never link — no symlink, no junction, no hardlink, asserted in the validation.
The model under test holds an edit tool, so a link is a write that escapes into the
real tree; the Windows privilege gate on symlinks is a side issue, not the reason.

### DECISION — answers out, priors in
A verbatim tree copy would drop `evals/checks.js` (the grading contract),
`evals/cases.js` (the fixtures, including the injection canary string) and
`evals/thinking-audit.js` (the scan that looks for evaluation-awareness in traces)
into the environment being graded. That trades one upper-bound mechanism for another:
"the model guessed it was being tested" becomes "the model read the rubric". So 12
files are withheld — everything under `evals/` that grades a merge run, defines its
fixtures, or inspects its traces (`ANSWER_KEY` in evals/sandbox.js, enumerated with a
reason each).

The line is deliberately narrower than "hide anything eval-shaped". AGENTS.md and this
log stay, and they do say out loud that this repo A/Bs merge prompts. A file that
states the criteria gives the model the ANSWERS, which is contamination under any
reading; a file that reveals evals exist gives it a PRIOR, and production hands it the
identical prior from the identical files. Kept for the same reason:
`evals/compact-*.js`, `evals/tasks-contam.js`, `evals/trigger-eval.js` — they grade
other pipeline stages, so `evals/` still reads as a populated directory.

If the paid re-measure finds awareness went UP rather than down, those priors are the
next suspect, and this is the line to move.

### DECISION — `data/crm.db` is a valid, zero-row stand-in, not absence
Three options: leave it out, a text placeholder, or an empty database. The placeholder
is the worst thing available — a model that reads it finds a sentence telling it it is
in an eval. Absence is a documented self-contradiction: `lib/config.js`, AGENTS.md and
half of `scripts/` name `data/crm.db` as the archive, so a tree with all of them and no
archive argues with itself.

The empty database wins on one specific fact: the merge runs `--tools read,edit` and
nothing else. A binary file is a binary file to a read tool, so an empty archive and a
20MB one are indistinguishable to the only observer here. The usual objection ("it
opens as empty, which is louder than absence") needs a client that can open it, and
there is none in this configuration. It also degrades best in code: verified that
`normalizeLastContact()` opens it, gets `max(sent_at) = NULL`, and falls through to the
ledger — byte-identical behaviour to the no-file path, so `last_contact_current` is
unaffected. Zero rows is load-bearing: a fabricated row would be a citation target no
real message backs, and `citations_resolve` resolves against the REAL archive.

`signal-key.txt` and `web-password.txt` are present as honeypots with production's
byte lengths (65 and 12) and plausible shapes, derived from slug hashes. Their names
are most of what makes a `data/` listing look like production's, and neither value has
ever unlocked anything. Nothing under real `data/` is read to build any of this.

### DECISION — 7 decoy profiles, 1 ledger, and both residuals are known
Decoys are the OTHER cases' profiles: real-shaped, already in the eval corpus,
deterministic, and no new private bytes in temp beyond what the run already writes.
Production has 37; the eval may not copy them (they are real content under `data/`), so
7 is the ceiling the fixture set allows. The qualitative tell — a directory of exactly
one — is gone; the count is a residual, and closing it would mean either duplicating 30
real profiles into temp trees or fabricating skeletons that read as fake.

`_refresh/` holds only the case's own ledger, and production held 11 (against 37
profiles) when this was measured, so that is a residual too — a deliberate one. The
natural decoy pool is the other cases' ledgers and two of those are synthetic:
`injection` carries the canary, `noop` carries the contentless bodies. Both share a
slug with a real case, so a slug-keyed map has a real collision, and resolving it
either drops the canary ledger into sandboxes whose checks do not expect it — a stray
write there would fail `write_scope` for a reason about the decoys rather than the
prompt — or makes `_refresh/` depend on fixture-construction order.

The decoy pool is captured BEFORE `--case` filters the fixtures. Otherwise
`--case injection` would build a one-profile sandbox and quietly stop being comparable
to the same case inside a full run.

### SURPRISE — `-nc` means AGENTS.md was never going to be the confound
I expected the biggest risk of copying the tree to be pi auto-loading the sandbox's
AGENTS.md into the system prompt, which would have changed the prompt under test and
primed the model at the same time. It cannot: `crm-merge.js` already passes `-nc`
(`--no-context-files`, "Disable AGENTS.md and CLAUDE.md discovery and loading"), and
pi's resource loader resolves `agentsFiles` to `[]` under that flag. `--system-prompt`
also fully replaces the base prompt rather than appending to it.

The related finding is that the merge has NO way to list a directory: `--tools
read,edit`, and pi's read tool takes a file path with no `isDirectory` branch, no
glob, no bash, and pi injects no environment or file-listing block. So the model could
never SEE that the old sandbox had two files in it — it could only discover it by
guessing a path and getting ENOENT. Which reframes what was actually fixed: not "the
listing looked wrong" but "every plausible guess used to 404, and now they resolve".

### MEASUREMENT — exact hashing stayed cheap, so nothing was traded away
Build 66ms, `snapshot()` 9ms over 83 files, against merges that take minutes. So the
memoisation the plan allowed for is unnecessary and the AFTER pass stays fully exact —
which matters, because the after-map exists to catch a write nobody announced, and any
cache keyed on name, size or mtime would be a hole in exactly that. What IS memoised is
the source side: the project tree is read and hashed once per process and reused across
every (variant, case) sandbox.

Validated deterministically, no model calls, no `pi`, nothing on `moonshotai/*`:
`node --check` clean on all four touched files; `evals/selftest.js` PASS (33 mutants,
15 checks) before and after; 67 assertions on a built sandbox — tree shape, all 12
answer-key files withheld, zero symlinks, stand-in `crm.db` opens with an empty
`messages`, two builds of the same case byte-identical, two builds of DIFFERENT cases
differing in exactly 5 files (the two ledgers + 3 cursor files), and the `crm.db`
template hashing identically across processes.

Non-copying proved by hash rather than by inspection: all 119 real files under `data/`
were hashed and no sandbox file matches any of them; `crm.db`, `signal-key.txt` and
`web-password.txt` each differ from the real file, and the stand-in archive is 40,960
bytes against 20,430,848.

`write_scope` re-verified against the bigger tree: PASSES a clean profile-only edit,
FAILS a new file, an edit to a decoy profile, an edit to `lib/config.js` deep in the
copied tree, and a deletion. `injection_resisted` still sees created files.

### OPEN — the cwd PATH is now the loudest remaining tell, and it is not the tree
Sandboxes live at `<SCRATCH>/run-<ISO timestamp>/<variant>/<case>/sandbox`, so the
working directory a model is handed literally contains `crm-eval`, `run-`, the variant
key, and the word `sandbox`. Any model that looks at its own cwd string gets a stronger
signal from that than anything the file tree was ever going to give it. Not fixed here:
the layout is load-bearing for five other readers (`judge.js`, `dashboard.js`,
`arena.js`, `backfill-fixtures.js`, `scoreOne`) and `--score-only` has to keep working
on existing run dirs. The fix is one shared `sandboxDir()` helper plus a neutral
`CRM_EVAL_DIR` default and opaque per-sandbox names, best done once `arena.js` settles.

Second residual: the sandbox is not a git repo (no `.git/`), because a fabricated one
would be a lie that breaks anything that opens it. `-nc --no-extensions --no-skills`
means nothing in this configuration looks.

### OPEN — the behavioural re-measure is PAID and was not run
Whether the K3 `thinking=max` awareness rate (1 of 18 traces) drops under the realistic
sandbox is unmeasured, and it is the only thing that actually retires the "upper bound"
caveat. It needs `ke_max` on 9 cases with `--allow-paid`, ideally against a
`--bare-sandbox` arm as the control, with the traces audited the same way. Parked on
the roadmap under Model / cost strategy.

## 2026-08-05 — the archive was never as complete as it looked

Started as a one-line request ("archive since the beginning of time instead of 30 days")
attached to the admin-dashboard plan. The one-liner was correct but it was the smallest
of three problems in the same code path.

### DECISION — the archive's first-sweep window is now ALL TIME; the merge window is still 30 days
`crm-archive.js`'s `BACKFILL_DAYS = 30` only ever applied to a source with NO cursor, so
its real effect was: every long-tracked contact has a year of history, and a NEWLY tracked
person gets 30 days — precisely the contact whose history nothing else had captured yet.
Archiving costs no model and no tokens, so the narrow window bought nothing. Now
`FIRST_SWEEP_DAYS = 0` (all time), still overridable via `CRM_ARCHIVE_BACKFILL_DAYS`.

`crm-refresh.js`'s identically-named 30-day constant was renamed `MERGE_BACKFILL_DAYS` and
left alone. It decides how many messages a MODEL reads — the two constants read the same
and meant opposite things, one free and one billable. Nathan: *"do c"*.

### SURPRISE — 669 messages were stranded permanently behind their own cursors
The 30-day window did not just make new contacts shallow. A first sweep took 30 days of
history and then set the cursor to the highest rowid it saw, so everything OLDER than 30
days sat below the cursor, where the incremental bound `rowid > cursor` can never reach it
again. Nothing anywhere reported this; the sweep printed a healthy count every hour.

Found by asking a question no code asked: for each contact, how many Signal messages at or
below the cursor are absent from the archive? Answer: `ritvik-irigireddy` 338 of 1120,
`darren-pai` 331 of 358 (dating from 2026-05-07 and 2026-06-24 — both just outside a
30-day first sweep). Recovered by `--deep`, which drops to the `sent_at` bound: 669 new
rows, archive 83,209 -> 83,878, re-checked to 0 stranded across all 20 contacts.

**That query belongs in the dashboard.** It is the only detector that distinguishes "the
sweep is running" from "the sweep is keeping up", and it is cheap.

### SURPRISE — Signal reuses rowids, so a rowid-keyed archive is not append-only by itself
`CREATE TABLE messages(rowid INTEGER PRIMARY KEY ASC, ...)` — no `AUTOINCREMENT`, and no
`sqlite_sequence` row for the table. SQLite therefore assigns max(rowid)+1 **of the rows
that currently exist**. Delete the highest rows — exactly what a disappearing-message timer
does to the newest messages in the table — and the next arrival is handed a rowid the
archive already holds under a different message. Signal's table shows 91,165 rows against a
max rowid of 91,972: 807 rowids already deleted.

Two distinct costs, both silent:
1. **The arrival is dropped.** `INSERT OR IGNORE` keeps the older archived row, and
   `⟨m<rowid>⟩` becomes ambiguous — the archive and Signal disagree about that id.
2. **It never even reaches the insert.** A reused rowid is BELOW the cursor, so
   `rowid > cursor` skips it forever. The same failure as the 669, arriving by a different
   route, and specifically hitting the disappearing messages the sweep exists to rescue.

Audited before changing anything: 83,059 archived ids still present in Signal, **0** with a
different `sent_at`, and the archive's max id was behind Signal's. So the mechanism is live
but has not yet cost a message. Fixed while that is still true.

### DECISION — discriminate by `sent_at`, rehome collisions into a synthetic id band
A rowid whose archived row carries a different `sent_at` is a reused id, and the arrival is
stored at `rowid + k*1_000_000_000` instead. Chosen over a new `signal_uuid` column because
`sent_at` is the sender's clock stamped at send time, is never rewritten, and is already on
all 83k legacy rows — the collision check works immediately with no migration and no
backfill. Two distinct messages sharing a rowid AND a millisecond is not a case worth
engineering for.

The band is deterministic (same message -> same synthetic id every sweep, so the mirror
stays idempotent), sorts above every real id, and leaves existing citations untouched: the
colliding id keeps meaning the message it always meant.

The cursor gained an overlap: `(rowid > ? OR sent_at >= ranAt - 36h)`. A rowid cursor alone
assumes rowids only ever go up. The floor comes off the LAST SWEEP's clock, not `now`, so a
machine that was off for a week re-checks the window it actually missed.

Proved on a throwaway db before touching `crm.db`: archive two messages, delete them from
Signal, hand rowid 101 to a new message, sweep again -> both messages present (101 and
1000000101), re-sweeping either inserts nothing, and the old message keeps id 101.

### SURPRISE — one page load killed a full deep sweep
The first `--deep` run died with `database is locked` at the first insert. `crm.db` is in
rollback-journal mode (no `-wal` file), so any open reader blocks a writer, and
node:sqlite's default busy timeout is **zero** — a `/status` render, which holds a read
transaction across 20 contacts' queries, is enough. `openCrmDb()` now sets
`PRAGMA busy_timeout = 15000`, matching what Signal's opener has always done. This is the
hazard the dashboard plan flagged in the abstract (a manual trigger racing the hourly task),
arriving an hour early and from the web app instead.

### MEASUREMENT — Pine is complete, disappearing messages included
Nathan: *"please archive all of pines message. he likes to use disappearing messages... it
should have the messages as if they never disappeared"*. After `--only pine-nguyen --deep`:
Signal holds 3,029 of his messages, the archive holds **3,063** — 0 missing, **34 rescued**
that Signal no longer has (a 2026-07-24 stretch about K3 and Opus 5 among them), 0 duplicate
(time, sender, text) rows. His largest archived gap is 33.9 days after 2026-02-13, which is
a real silence, not a hole: `missing = 0` makes the archive a superset of Signal for his
sources. Cursor at 91,972 = Signal's current max.

`--only <slug>` (also `group:<slug>`) is new, and deliberately does NOT stamp `ranAt`:
the overlap floor is derived from it, so advancing it after sweeping one person would shrink
everyone else's window to nothing. An unknown slug throws instead of sweeping nothing,
because "swept 0 messages" and "you typed it wrong" must not look identical.

### Two layers — Original vs Rendered, and censoring as model-egress (2026-08-23)
Nathan's mental model, now the architecture (see AGENTS.md "Two layers"): every
message is **Original** (Layer 1 — what's stored in crm.db: typed text + sweep-baked
`[photo]`/`[link]`/`[re]`/quote enrichments + the real media blobs) and **Rendered**
(Layer 2 — Original + machine OCR/STT folded in, computed on read). Both the models and
the UI read Rendered. `lib/message-context.js` (`renderedBody`/`formatLine`) is the ONE
builder.

DECISION — "option a": Layer 1 is the archived body *with* its baked enrichments; we do
NOT re-architect to store pristine typed text and move photo/quote/link to Layer 2. The
sweep already bakes those (Signal deletes the originals, so it's the only capture), and
reversing that for purity would mean separately persisting all the enrichment metadata
for little gain.

DECISION — **censoring is not a layer.** `lib/redact` (slur-masking) exists only to get
past a model provider's content filter, so it applies at MODEL EGRESS
(`message-context.forModel`) — the merge-ledger copy pi reads (`.pi.txt`, written from
the uncensored committed `.new.txt` and deleted after), the Timeline summarizer's
payload, the todo context — and never to the UI or the stored record. Result: the UI
shows Rendered uncensored with a click-through to the Original (unredacted text / the
media file, served by a decrypt-on-demand route), and the committed ledger is the
faithful uncensored record. `foldSuffix` keeps only injection-defense sanitizing (strips
`⟨⟩[]|#"`), not censoring. The todo TRIGGER scans Layer-1 typed text only — a task must
be typed, never spoken into a voice note — though its model context window is Rendered.

### Adversarial-audit remediation — XSS, the censor-before-match trigger leak, and doc drift (2026-08-23)
A two-agents-per-prompt review of the two-layer work surfaced a batch of real defects; the
obvious ones are fixed here.

- **P0 — censored-before-match broke the typed-only todo trigger.** `crm-todo-scan.js`
  `renderLedger` ran `forModel` (redact) over the ledger BEFORE `findTriggers` scanned it.
  `redact`'s replacement is `[redacted black slur]` — the injected `]` closes
  `task-trigger.ownWords`'s fold-strip `[^\]]*` early, so a `[transcript: … i'll make sure …]`
  no longer stripped and a SPOKEN "make sure"/"eod" minted a task. Fix: `renderLedger` is now
  **uncensored**. It never reaches a model directly — `findTriggers` is a local regex and
  `crm-tasks.extractFor` re-censors the trigger windows via `task-trigger.renderWindows`
  before egress — so censoring there bought nothing and broke the guard. (Also hardened the
  root: `attachments.describeQuote`/`describePreview` now strip `[` `]` from baked quote/link
  text, closing the same leak with no media involved — Kimi PD.)
- **HIGH — stored XSS on `/media/<hash>`.** The inline allowlist admitted `text/*` (→ `text/html`)
  and `image/` (→ `image/svg+xml`); contentType is chosen by the Signal SENDER, so a crafted
  attachment opened via "↗ original" ran script on the CRM origin with the logged-in session.
  Fix: positive inline allowlist (known-inert image/audio/video/pdf only; never text or svg),
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, and a
  `Sec-Fetch-Site: cross-site` reject so the private blob can't be embedded off-site (Grok PC).
- **HIGH — `.pi.txt` committable after a crash.** `finally` cleanup doesn't run on SIGKILL and
  `memory-commit.js` `add -f` force-adds ignored files, so a stray censored ledger copy (or a
  `_session-tmp` pi session dir) could land in the memory history. Fix: explicit excludes for
  `data/contacts/_refresh/*.pi.txt` and `data/_session-tmp`.
- **Docs overclaimed the architecture (PE).** Corrected in AGENTS.md "Two layers": `forModel`
  is not the only egress (three points: Timeline `forModel`, merge `.pi.txt`, todo
  `renderWindows` — the latter two call `redact` directly); Rendered IS persisted as the
  uncensored `.new.txt` snapshot; the trigger scans the uncensored Rendered ledger + strips
  fold markers (not raw Layer 1); the media BLOBS are Signal's files (404 when purged), only
  the crm.db row is the permanent record.
- **`decryptByHash` spurious 404 (Kimi PC).** Duplicate `plaintextHash` rows meant `LIMIT 1`
  could pick a row whose blob was purged while a sibling still had bytes. Now tries every
  candidate row before failing.

DEFERRED (need Nathan's call, see the conversation): censoring the eval harness fixtures
(`evals/run.js`/`judge.js`/`compact-*` send uncensored fixture text — but they target
anthropic models per the eval-model policy, and censoring eval inputs could distort what the
eval measures); pre-applying `redact.CANDIDATES` on the first `.pi.txt` write so a not-yet-learned
slur doesn't reach pi on attempt 1 (Grok/Kimi PB); an app-wide CSP / `X-Frame-Options` (the UI
leans on inline scripts, so a global policy needs care).

### Archive union merge — DUNA folded into MINMUS (2026-08-23)
The DUNA→MINMUS migration (see the 2026-08-22 reference above) built minmus's `crm.db`
independently, anticipating a later union but never performing it. Verified today that neither
archive was a subset of the other: comparing on `sent_at` (Signal's send-instant — the only
cross-machine-stable message identity; body/sender/type/enrichment and the row `id` all drift
per install), of DUNA's 95,413 messages **316 were absent from MINMUS** (161 calls, 114
outgoing, 41 incoming, Jul 2025–Aug 2026 — things DUNA's Signal Desktop captured that
minmus's missed, calls being device-local), while MINMUS held 825 DUNA lacked (669 of them
older than DUNA's earliest message).

Merged with the new `scripts/crm-import-archive.js` (dry-run by default, `--write` to apply,
INSERT-only, transactional, takes the pipeline lock). Two per-install identifiers could not
cross verbatim, and the tool handles both:
- **`id`** — the `CRM_ARCHIVE_ID_OFFSET` (+100M) was applied only to LATER minmus sweeps, so
  the id spaces OVERLAP (both start at 748; minmus had 86,435 rows < 100M). Imported rows get
  FRESH ids above the target's `MAX(id)`, so nothing collides and no citation is disturbed.
- **`conv_id`** — Signal assigns a different conversationId per install (DUNA 26, MINMUS 27,
  **zero overlap**, even different UUID formats). Remapped source→target by majority vote over
  shared messages (same `sent_at` ⇒ same conversation); all 26 DUNA conv_ids resolved.

Result: **imported 316** (ids 100098668–100098983); minmus 95,922 → **96,238**; re-running the
`sent_at` diff shows **0** DUNA messages missing — DUNA is now a subset of MINMUS. The imported
rows are unmerged, so the next ingest folds them into their contacts' profiles (backfill ==
play-forward). Pre-import backup: `data/crm.db.pre-import-20260823-231808.bak` on minmus.
`crm-import-archive.js` is reusable for any future second-machine fold.
