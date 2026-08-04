/** Domain facade: transcription */
export {
  createBailianAudioTranscriptionClient,
  createBailianAudioTranscriptionClientFromEnv
} from "./_impl";
export type {
  BailianAudioTranscriptionClient,
  BailianAudioTranscriptionRequest,
  BailianAudioTranscriptionResult
} from "./_impl";
