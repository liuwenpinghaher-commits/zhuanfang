# Spike: Audio 3.0 session + voice allowlist (PR-8s)

> **Status:** `RAN`
> **Ran at:** 2026-08-10T05:41:37.773Z
> **API key:** configured: true
> **Script:** `scripts/spike-audio3-session.mjs`
> **WS base:** `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...`
> **OQ1:** **not frozen** → production **PR-8 remains blocked** even if this spike is green

## Purpose

Gather live evidence for DashScope **Qwen-Audio-Realtime 3.0** (profile family `audio3-flash`):

| Probe | Question |
|-------|----------|
| Model connect | Which model ids accept WS + `session.update` (text+audio)? |
| Voice allowlist | Which system `voice` values echo/accept (Audio3 ≠ Omni ≠ Cosy)? |
| Turn detection | Does `server_vad` / `smart_turn` accept on first update? |
| One audio round | Can a minimal `response.create` emit audio deltas? |

**Out of scope / hard rules**

- Does **not** enable `VOICE_BAILIAN_AUDIO3` or register non-null `PROFILE_BY_ID["audio3-flash"]`.
- Does **not** change default cascade / Omni production paths.
- Spike **GO ≠ merge PR-8** until OQ1 freezes model id + smart_turn + voice allowlist.

## Go / No-Go (for *future* PR-8 design only)

### Evidence GO (spike green — still not production)

1. At least one candidate model connects and accepts `session.update` with `modalities: ["text","audio"]`.
2. At least one **Audio3-family** system voice is accepted (not only Omni/Cosy ids).
3. At least one turn_detection mode (`server_vad` or `smart_turn`) is accepted.
4. Optional but strong: one response path yields audio (`response.audio.delta` / binary / audio.done).

### NO-GO for Audio3 profile (keep omni-default only)

1. All candidate models reject connect / session.update.
2. No stable system voice for Audio3 (only errors).
3. Protocol incompatible with our realtime event expectations in a way that blocks automation.

### OQ1 freeze checklist (manual)

When product freezes OQ1, fill from this file:

- Primary model id: …
- Fallback model id: …
- Default voice + allowlist: …
- Default turn_detection: …
- Then (and only then) PR-8 may register profile + flag-default-off path.

## Models probed

| Model | Verdict | Detail |
|-------|---------|--------|
| `qwen-audio-3.0-realtime-flash` | HTTP_ERR | HTTP 401: {"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"cae1736b-a645-92b9-a8b1-bdabb4ebcaeb"} |
| `qwen-audio-3.0-realtime-plus` | HTTP_ERR | HTTP 401: {"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"a5eba956-a182-950c-867b-f40804d73a5a"} |

## Voice allowlist probes

| Model | Voice | Verdict | Detail |
|-------|-------|---------|--------|
| `qwen-audio-3.0-realtime-flash` | `longanqian` | HTTP_ERR | HTTP 401: {"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"06085d69-71f9-956d-a6db-4baf71f798d2"} |
| `qwen-audio-3.0-realtime-flash` | `longanhuan` | HTTP_ERR | HTTP 401: {"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"8472633f-ab87-9635-b8ab-3742c1ecdda9"} |
| `qwen-audio-3.0-realtime-flash` | `Ethan` | HTTP_ERR | HTTP 401: {"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"aef219b0-3210-93f8-b740-e65c4bfea34c"} |

## Turn detection probes

| Model | Mode | Verdict | Detail |
|-------|------|---------|--------|
| `qwen-audio-3.0-realtime-flash` | `server_vad` | HTTP_ERR | HTTP 401: {"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"c6deaa7b-9514-9036-b9a8-189dfd7fe826"} |
| `qwen-audio-3.0-realtime-flash` | `smart_turn` | HTTP_ERR | HTTP 401: {"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"096003f5-142a-9468-9477-c1c6393387dc"} |

## Overall verdict

**`ERROR`**

## Notes

- Primary model used for voice/td probes: qwen-audio-3.0-realtime-flash
- Overall: ERROR
- Verdict ERROR.
- This spike does not enable VOICE_BAILIAN_AUDIO3 or change realtime-model-profile registration.
- Omni and Cosy production defaults remain unchanged (CFC+).

## Freeze hints (draft — not frozen)

- No accepted model ids yet.
- No accepted Audio3 voices yet.
- No accepted turn_detection mode yet.
- Do not set VOICE_BAILIAN_AUDIO3=true or register audio3-flash profile until OQ1 freezes.

## Event sample (truncated)

- (none)

## How to re-run

```bash
# requires DASHSCOPE_API_KEY in .env.local or env
node scripts/spike-audio3-session.mjs

# optional overrides
SPIKE_AUDIO3_MODELS=qwen-audio-3.0-realtime-flash \
SPIKE_AUDIO3_VOICES=longanqian \
SPIKE_AUDIO3_TIMEOUT_MS=25000 \
node scripts/spike-audio3-session.mjs
```

Without a key the script exits **0** with `SKIPPED` (CI-safe) and refreshes this template.

## Implication for product

- **SKIPPED** → no live evidence; **do not** merge production Audio3 (PR-8 blocked by OQ1 anyway).
- **EVIDENCE_GO / PARTIAL** → use rows above to draft OQ1 freeze; still **flag-default-off** when implementing PR-8.
- **NO_GO** → keep `audio3-flash` profile null; document residual; no production path.
- Cosy cascade default remains the user-facing path (CFC+).

---
*Generated/updated by `scripts/spike-audio3-session.mjs`. Do not put secrets in this file.*
