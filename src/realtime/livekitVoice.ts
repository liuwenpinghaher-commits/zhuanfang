import {
  Room,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  RoomEvent,
  type ConnectionState,
  Track
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

  for (const p of room.remoteParticipants.values()) {
    wireParticipantSpeaking(p, callbacks);
  }

  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    wireParticipantSpeaking(participant, callbacks);
  });

  // Auto-attach remote audio tracks so the user hears the agent's TTS voice.
  // Room.autoSubscribe only subscribes (receives data); .attach() must be
  // called explicitly to create an <audio> element and start playback.
  room.on(RoomEvent.TrackSubscribed, (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind === Track.Kind.Audio) {
      try {
        const el = track.attach();
        el.setAttribute("autoplay", "true");
        console.log("[voice] attached audio from", participant.identity);
      } catch (err) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  room.on(RoomEvent.Connected, () => {
    callbacks.onStateChange("connected" as ConnectionState);
  });

  room.on(RoomEvent.Disconnected, () => {
    callbacks.onStateChange("disconnected" as ConnectionState);
  });

  // Standard LiveKit TranscriptionSegment protocol — the Python agent
  // (livekit-agents 1.5+) publishes transcripts via publish_transcription()
  room.on(RoomEvent.TranscriptionReceived, (
    segments,
    participant,
  ) => {
    if (!participant) return;
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
    interrupt() {
      // ponytail: LiveKit 模式 interrupt 受 SDK/架构限制，客户端侧无法直接取消
      // 远端 Agent 的 TTS 合成或停止远端音轨播放。完整的打断（停止 Agent 合成并
      // 重新聆听）需要 Agent 侧支持 interrupt 信令（livekit-agents Python 侧）。
      // 当前最小有效行为：确保本地麦克风处于启用状态，以便用户发言时 ASR 可以拾音。
      // 如需真打断，请在后端 Agent 实现 interrupt 数据通道协议并通过 publishData 发送信令。
      room.localParticipant.setMicrophoneEnabled(true).catch(() => {
        // mic might already be enabled — ignore
      });
    },
    close() {
      room.disconnect();
    },
  };
}
