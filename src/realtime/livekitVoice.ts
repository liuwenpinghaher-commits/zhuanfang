import {
  Room,
  type RemoteParticipant,
  RoomEvent,
  type ConnectionState,
} from "livekit-client";

export interface LivekitVoiceCallbacks {
  onStateChange: (state: ConnectionState) => void;
  onUserTranscript: (text: string, isFinal: boolean) => void;
  onAssistantTranscript: (text: string, isFinal: boolean) => void;
  onAudioLevel: (level: number) => void;
  onError: (error: Error) => void;
}

export interface LivekitVoiceSession {
  startListening(): Promise<void>;
  interrupt(): void;
  close(): void;
}

export interface CreateLivekitVoiceSessionOptions {
  serverUrl: string;
  token: string;
  interviewSessionId: string;
  callbacks: LivekitVoiceCallbacks;
}

function wireParticipantSpeaking(
  participant: RemoteParticipant,
  callbacks: LivekitVoiceCallbacks,
) {
  participant.on("isSpeakingChanged", (speaking: boolean) => {
    callbacks.onAudioLevel(speaking ? 1.0 : 0.0);
  });
}

export async function createLivekitVoiceSession(
  options: CreateLivekitVoiceSessionOptions
): Promise<LivekitVoiceSession> {
  const { serverUrl, token, callbacks } = options;
  const room = new Room();

  // Wire speaking indicators for already-joined remote participants
  for (const p of room.remoteParticipants.values()) {
    wireParticipantSpeaking(p, callbacks);
  }

  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    wireParticipantSpeaking(participant, callbacks);
  });

  room.on(RoomEvent.Connected, () => {
    callbacks.onStateChange("connected" as ConnectionState);
  });

  room.on(RoomEvent.Disconnected, () => {
    callbacks.onStateChange("disconnected" as ConnectionState);
  });

  // Standard LiveKit TranscriptionSegment protocol — the Python agent
  // (livekit-agents 1.5+) publishes transcripts via publish_transcription()
  // with participant_identity set to the represented-by user for STT output
  // and to the agent's own identity for TTS output.
  room.on(RoomEvent.TranscriptionReceived, (
    segments,
    participant,
  ) => {
    if (!participant) return;
    // The participant parameter maps to participant_identity in the proto:
    // identity starting with "agent-" = agent TTS transcript,
    // anything else (the browser user) = user STT transcript.
    const isAgent = participant.identity.startsWith("agent-");
    for (const seg of segments) {
      if (isAgent) {
        callbacks.onAssistantTranscript(seg.text, seg.final);
      } else {
        callbacks.onUserTranscript(seg.text, seg.final);
      }
    }
  });

  room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
    callbacks.onStateChange(state);
  });

  try {
    await room.connect(serverUrl, token);
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }

  return {
    async startListening() {
      await room.localParticipant.setMicrophoneEnabled(true);
    },
    async interrupt() {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch {
        // mic might already be enabled
      }
    },
    close() {
      room.disconnect();
    },
  };
}
