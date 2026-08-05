# Provenance ranges — spec

**Status: built 2026-08-04.** Every §6 site is implemented and `prompts/merge-v7.md` is
production `merge.md`. This document stays as the reference for the grammar and the
V1–V7 validity rules; the implementation notes are in `docs/ENGINEERING-LOG.md` under
the same date. It replaces the single-id citation grammar with a thread-scoped range,
and it had to land *before* the full backfill — the backfill rewrites every profile,
and running 98 chunks under the old grammar means running them twice.

Decided with Nathan 2026-08-04. Rationale and closed alternatives are in
`docs/ENGINEERING-LOG.md` under the same date.

---

## 1. Grammar

Legal **only** in `## What I know` and `## Talking points` inside
`data/contacts/<slug>.md`. Ledger lines, `## Timeline` lines and `## Open questions`
are unchanged — see §5.

```
citation := "⟨" range [ " @" id ] "⟩"
range    := id "-" id            ; start-end, ASCII hyphen, no spaces
          | id                   ; degenerate range, start = end
id       := "m" 1*DIGIT
```

Worked examples:

```
- **Travel:** Flying to Seattle Aug 14–15 ⟨m90211-m90219 @m90215⟩.
- **Travel:** Flying to Seattle Aug 14–15 ⟨m90211-m90219⟩.
- **Work:** Started at Latch.bio June 1 ⟨m88104⟩.
- **Personality:** Dry humour, mostly about work ⟨m88104-m88110⟩ ⟨m89540-m89547⟩ ⟨m90211-m90219⟩.
```

`@m90215` is the **primary message** — the one line the claim rests on. Optional. It
exists so a checkable fact stays exactly verifiable while still handing the reader the
surrounding exchange. A range with no primary asserts only "this claim comes out of
this stretch," which is the honest shape for characterisation prose.

**Why a single token and not two adjacent citations.** `⟨m90215⟩⟨m90211-m90219⟩` would
work — the web renderer already coalesces adjacent brackets — and needs no new
separator. Rejected: the relationship between the two would be implicit (containment),
so the eval could not tell an intended primary from an id that coincidentally falls
inside a neighbouring range, and the renderer would not know which message to
highlight. One token gives both for free.

**Why `@` and not `,`.** Comma is now free (it used to separate an id list, and lists
are gone — §2), but recycling it with a new meaning is a footgun: this repo's git
history, `prompts/merge.md`, and five `MALFORMED` patterns in `evals/checks.js` all
carry the old meaning.

## 2. What replaces id lists

`⟨m89166, m89167⟩` is no longer legal. Two adjacent messages are a two-message range:
`⟨m89166-m89167⟩`.

A claim resting on genuinely separate moments carries **separate citations, max 3 per
claim** — not one wide range, which would assert everything between them. Three
citations at ≤10 messages each caps any single claim at 30 backing messages.

There is **no per-bullet cap**. `## What I know` bullets are cited per claim and hold
five or six facts each, so a normal steady-state bullet legitimately carries five or
six citations — and any bullet-level bound loose enough to allow that is too loose to
catch anything real. The per-claim cap is a prompt rule, not a check: nothing marks
where one claim ends and the next begins inside a bullet, so there is no unit for a
check to count against (same shape as spread, §4). `## Talking points` has no
mechanical count either — `tp_format` checks that a trailing citation *exists*, not
how many there are (an earlier draft of this spec claimed a 1–3 bound; that was never
true of the code). The 1–3 there is a prompt rule, like the per-claim cap.

## 3. Resolution

`thread(id)` = the `conv_id` of that row in `data/crm.db` `messages`. The archive is
the authority, not Signal's DB (`lib/archive.js:4-6`).

```sql
SELECT * FROM messages
 WHERE conv_id = thread(start) AND id BETWEEN start AND end
 ORDER BY id
```

**Thread scoping is derived from the endpoints, not stored.** `m<id>` is Signal's
global `messages.rowid` — one insertion stream across every conversation — so an
unfiltered range scoops up unrelated chats. Measured across all eleven current
ledgers, a contact's own messages are **2–6% of their ledger's id span** in nine of
them (charles-wu 3%, liang-dai 2%, nigesh 2%); katia-jacoby's 68% is a burst week, not
the norm. Filtering by the endpoints' shared thread is what makes a range mean
anything.

