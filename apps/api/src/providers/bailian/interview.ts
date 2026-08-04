/** Domain facade: interview */
export {
  createBailianCharacterInterviewClient,
  createBailianCharacterInterviewClientFromEnv,
  buildCharacterSystemPrompt,
  extractPreSignals
} from "./_impl";
export type {
  BailianCharacterInterviewClient,
  BailianCharacterInterviewRequest,
  BailianCharacterInterviewResult
} from "./_impl";
