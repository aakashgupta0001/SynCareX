# Evaluation harness: accuracy and low-end performance

PS04 asks for "offline usability, extraction accuracy ... and performance on
resource-constrained devices". This directory is the machinery for the
accuracy half and the repeatable half of the performance half. Nothing in
here claims a number that was not actually measured.

## 1. Golden set

`python -m ai_engine.evals.generate_golden` fills `golden/`:

- **Speech (30 manifest rows):** 24 English dictations synthesized with the
  Windows SAPI voices, 6 Hindi dictations marked `record-manually` — stock
  Windows has no Hindi TTS voice, so those six need one recording session on
  a phone (quiet room, ~10 s each) before the Hindi WER column is real.
- **Printed documents (15):** rendered with Pillow, exact reference text, so
  CER is measured against ground truth. Devanagari rows use the system's
  Nirmala/Mangal font. Handwriting is deliberately absent — the pitch says
  printed reports are supported and handwriting is experimental; adding
  handwritten samples is future work, not a silent hole.
- **Extraction (5 fact rows):** expected facts per source, scored with
  precision/recall.

The set is small and synthetic. It catches regressions and produces a defensible
table; it does NOT certify real-world accuracy — say "validated on a synthetic
golden set of N items" in the pitch, never "validated on Hindi".

## 2. Metrics

`metrics.py` (pure functions, unit-tested): WER for speech, CER for OCR
(whitespace ignored), fact precision/recall matched on (category, normalized
value) with duplicates counted once.

## 3. Running

```
python -m ai_engine.evals.run_evals --task all
```

Requires the same runtimes as the engine itself (whisper.cpp, Tesseract,
Poppler, llama.cpp + the Qwen model). Anything missing produces a `skipped`
row **with the reason** — the harness never fills a gap with a fabricated
number. The tables print to stdout, ready to paste.

## 4. Low-end device timings

**Playwright half (repeatable):** `frontend/e2e/low-end-performance.spec.ts`
measures cold start and patients-list time with Chrome CPU emulation at 4x
(`Emulation.setCPUThrottlingRate`), writing
`frontend/test-results/low-end-timings.md`.

**Android half (manual, must be done once per release candidate):** the AI
engine's own timings only mean something on the hardware it will run on.

Procedure (₹8–12k class device, e.g. 2–3 GB RAM, Helio A22 / Snapdragon 439):

1. Install the engine bundle (`whisper.cpp`, `llama.cpp`, Tesseract) and the
   `whisper-tiny` + `qwen-0.5b-q4` models; set the `SYNCAREX_*_BIN` env vars
   (see the main README's service section).
2. Record 5 of the Hindi dictations with the stock recorder at 16 kHz mono
   WAV; copy them over the golden `speech/` rows and flip their
   `record-manually` status.
3. Run `python -m ai_engine.evals.run_evals --task all` on the device (or
   curl the local engine per row and time it) and fill the table below.
4. Add the two Playwright numbers from `low-end-timings.md` on the same
   device's Chrome (web page load only).

| Measure | Target device (fill in) |
|---|---|
| Speech: WER English (avg over 24) | — |
| Speech: WER Hindi (avg over recorded rows) | — |
| Speech: transcription seconds per 10 s clip | — |
| OCR: CER English printed (avg over 12) | — |
| OCR: CER Devanagari printed (avg over 3) | — |
| OCR: seconds per document | — |
| Extraction: fact precision / recall | — |
| Extraction: seconds per summary input | — |
| Cold start to signed-in shell | — |
| Patients list interactive | — |

## 5. Known honesty notes

- Hinglish (code-mixed Hindi-English speech) accuracy is **not validated**;
  whisper-tiny is weakest exactly there. The pitch must not claim it.
- Handwriting is out of scope for the golden set and the pitch.
- The extraction set is small; report the numbers with the row counts shown
  in the table, never as bare percentages.
