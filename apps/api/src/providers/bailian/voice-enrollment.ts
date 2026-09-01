/** Domain facade: voice-enrollment */
export {
  createBailianVoiceEnrollmentClient,
  createBailianVoiceEnrollmentClientFromEnv,
  resolveVoiceEnrollmentApiKey,
  resolveVoiceEnrollmentBaseUrl,
  sanitizeVoiceEnrollmentPrefix,
  BAILIAN_DEFAULT_ENROLLMENT_BASE_URL,
  QWEN_AUDIO_TTS_ENROLLMENT_TARGET
} from "./_impl";
export type {
  BailianVoiceEnrollmentClient,
  BailianVoiceInfo
} from "./_impl";