Gaps inside a range are expected and are **not** errors: ids belonging to other
conversations, and ids absent from the archive, are simply not in the resolved set.

## 4. Validity — all mechanically checkable

| # | Rule |
|---|---|
| V1 | `start ≤ end` |
| V2 | both endpoints exist in the archive |
| V3 | `thread(start) == thread(end)` |
| V4 | resolved count ≤ **10** |
| V5 | if a primary is present, it is one of the resolved rows |
| V6 | citations on the same bullet do not overlap |
| V7 | for citations *new* in this merge, both endpoints and the primary appear literally in the ledger this merge was fed |

There is no per-bullet citation count in this table — the 3-citation cap is **per
claim** and prompt-only (§2).

**The per-claim cap is a cap, not first-three-wins.** A claim that has filled its three
citations must be able to drop its weakest for a better one, or the three earliest
citations lock forever and every later, stronger piece of evidence is discarded.
`## Talking points` already solves the identical problem the same way — "stay under the
cap by deletion, not by refusing to add" (`prompts/merge.md`).

**Rank by evidential strength, with a positional fallback.** Citations are ranked by how
much they actually back the claim — a passing mention loses to a real exchange. But the
model can only rank what it can read: the current chunk is in its context in full, while
an incumbent citation is just the token `⟨m88104-m88110⟩` and the ten messages behind it
are not. So strength governs selection *within* the chunk, and position governs eviction
*across* chunks.

*Choosing which stretch of the current chunk to cite* — strongest, not first. Signals
visible in a ledger:

- the exchange runs several messages rather than one line;
- both parties engage, rather than one person talking past the other;
- a quote-reply prefix (`[re Nathan: "…"]`) shows the other person took it up;
- most messages inside the range are on-topic, rather than the topic surfacing once in
  an otherwise unrelated ten-message window.

For a vague claim ("dry humour") the same signals pick *representative* stretches: the
exchanges where the trait is actually doing something, not the first ten messages that
happen to contain a joke.

*Deciding whether a candidate displaces an incumbent* — only when it is clearly stronger
than what the claim already carries. When the model cannot tell, which is the normal
case since it cannot read the incumbents, it keeps the earliest citation and the latest
and evicts from the middle. That preserves the citation which established a fact plus
its most recent confirmation, and preserves temporal spread for a trait, whose entire
evidentiary content is that the pattern recurs. The failure it prevents is all three
citations drifting into the last month as merges accumulate.

