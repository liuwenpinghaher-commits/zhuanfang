/**
 * Realtime model **profile** layer — single extension point for Omni / future Audio3 families.
 *
 * PR-7: only `omni-default` is implemented (current production defaults).
 * `audio3-flash` is a reserved id for PR-8; until OQ1 freezes Audio3 model/voice ids,
 * resolving that profile id falls back to `omni-default` so runtime behavior is unchanged.
 *
 * CosyVoice / cascade TTS voices (BAILIAN_TTS_VOICE, longanyang, …) are **out of scope**
 * here — never mix Omni session voices with Cosy presets.
 */

export type BailianRealtimeProfileId = "omni-default" | "audio3-flash";

/** Omni Realtime session defaults (voice + pcm formats for session.update). */
export interface BailianRealtimeModelProfile {
  id: BailianRealtimeProfileId;
  /** Primary DashScope realtime model id. */
  model: string;
  /** One-shot fallback when primary is rejected or handshake times out. */
  fallbackModel: string;
  /**
   * Default Omni Realtime session voice (Qwen-Omni family, e.g. Ethan).
   * Not a CosyVoice id.
   */
  voice: string;
  inputAudioFormat: "pcm";
  outputAudioFormat: "pcm";
}

/** Canonical Omni defaults — source of truth for BAILIAN_REALTIME_* constants. */
export const BAILIAN_REALTIME_PROFILE_OMNI_DEFAULT: BailianRealtimeModelProfile = {
  id: "omni-default",
  model: "qwen3.5-omni-flash-realtime",
  fallbackModel: "qwen3-omni-flash-realtime",
  voice: "Ethan",
  inputAudioFormat: "pcm",
  outputAudioFormat: "pcm"
};

/** Stable export: primary Omni realtime model (from omni-default profile). */
export const BAILIAN_REALTIME_MODEL = BAILIAN_REALTIME_PROFILE_OMNI_DEFAULT.model;
/** Stable export: fallback Omni realtime model (from omni-default profile). */
export const BAILIAN_REALTIME_FALLBACK_MODEL = BAILIAN_REALTIME_PROFILE_OMNI_DEFAULT.fallbackModel;
/** Default Omni path voice (Ethan). Separate from Cosy TTS defaults. */
export const BAILIAN_REALTIME_DEFAULT_VOICE = BAILIAN_REALTIME_PROFILE_OMNI_DEFAULT.voice;

const PROFILE_BY_ID: Record<BailianRealtimeProfileId, BailianRealtimeModelProfile | null> = {
  "omni-default": BAILIAN_REALTIME_PROFILE_OMNI_DEFAULT,
  // Reserved for PR-8 after OQ1 freeze. Not registered → resolve falls back to omni-default.
  "audio3-flash": null
};

/**
 * Which profile family is selected. Unknown / unimplemented ids → `omni-default`.
 * `BAILIAN_REALTIME_PROFILE=audio3-flash` currently still yields omni-default until PR-8.
 */
export function resolveBailianRealtimeProfileId(
  env: Record<string, string | undefined>
): BailianRealtimeProfileId {
  const raw = (env.BAILIAN_REALTIME_PROFILE ?? "").trim();
  if (raw === "omni-default" || raw === "audio3-flash") {
    if (raw === "audio3-flash" && PROFILE_BY_ID["audio3-flash"] === null) {
      return "omni-default";
    }
    return raw;
  }
  return "omni-default";
}

/** Base profile object for a known id (no env overrides). Unimplemented → omni-default. */
export function getBailianRealtimeModelProfile(
  id: BailianRealtimeProfileId = "omni-default"
): BailianRealtimeModelProfile {
  return PROFILE_BY_ID[id] ?? BAILIAN_REALTIME_PROFILE_OMNI_DEFAULT;
}

/**
 * Effective profile after env overrides.
 * - `BAILIAN_REALTIME_PROFILE` selects family (today only omni-default is live)
 * - `BAILIAN_REALTIME_MODEL` / `_FALLBACK_MODEL` / `_VOICE` still override fields when set
 */
export function resolveBailianRealtimeProfile(
  env: Record<string, string | undefined>
): BailianRealtimeModelProfile {
  const base = getBailianRealtimeModelProfile(resolveBailianRealtimeProfileId(env));
  return {
    ...base,
    model: env.BAILIAN_REALTIME_MODEL?.trim() || base.model,
    fallbackModel: env.BAILIAN_REALTIME_FALLBACK_MODEL?.trim() || base.fallbackModel,
    voice: env.BAILIAN_REALTIME_VOICE?.trim() || base.voice
  };
}

/** Same contract as before: primary + fallback model ids (via profile). */
export function resolveBailianRealtimeModels(env: Record<string, string | undefined>): {
  model: string;
  fallbackModel: string;
} {
  const profile = resolveBailianRealtimeProfile(env);
  return {
    model: profile.model,
    fallbackModel: profile.fallbackModel
  };
}
