/** Domain facade: realtime */
export {
  createBailianRealtimeVoiceClient,
  createBailianRealtimeVoiceClientFromEnv,
  resolveBailianRealtimeModels,
  resolveBailianRealtimeProfile,
  resolveBailianRealtimeProfileId,
  getBailianRealtimeModelProfile,
  BAILIAN_REALTIME_MODEL,
  BAILIAN_REALTIME_FALLBACK_MODEL,
  BAILIAN_REALTIME_DEFAULT_VOICE,
  BAILIAN_REALTIME_PROFILE_OMNI_DEFAULT
} from "./_impl";
export type {
  BailianRealtimeVoiceClient,
  BailianRealtimeWebrtcRequest,
  BailianRealtimeProfileId,
  BailianRealtimeModelProfile
} from "./_impl";