Neither ranking is enforceable — a check cannot see the candidate the model rejected,
and cannot read strength out of a range it can only count. Both are prompt rules.
`citation_carry_forward` already tolerates eviction, since it fails only when *every*
prior id vanishes while the section still has bullets, but the carry-forward paragraph
at `prompts/merge.md:71-77` textually forbids it ("do not silently drop provenance from
a claim that is still standing") and needs an explicit exception for the at-cap case.

**This is the first surviving case for giving the merge an archive read tool.** Ranking
a candidate against an incumbent is exactly the comparison the model cannot make today.
Deliberately not folded in — it costs the merge its purity as a function of profile +
ledger (`scripts/crm-merge.js:42`) and breaks the eval sandbox, which copies only those
two files. The positional fallback exists so the spec is implementable without it.

**V4 counts thread messages, not id arithmetic.** `end - start ≤ 10` is the wrong
check — at 2–6% density, `m90205-m90560` can hold as few as 8 of a contact's messages
despite spanning 356 ids.

**Spread is requested, not enforced.** Earlier in the design discussion I said the
check could require multi-range citations to fall in different weeks. That is wrong: a
plan mentioned Monday and confirmed Friday is one legitimate fact with two same-week
ranges. The prompt asks characterisation citations to spread across months; only V6
non-overlap is enforced.

**Validation in the eval sandbox.** V2–V5 need the archive, which the sandbox does not
copy (`scripts/crm-merge.js:100`). The ledger substitutes: every line carries its id
and its thread label (`(Nat & Kat 🥾🩷)`, or none for a DM), so filtering ledger lines
by thread label and counting those inside the range validates every citation V7
already requires to be in the ledger. Citations pointing outside the chunk are skipped,
exactly as `citations_resolve` skips today when `ctx.resolveIds` is absent.

## 5. Deliberately unchanged

- **Ledger lines.** `[2026-07-30 09:17] ⟨m90211⟩ (Nat & Kat 🥾🩷) Katia: …` — the
  `⟨m…⟩` there is a line label, not a citation. `lib/task-trigger.js:77` and
  `CHAT_RE` in `scripts/crm-web.js:~1112` parse it. **Do not widen either regex.**
- **`## Timeline`.** Single ids only, copied verbatim by `crm-compact.js`. Ranges add
  nothing to a one-line-per-week summary and would break the verbatim-copy contract.
- **`## Open questions`.** Uncited, enforced by `open_questions_uncited`.

## 6. Sites to change

| File | What |
|---|---|
| `evals/checks.js:18` | `CITE` / `CITE_ID` → the §1 grammar |
| `evals/checks.js:72` | `citationIds()` returns **endpoints and primary only**, never interiors — an interior id was never written by anyone, and counting it would make `no_invented_citations` and `citation_carry_forward` reason about ids the model did not emit |
| `evals/checks.js:23-29` | `MALFORMED` gains: en/em-dash separator, `..` separator (the commit-subject convention will tempt it), old comma list, reversed range, `⟨m90211-90219⟩` missing the second `m` |
| `evals/checks.js:187` | `tp_format` trailing-citation regex accepts a trailing run of range citations |
| `evals/checks.js` (new) | `citation_range_valid`, high severity — V1–V6, archive when present, ledger oracle otherwise |
| `lib/archive.js:13,71` | `CITE_RE` / `extractCitations` → same endpoints-and-primary rule. `validateCitations` keeps its shape; Timeline behaviour is unchanged because Timeline stays single-id |
| `scripts/crm-web.js:96` | one numbered link per citation (not per id), `href=/m/<start>-<end>` plus `#m<primary>` when present; keep the existing adjacent-group coalescing and per-line numbering |
| `scripts/crm-web.js` (new route) | `/m/<start>-<end>` span view — resolve the thread from `start`, render its messages in range, highlight the primary. Reuses the renderer `/m/<id>` already uses |
| `prompts/merge.md` | the grammar touches far more than the citation-rules paragraph — drafted in full as `prompts/merge-v7.md`. Sites: hard rule 4 at `:8` (a range token never appears "literally in the ledger"; only its endpoints and primary do), the `:40` citation rules (and its "characterisation stays uncited" sentence must be *inverted*, not extended), the `:42` and `:81-84` "source id(s)" phrasing, the worked examples at `:70`, `:102`, `:118` (they teach the old grammar — `⟨m89166⟩ ⟨m89167⟩` at `:70` is illegal under §2 — and examples beat rules), and the `:143-146` checklist |
| `prompts/merge.md:71-77` | **delete the "uncited legacy claims" paragraph.** It exists only because 157 pre-citation bullets cannot be repaired; a cleared archive means every bullet is born cited. This is the paragraph that made "every statement has a link" unreachable. The carry-forward paragraph above it gains the at-cap replacement exception (§4) |
| `evals/selftest.js:100` | range-form mutants: reversed range, over-cap range, cross-thread range, invented endpoint |

## 7. Known risks

- **Cap drift.** A later archive backfill that ingests more of a thread can push a
  compliant range over 10 messages. Report it at read time as a warning; do not
  retroactively fail the merge that wrote it. Near-zero once the backfill is a single
  clean pass.
- **Cross-thread endpoints.** Real risk only where a ledger mixes threads —
  liang-dai (9 thread flips, 2 threads) and arshia-nayebnazar (2 flips); the other
  nine ledgers are single-thread. V3 catches it.
- **Changing the syntax later is cheap in the files and expensive in the model.** A
  separator swap is a regex pass over 39 profiles — and at backfill time there is
  nothing to migrate at all, since the archive is cleared first. The cost is elsewhere:
  the six code/prompt sites express the grammar as escaped regex source, not as literal
  citations, so no find-and-replace covers them; and the eval fixtures, gold values and
  five `MALFORMED` near-miss patterns all encode the chosen separator. Drift rates are
  separator-specific, so knowing the model emits a new one as reliably as the old one
  means re-running the merge evals — free on Opus, but not instant.
- **Unenforceable laziness.** `Dry humour ⟨10 messages from one Tuesday⟩` is legal and
  no check can reject it, because nothing marks which bullets are characterisation.
  Accepted deliberately (§4): the 10-cap already blocks the worse failure of gesturing
  at 200 messages, and `evals/judge.js` still reads the prose.
