# personal-crm

A private, self-hosted CRM for your own relationships. It reads your **Signal
Desktop** message history, and for each person keeps a living markdown profile —
what you know about them, things to talk about next time, open questions, and a
Timeline of your conversation — written and maintained by an LLM. You
browse it all in a local web dashboard.

Nothing leaves your machine except the model calls, and even those you control
(see [Models & cost](#models--cost)). The message archive, the profiles, and the
keys all live in a git-ignored `data/` directory that is **never** pushed.

---

## What it actually does

- **Archives** new Signal messages into an append-only local database
  (`data/crm.db`) — including disappearing messages, captured before they vanish.
  This archive is the record of truth and is never deleted.
- **Ingests** each person's new messages through an LLM that folds them into a
  prose profile: `## What I know`, `## Talking points`, `## Open questions`.
  Every claim is cited back to the message id it came from.
- **Builds a `## Timeline`** of the raw conversation at decreasing resolution
  (recent raw → daily → weekly → older) — the second half of ingest — so a
  profile stays readable as history grows without losing the shape of the
  relationship.
- **Captures commitments**: when you say something like "make sure to send Ken
  the deck," it extracts that into a todo with a deadline.
- **Serves** the whole thing at `http://localhost:8787` — a dashboard with a
  profile per contact, a pipeline view of the jobs, and a todo list.

Everything except the three LLM steps is plain, deterministic code.

---

## How the pipeline fits together

```
Signal Desktop DB
      │  crm-archive.js  (SWEEP — no model)
      ▼
  data/crm.db  ── append-only archive of record (never deleted; keeps messages
      │            Signal itself has since purged)
      │
      ├─ crm-refresh.js → crm-merge.js   (INGEST · MERGE — model)
      │      reads new messages, writes the PROSE:
      │      ## What I know · ## Talking points · ## Open questions
      │      (never touches ## Timeline)
      │
      └─ crm-timeline.js                 (INGEST · TIMELINE — model)
             builds & maintains the CHRONOLOGY:
             ## Timeline (recent raw → daily → weekly → older)
```

Merge and Timeline are the **two halves** of ingest — independent passes that
write different parts of the same profile. Full detail on every script is in [`docs/SCRIPTS.md`](docs/SCRIPTS.md);
architecture and design decisions are in
[`docs/ENGINEERING-LOG.md`](docs/ENGINEERING-LOG.md).

---

## Requirements

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; developed on Node 24).
  No `npm install` step — there are no runtime dependencies. SQLCipher for the
  encrypted Signal DB is vendored under `vendor/sqlcipher/`.
- **Signal Desktop**, installed and synced on this machine.
- **[`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** — the
  coding-agent CLI that actually runs the model, installed globally and
  authenticated with your model provider (via `pi`'s `/login` or provider API
  keys in the environment). Only needed for the model steps; sweeps and the
  dashboard don't use it.

---

## Setup

1. **Clone** the repo.

2. **Configure paths.** Copy the template and edit it for your machine:
   ```
   cp .env.example .env
   ```
   Set at minimum `CRM_SIGNAL_DB` (your Signal DB location) and `CRM_PI_CLI`
   (your `pi` install). The file documents where each lives on Windows / macOS /
   Linux. `.env` is git-ignored; a real environment variable overrides it.

3. **Provide the Signal key.** The pipeline opens Signal's encrypted DB with a
   cipher key.
   - **Windows:** it can rederive the key automatically from Signal's own config
     (via DPAPI) — nothing to do, as long as Signal is installed for your user.
   - **All platforms / fallback:** put the known key in `data/signal-key.txt`
     (one line of hex). On macOS/Linux this is required, since the automatic
     rederivation is Windows-only.

4. **Start the dashboard:**
   ```
   node scripts/crm-web.js
   ```
   Then open `http://localhost:8787`. It's behind HTTP basic auth (user `natha`
   by default, override with `CRM_WEB_USER`). The password comes from
   `CRM_WEB_PASSWORD`, else `data/web-password.txt`; if neither exists, a random
   one is generated and printed once on startup.

---

## Usage

Run every script from the repo root as `node scripts/<name>.js`. The common ones:

| Command | What it does | Model? |
|---|---|---|
| `node scripts/crm-web.js` | Start the dashboard | no |
| `node scripts/crm-archive.js` | Sweep new Signal messages into `crm.db` | no |
| `node scripts/crm-daily.js --only <slug>` | Ingest one contact (merge + timeline) | yes |
| `node scripts/crm-daily.js` | Full run: ingest everyone (merge + timeline) | yes |
| `node scripts/crm-todo-scan.js --write` | Scan for "make sure …" commitments | only on a match |
| `node scripts/crm-backup.js` | Snapshot `crm.db` outside the repo | no |

Most model scripts are **dry-run unless `--write`**. The full reference —
every flag, every job, the dashboard's pipeline buttons — is in
[`docs/SCRIPTS.md`](docs/SCRIPTS.md).

---

## Models

The merge, Timeline, and todo steps each pick a model independently. Any provider
`pi` supports works — e.g. `anthropic/claude-opus-5` or `moonshotai/kimi-k3`
(the default) — so point each step at whatever you have access to. Override per
run without editing code:
```
CRM_MERGE_MODEL=anthropic/claude-opus-5 node scripts/crm-daily.js --only <slug>
```
Provider API keys (e.g. `ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`) go in the
environment; any billing is between you and the provider.

---

## Scheduling (Windows)

PowerShell registrars in `tools/` install Task Scheduler jobs (hourly sweep,
nightly deep sweep, optional weekly AI run). See the table at the bottom of
[`docs/SCRIPTS.md`](docs/SCRIPTS.md). On macOS/Linux, wire the same commands into
`launchd`/`cron` yourself.

---

## Platform notes

Developed and run on **Windows**. The core — the dashboard, the archive, all the
date logic, the merge/timeline/eval scripts — is portable Node and runs anywhere.
Three things are Windows-specific:

1. **Signal key rederivation** (`lib/signal-key.js`) uses Windows DPAPI. On
   macOS/Linux, seed `data/signal-key.txt` instead (Signal's DB format itself is
   cross-platform).
2. **The vendored SQLCipher** ships only a `win32-x64` prebuild. On another
   platform, run `npm install @signalapp/sqlcipher` to fetch the matching
   prebuild (or point the require at it).
3. **Toast notifications and the schedulers** shell out to PowerShell; they fail
   silently / need `launchd`/`cron` equivalents elsewhere.

---

## Privacy

This app processes **your private messages**. Treat the repo accordingly:

- `data/` — the archive, profiles, the web password, and the Signal key — is
  git-ignored and has its own local-only history (`.memory-history.git`). It is
  never pushed to the GitHub remote. Keep it that way.
- The only data that leaves the machine is what you send to the model provider,
  and only during the merge/Timeline/todo steps. Choose the provider accordingly.

---

## Repo layout

```
scripts/   runnable jobs (archive, daily, merge, timeline, web, backup, …)
lib/       shared modules (config, env, DB openers, Signal key, tasks, views)
prompts/   the three LLM prompts (merge, compact, tasks-trigger) + past/ versions
evals/     prompt evaluation harness (deterministic checks + LLM judge)
tools/     Windows Task Scheduler registrars
docs/      SCRIPTS.md, ENGINEERING-LOG.md, ROADMAP.md, PROVENANCE-SPEC.md
vendor/    vendored @signalapp/sqlcipher
data/      (git-ignored) archive, profiles, keys — never committed
```
