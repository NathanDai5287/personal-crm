# Media understanding — design (captioning + video, unified)

Status: **IN IMPLEMENTATION** (2026-09-04). `lib/media.js` (schema + fold) and
`lib/config.js` are done; the worker + sweep-enqueue are next. This extends the
existing OCR/STT pipeline so the merge model gets *context for every piece of media*,
not just the text inside it.

## Finalized decisions (2026-09-04)

- **Compositional model (Nathan's).** Two raw components — **visual** (a still frame)
  and **audio** (a sound track) — and two extractor families that reduce them to the
  ONE thing the merge model reads, **text**: a visual → **OCR** (verbatim text) +
  **caption** (VLM scene description); an audio → **STT** (transcript). Then:
  `photo = 1 visual → {ocr, caption}` · `audio = 1 audio → {stt}` ·
  `video = N frames (each a visual) + 1 audio → {per-frame ocr+caption} + {stt}`.
  So **video = photo×N + audio** — no special video model.
- **Schema:** `media_text (hash, kind, part)`, `kind ∈ {ocr, caption, stt}`, `part` =
  component index (0 = whole still/audio; 1..N = video frame). Migration of the
  pre-`part` table is done and tested (legacy rows → part 0). **DONE in lib/media.js.**
- **Caption model = moondream2, GGUF q8, on CPU via Ollama** (`CRM_CAPTION_MODEL`,
  default `moondream:1.8b-v2-q8_0`; `CRM_OLLAMA_URL`). Chosen over fp16 (a memory
  squeeze on minmus for negligible quality gain — the eval showed q4≈fp16) and over
  larger models (llava 7B won't fit; qwen2.5-vl is broken via Ollama and far too slow
  on minmus's CPU). Captioning is **always-on**, not an OCR fallback.
- **minmus feasibility:** q8 ≈ 2.8 GB file / ~3 GB resident, fits the ~8 GB available
  RAM and (after a disk cleanup — `/` is 91 % full) the 8 GB free disk. Caption vs STT
  are serialized (one heavy model resident at a time). Expect ~10–40 s/image on CPU;
  fine for the out-of-band, reniced, one-at-a-time worker.

### Decomposition & trigger contract (what enqueues what)

- The **sweep** (`crm-archive.enqueueMedia`) enqueues per attachment by content-type:
  - `image/*` → `ocr(part 0)` + `caption(part 0)`
  - `audio/*` → `stt(part 0)`
  - `video/*` → `stt(part 0)` + `caption(part 0)` — the `caption(0)` on a video is the
    **frame-expansion trigger**, not a whole-video caption.
- The **worker**, claiming `caption(part 0)` whose content-type is `video/*`, decrypts
  the video, samples frames (`CRM_VIDEO_FRAME_SEC`, capped at `CRM_VIDEO_MAX_FRAMES`),
  runs caption **and** OCR on each frame, writes `caption(part f)` / `ocr(part f)` rows
  (via `enqueue` then `setDone`/`setSkip`), and finally `setSkip`s the `caption(0)`
  trigger (`"expanded into N frames"`). Frame visual processing therefore requires the
  caption engine; `stt(0)` runs independently (a silent video → `skip 'no audio track'`,
  frames still carry the meaning).

### lib/media.js API (the contract the worker + sweep build against)

`ensureMediaTable(cdb)` · `enqueue(cdb, {hash, kind, contentType, part=0})` ·
`claimNext(cdb, kinds) -> {hash, kind, part, content_type} | null` ·
`setDone(cdb, key, text, engine)` · `setError(cdb, key, error, engine)` ·
`setSkip(cdb, key, reason)` — where **`key = {hash, kind, part}`** (the claim object) ·
`foldSuffix(cdb, hashesStr)` (unchanged signature; now renders photo/audio/video) ·
`requeueStale` · `requeueErrors` · `counts`.

---


## Principle

> The merge model should know the context of each piece of media — including a video
> with no audio or talking.

So captioning is **always-on, not a fallback.** OCR and a caption describe different
things and are complementary:
- OCR: the *text* in a screenshot / flyer / meme ("verbatim").
- Caption: what the image *is* ("a whiteboard covered in sprint tickets", "two people
  at a restaurant", "a golden retriever on a beach").

A text-only fallback would leave every text-bearing image with no scene context, and a
non-empty-OCR image uncaptioned. So: **run every applicable job for every media type.**

| Media | Jobs |
|-------|------|
| image | OCR **and** caption |
| audio (voice note) | STT |
| video | STT (audio track) **and** per-frame OCR + caption on sampled frames |

## Why YOLO is not the tool

Object detection (YOLO v9) returns bounding boxes + class labels ("person, cup,
laptop") — a bag of nouns, not a description. Useless as CRM context. We want an image
**captioning / small vision-language model (VLM)**. Recommended: **moondream2** (~1.8B,
built for local/edge, CPU-runnable, does captions *and* visual Q&A). Alternative:
BLIP-base (captioning only). This stays **on-device**, matching the whole media stack's
privacy posture (local tesseract + whisper.cpp; nothing leaves the box).

## What already exists (reuse it)

- `media_text` table in crm.db = **queue + result store**, keyed by attachment
  `plaintextHash`; `pending → processing → done/skip/error`. Identical files processed
  once. Persists across Signal resync.
- `crm-media-worker.js` — detached, reniced, singleton-locked, drains the queue one item
  at a time, idle-exits. Auto-detects engines; a missing engine leaves that kind pending.
- The archive **sweep** enqueues and fire-and-forgets the worker (runs on sweep, not
  ingest; merge only *reads* finished text at ledger time).
- `foldSuffix` folds finished text into the ledger/Timeline line, with **injection
  defense** (strips `⟨⟩[]|#"`) since media text is untrusted.

The architecture is already "async job with persistence." Captioning + video slot into
it. The two things that must change are the **schema** (one attachment now yields
several results) and the **engine-run model** (a 2B model must not reload per image).

## Schema change — one attachment → many results

Today `media_text` PK is `hash`, one `kind` per row. That breaks the moment an image
needs *both* OCR and a caption, and again when a video yields N frame results + a
transcript.

**Proposed:** composite PK `(hash, kind, part)`.

```sql
-- add:
part INTEGER NOT NULL DEFAULT 0     -- 0 = whole item (audio, still image); 1..N = video frame index
-- kind widens to: 'ocr' | 'stt' | 'caption'
-- PRIMARY KEY (hash, kind, part)
```

- Image: `(hash,'ocr',0)` + `(hash,'caption',0)`.
- Audio: `(hash,'stt',0)`.
- Video: `(hash,'stt',0)` + for each sampled frame f: `(hash,'ocr',f)` + `(hash,'caption',f)`.

**Migration is safe:** every existing row has a unique `hash` and one `kind`, so backfill
`part=0` and rebuild the table with the new PK; no row collides. (SQLite PK change = create
new table, copy, swap — one transaction.)

`claimNext` already claims per row → per unit of work, unchanged. `foldSuffix` changes
from "rows for this hash" to "rows for this hash, grouped and ordered by (kind, part)".

## Engine-run model — load the VLM once per drain

tesseract/whisper are `execFileSync` per item — fine, they're cheap to start. A 2B VLM
is **not**: loading ~2 GB of weights per image would dwarf inference. The worker already
drains the whole queue in one process, so:

**Option A (recommended):** a small persistent caption subprocess. When the worker has
caption work, it spawns one python (or llama.cpp) process that loads moondream **once**,
then the worker feeds it image paths over stdin and reads captions over stdout for the
rest of the drain; killed on drain end. Model loads once per drain, not once per image.

**Option B:** one batch invocation — hand the whole pending-caption set to a single
python call that loads once and emits all captions. Simpler, but less incremental (a
crash loses the batch's progress; the queue's per-row status is the mitigation).

Either keeps the "missing engine → stays pending" degradation: if the caption engine
isn't installed, caption rows never leave pending, exactly like STT before whisper.cpp.

Engine packaging: **moondream python package in a no-sudo venv** (like the original
faster-whisper approach), `CRM_CAPTION_PYTHON` + `CRM_CAPTION_MODEL`; or a GGUF via
llama.cpp if we want to avoid python. Availability probe mirrors `ocrOk`/`sttOk`.

## Video — sample, then treat frames as images

`ffmpeg` extracts frames; each frame is then an ordinary OCR + caption job.

- **Sampling:** one frame per **10 s** (your suggestion), `fps=1/10`, **capped** at
  `CRM_VIDEO_MAX_FRAMES` (default ~12) so a long video can't explode into hundreds of
  jobs. A very short clip still yields ≥1 frame (the midpoint).
- **Dedup static video:** a screen recording that barely changes would caption the same
  frame 12×. Drop near-identical frames with a perceptual hash (pHash) before enqueuing
  frame jobs — cheap, and it collapses a static screencast to 1–2 frames.
- **Audio:** the existing STT path runs on the same file; a silent video simply yields
  `skip('no audio track')` (just shipped) and the frames still carry the meaning — which
  is exactly the "video with no audio should still be understood" case.
- **Enqueue:** the sweep, seeing a video, enqueues `(hash,'stt',0)` now and defers frame
  jobs to the worker (the worker samples frames at claim time and enqueues
  `(hash,'ocr',f)`/`(hash,'caption',f)`), OR the sweep samples up front. Deferring keeps
  ffmpeg work off the sweep — **recommended.**

## Fold rendering (`foldSuffix`)

Aggregate a hash's rows into one compact suffix under the existing per-attachment cap:
- image → `[image: <caption>]` and, if OCR non-empty, `[image text: <ocr>]`
- audio → `[transcript: "<stt>"]` (unchanged)
- video → `[video: <stt transcript>; scenes: <caption f1> / <caption f2> / …]`,
  frame captions **de-duplicated** and truncated. A silent video →
  `[video: no audio; scenes: …]`.

All of it passes through `sanitizeFold` (caption text is untrusted too — a photo of text
could echo attacker-controlled content).

## Compute budget

minmus is CPU-only (i7-8565U). Expect **seconds to tens of seconds per image** for
moondream on CPU; video multiplies by frame count (hence the cap + dedup). This is fine
because the worker is out-of-band, reniced to the floor, one-at-a-time, and idle-exits —
it never blocks a sweep, a merge, or the web service. Backlog drains across hourly
sweeps or via `--enqueue-existing`.

## Rollout

1. Schema migration `(hash, kind, part)` + widen `kind` to include `caption`.
2. Caption engine + probe + persistent-subprocess run model (images only first).
3. `foldSuffix` multi-part aggregation.
4. Video sampling (frames → existing image jobs) + video fold.
5. Backfill: `--enqueue-existing` re-scans and enqueues the new job types for the
   existing corpus (~500 attachments).

## Open decisions (for Nathan)

1. **Engine packaging:** moondream via python venv (least friction) vs. GGUF via
   llama.cpp (no python, consistent with whisper.cpp)?
2. **Run model:** persistent caption subprocess (A) vs. batch invocation (B)?
3. **Video frame cadence + cap:** 1/10 s and max ~12 frames — good defaults, or different?
4. **Video-caption backlog cost:** OK to let ~500 existing attachments (some video)
   re-drain over the coming sweeps, or gate the video backfill behind a manual flag?
