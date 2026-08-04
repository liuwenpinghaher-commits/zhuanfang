/** Domain facade: realtime */
export {
  createBailianRealtimeVoiceClient,
  createBailianRealtimeVoiceClientFromEnv,
  resolveBailianRealtimeModels,
  BAILIAN_REALTIME_MODEL,
  BAILIAN_REALTIME_FALLBACK_MODEL
} from "./_impl";
export type {
  BailianRealtimeVoiceClient,
  BailianRealtimeWebrtcRequest
} from "./_impl";
