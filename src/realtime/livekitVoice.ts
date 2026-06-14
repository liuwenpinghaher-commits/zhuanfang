import {
  Room,
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

export async function createLivekitVoiceSession(
  options: CreateLivekitVoiceSessionOptions
): Promise<LivekitVoiceSession> {
  const { serverUrl, token, callbacks } = options;
  const room = new Room();

  room.on(RoomEvent.Connected, () => {
    callbacks.onStateChange("connected" as ConnectionState);
  });

  room.on(RoomEvent.Disconnected, () => {
    callbacks.onStateChange("disconnected" as ConnectionState);
  });

  room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(payload));
      if (msg.type === "user_transcript") {
        callbacks.onUserTranscript(msg.text, msg.isFinal ?? false);
      } else if (msg.type === "assistant_transcript") {
        callbacks.onAssistantTranscript(msg.text, msg.isFinal ?? false);
      }
    } catch {
      // non-JSON data, ignore
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
    interrupt() {
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: "interrupt" })),
        { reliable: true }
      );
    },
    close() {
      room.disconnect();
    },
  };
}
