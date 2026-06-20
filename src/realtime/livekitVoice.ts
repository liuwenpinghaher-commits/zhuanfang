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

/**
 * Interrupt signal published to the room data channel (P1-10). The Python
 * livekit-agents side is expected to listen for this and cancel its in-flight
 * TTS synthesis. Kept as a small JSON envelope so the agent can version/extend
 * it without breaking the client.
 */
const INTERRUPT_SIGNAL = { type: "interrupt", reason: "user_interrupt" } as const;

export async function createLivekitVoiceSession(
  options: CreateLivekitVoiceSessionOptions
): Promise<LivekitVoiceSession> {
  const { serverUrl, token, callbacks } = options;
  const room = new Room();

  // Track the agent's subscribed audio tracks + the <audio> elements .attach()
  // created, so interrupt() can stop local playback immediately (the only thing
  // the client can do without agent cooperation) instead of letting the buffered
  // TTS play to completion.
  const subscribedAudioTracks = new Set<RemoteTrack>();
  const attachedAudioEls = new Set<HTMLMediaElement>();

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
        subscribedAudioTracks.add(track);
        attachedAudioEls.add(el as HTMLMediaElement);
        console.log("[voice] attached audio from", participant.identity);
      } catch (err) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  // Forget tracks/elements once unsubscribed so interrupt() never touches stale
  // handles (and the sets don't grow unbounded over a long session).
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    subscribedAudioTracks.delete(track);
    try {
      for (const el of track.detach()) attachedAudioEls.delete(el as HTMLMediaElement);
    } catch { /* already detached */ }
  });

  room.on(RoomEvent.Connected, () => {
    callbacks.onStateChange("connected" as ConnectionState);
  });

  // P1-06: livekit-client owns its own reconnect loop (signal + media), but the
  // states were never surfaced — a network blip looked identical to a healthy
  // session, and a *permanent* failure looked the same as a user hangup. Wire
  // the SDK's reconnect lifecycle to onStateChange, and distinguish a terminal
  // drop (Disconnected while we were mid-reconnect) as an error so the UI can
  // show "voice disconnected" rather than silently going dead.
  let reconnecting = false;
  room.on(RoomEvent.Reconnecting, () => {
    reconnecting = true;
    callbacks.onStateChange("reconnecting" as ConnectionState);
  });

  room.on(RoomEvent.Reconnected, () => {
    reconnecting = false;
    callbacks.onStateChange("connected" as ConnectionState);
  });

  room.on(RoomEvent.Disconnected, () => {
    callbacks.onStateChange("disconnected" as ConnectionState);
    // A disconnect that arrives while the SDK was still trying to reconnect means
    // the reconnect attempts were exhausted — report it as a failure, not a
    // clean close.
    if (reconnecting) {
      reconnecting = false;
      callbacks.onError(new Error("LiveKit connection lost and could not reconnect"));
    }
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
      // P1-10: best-effort real interrupt. Three actions, in order of immediacy:
      //
      //   1. Stop LOCAL playback of the agent's buffered TTS right now — pause +
      //      mute the attached <audio> elements and detach the audio tracks. This
      //      is the only thing the client can do unilaterally, and it makes the
      //      agent's voice actually stop in the user's ear immediately instead of
      //      playing the already-buffered sentence to the end.
      //   2. Publish an `interrupt` signal on the room data channel so the Python
      //      livekit-agents side can cancel its in-flight TTS *synthesis* (the
      //      authoritative stop — requires the agent to handle this envelope; see
      //      INTERRUPT_SIGNAL). Without agent cooperation the agent keeps
      //      generating, but local playback (step 1) is already silenced.
      //   3. Re-arm the local mic so the user's barge-in speech is captured.
      //
      // NOTE (dependency): a fully clean interrupt — stopping the agent from
      // *generating* further audio — still needs the agent to honor the data
      // signal in step 2. Steps 1 & 3 work client-side regardless.

      // 1. Silence + tear down local playback of the agent's current utterance.
      for (const el of attachedAudioEls) {
        try { el.pause(); el.muted = true; } catch { /* element gone */ }
      }
      for (const track of subscribedAudioTracks) {
        try { track.detach(); } catch { /* already detached */ }
      }
      attachedAudioEls.clear();
      subscribedAudioTracks.clear();

      // 2. Tell the agent to cancel synthesis (best-effort; needs agent support).
      try {
        const payload = new TextEncoder().encode(JSON.stringify(INTERRUPT_SIGNAL));
        // reliable delivery — an interrupt must not be silently dropped.
        const maybePromise = room.localParticipant.publishData(payload, { reliable: true });
        // publishData returns a Promise in current SDKs; swallow rejection.
        void Promise.resolve(maybePromise).catch(() => { /* agent may not be ready */ });
      } catch {
        /* publishData unavailable (older SDK / mock) — playback is already stopped */
      }

      // 3. Make sure the mic is live so the user's barge-in is heard.
      room.localParticipant.setMicrophoneEnabled(true).catch(() => {
        // mic might already be enabled — ignore
      });
    },
    close() {
      room.disconnect();
    },
  };
}
