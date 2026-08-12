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
- `scripts/crm-compact.js` → `prompts/compact.md` (no tools, stdin)
- `scripts/crm-tasks.js` → `prompts/tasks.md` (no tools, stdin, JSON out → `tasks` table)

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
- **Compaction is recoverable.** It rewrites a profile's `## Timeline` to lower
  resolution; it never touches the archive. Backups in `data/_compact-backup/`.
- **Eval fixture contamination is real and tagged.** `prompts/past/merge-v5.md` embeds
  examples built from `arshia-nayebnazar` and `charles-wu` messages, which are also
  fixtures. `evals/cases.js` marks those `heldOut: false`. Read the held-out subtotal.
- **Deterministic merge checks are saturated** (312/312 for two different prompts).
  Ranking prompts now requires `evals/judge.js`.
- **Deterministic compaction checks reward brevity** and will pick the prompt that
  drops the most content. Use `evals/compact-judge.js`.

## Cost

`anthropic/*` models run on Nathan's Claude subscription — **$0 marginal**.
`moonshotai/*` bills per token. Eval runners **refuse** a paid model without
`--allow-paid`. Do not send paid requests without explicit approval.
