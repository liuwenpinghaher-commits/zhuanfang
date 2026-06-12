import type {
  CorpusImportInput,
  CorpusInsight,
  InterviewSession,
  InterviewTurn,
  PodcastEpisode,
  SearchProviderId
} from "../domain/types";

export type CapabilityProviderKind = "search" | "voice" | "podcast" | "corpus" | "interview-model";

export interface CapabilityProviderBase {
  id: string;
  kind: CapabilityProviderKind;
  label: string;
  description: string;
  requiresApiKey: boolean;
}

export interface VoiceSynthesisInput {
  text: string;
  voice: string;
  format: "mp3" | "wav";
}

export interface VoiceSynthesisOutput {
  audioUrl: string;
  durationSec: number;
  providerId: string;
}

export interface VoiceProvider extends CapabilityProviderBase {
  kind: "voice";
  synthesize(input: VoiceSynthesisInput): Promise<VoiceSynthesisOutput>;
}

export interface PodcastGenerationInput {
  noteId: string;
  voice: string;
  format: PodcastEpisode["format"];
}

export interface PodcastGenerator extends CapabilityProviderBase {
  kind: "podcast";
  generate(input: PodcastGenerationInput): Promise<PodcastEpisode>;
}

export interface CorpusAnalyzer extends CapabilityProviderBase {
  kind: "corpus";
  analyze(input: CorpusImportInput): Promise<CorpusInsight>;
}

export interface InterviewModelInput {
  session: InterviewSession;
  userText: string;
}

export interface InterviewModelProvider extends CapabilityProviderBase {
  kind: "interview-model";
  nextTurn(input: InterviewModelInput): Promise<InterviewTurn>;
}

export const capabilityProviderKinds: CapabilityProviderKind[] = [
  "search",
  "voice",
  "podcast",
  "corpus",
  "interview-model"
];

export const searchProviderLabels: Record<SearchProviderId, string> = {
  "local-demo": "Local Demo Search",
  bailian: "百炼内置联网",
  anysearch: "AnySearch",
  tavily: "Tavily",
  exa: "Exa",
  brave: "Brave Search"
};
