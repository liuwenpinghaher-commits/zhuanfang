# Spike: half-cascade inject assistant text (omni mouth)

> **Status:** `SKIPPED`
> **Ran at:** 2026-08-10T04:57:29.748Z
> **Model:** `qwen3.5-omni-flash-realtime`
> **API key:** configured: false
> **Script:** `scripts/spike-half-cascade.mjs`
> **WS:** `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...`

## Purpose

Verify whether **DashScope Omni realtime** can speak **client-provided assistant text**
(half-cascade: **brain text → omni mouth**).

| Role | Component | Responsibility |
|------|-----------|----------------|
| Brain | External interviewer LLM (HTTP) | Craft questions / follow-ups |
| Mouth | Omni realtime (audio out) | Speak the *exact* brain text (or close enough) |
| Ear | Omni realtime (optional) | VAD / ASR on same session |

If this works, product can own interview craft in our LLM while reusing omni for
low-latency speech, without a separate CosyVoice path for that mode.

**Out of scope:** production cascade/bailian path changes. This is a read-only probe.

## Go / No-Go criteria

### GO (half-cascade feasible)

All of the following:

1. **Connect + session.update** accepted with `modalities: ["text","audio"]` (or equivalent audio-capable session).
2. At least one inject path yields **audio output** (`response.audio.delta` / `response.output_audio.delta` / binary audio / clear audio-done event).
3. Spoken content is **controllable** by client text:
   - either assistant `conversation.item.create` is accepted and audio tracks the item text, **or**
   - `response.create` + `instructions` reliably forces near-verbatim speech of the provided sentence.
4. No hard protocol rejection that would make automation impossible (e.g. assistant items always error).

### NO-GO (keep full cascade / CosyVoice mouth)

Any of:

1. Omni **rejects** assistant text injection and only generates free-form model speech from user prompts.
2. Audio out works but **ignores** fixed text (high paraphrase / unusable craft control).
3. Session accepts update but **never emits audio** for inject/response.create paths under probe timeout.
4. Auth / model / protocol errors that make the path non-viable for product (after retry with documented model).

### CONDITIONAL / PARTIAL

- Audio works only via `response.create` instructions (not assistant item inject) → document as **partial GO** (still usable mouth, weaker "inject" semantics).
- Text-only session only → **NO-GO for mouth**; may still be useful as ear in full cascade.

## Probe approaches

| ID | Approach | Verdict | Detail |
|----|----------|---------|--------|
| A | conversation.item.create (assistant) + response.create | SKIPPED | no API key |
| B | response.create with instructions (verbatim) | SKIPPED | no API key |

## Overall verdict

**`SKIPPED`**

## Notes

- DASHSCOPE_API_KEY missing — live probe skipped (exit 0 for CI).
- Fill .env.local and re-run to populate approach verdicts.
- Production cascade/bailian paths were not modified.

## Event sample (truncated)

- (none)

## How to re-run

```bash
# requires DASHSCOPE_API_KEY in .env.local or env
node scripts/spike-half-cascade.mjs

# optional overrides
BAILIAN_REALTIME_MODEL=qwen3.5-omni-flash-realtime \
SPIKE_HALF_CASCADE_TEXT='请直接说出这句话：测试半级联。' \
node scripts/spike-half-cascade.mjs
```

Without a key the script exits **0** with `SKIPPED` (CI-safe) and refreshes this template.

## Implication for product

- **GO / PARTIAL GO** → design half-cascade path (brain LLM → inject → omni speak); keep full cascade as fallback.
- **NO-GO** → continue ASR→LLM→CosyVoice cascade; do not block interview craft on omni generation.
- **SKIPPED** → no live evidence yet; do not flip production defaults.

---
*Generated/updated by `scripts/spike-half-cascade.mjs`. Do not put secrets in this file.*
