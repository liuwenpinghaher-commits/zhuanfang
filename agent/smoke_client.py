"""Headless end-to-end smoke test: connects to LiveKit, subscribes to agent's
audio track, captures PCM audio + transcriptions, and saves the first 20s of
audio to a WAV file for playback verification. Returns exit code 1 on failure."""
import asyncio
import json
import os
import struct
import sys
import time
import wave
sys.path.insert(0, "agent/venv/lib/python3.12/site-packages")

import livekit.rtc as rtc
from livekit import api

LIVEKIT_URL = "ws://127.0.0.1:7880"
API_KEY = "devkey"
API_SECRET = "secret"
WAV_FILE = "/tmp/zhuanfang-logs/smoke_audio.wav"

def timestamp() -> str:
    return time.strftime("%H:%M:%S")

class SmokeClient:
    def __init__(self):
        self._transcripts: list[dict] = []
        self._audio_frames: list[bytes] = []  # raw PCM 24kHz mono int16
        self._start = time.time()

    @property
    def elapsed(self) -> float:
        return time.time() - self._start

    def log(self, msg: str) -> None:
        print(f"[+{self.elapsed:.1f}s] {msg}", flush=True)

    def on_track_subscribed(self, track: rtc.RemoteAudioTrack, _pub, participant):
        self.log(f"subscribed to audio track kind={track.kind} src={_pub.source} type={_pub.mime_type} from {participant.identity}")
        track.on("audio_frame", self.on_audio_frame)

    def on_audio_frame(self, frame: rtc.AudioFrame):
        raw = frame.data.tobytes() if hasattr(frame.data, 'tobytes') else bytes(frame.data)
        self._audio_frames.append(raw)

    def on_transcription(self, segments, participant):
        if not participant:
            return
        for seg in segments:
            # Only log final segments to avoid noise
            if not seg.final:
                continue
            is_agent = participant.identity.startswith("agent-")
            prefix = "[AGENT]" if is_agent else "[USER ]"
            self.log(f"transcript {prefix} {participant.identity}: {seg.text}")
            self._transcripts.append({
                "role": "agent" if is_agent else "user",
                "text": seg.text,
                "t": self.elapsed,
            })

    def save_wav(self):
        if not self._audio_frames:
            self.log("save_wav: no audio frames — TTS produced nothing")
            return False
        agg = b"".join(self._audio_frames)
        with wave.open(WAV_FILE, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # int16
            wf.setframerate(24000)
            wf.writeframes(agg)
        self.log(f"save_wav: {len(agg)/2} samples, {len(agg)/24000:.1f}s, saved to {WAV_FILE}")
        return True

    def report(self) -> int:
        has_audio = len(self._audio_frames) > 0
        agent_transcripts = [t for t in self._transcripts if t["role"] == "agent"]
        user_transcripts = [t for t in self._transcripts if t["role"] == "user"]
        print(f"\n{'='*60}")
        print(f"SMOKE REPORT")
        print(f"  Agent transcripts: {len(agent_transcripts)}")
        for t in agent_transcripts:
            print(f"    [{t['t']:.1f}s] {t['text'][:120]}")
        print(f"  User transcripts: {len(user_transcripts)}")
        print(f"  Audio frames: {len(self._audio_frames)} ({'PASS' if has_audio else 'FAIL — no audio'})")
        print(f"  Audio file: {WAV_FILE} ({'PASS' if os.path.exists(WAV_FILE) else 'FAIL'})")
        print(f"{'='*60}")
        if has_audio and len(agent_transcripts) > 0:
            print("RESULT: PASS — agent transcript + audio both captured")
            return 0
        else:
            print("RESULT: FAIL")
            problems = []
            if not has_audio:
                problems.append("no audio frames received")
            if not agent_transcripts:
                problems.append("no agent transcriptions")
            print(f"Reasons: {', '.join(problems)}")
            return 1

async def main():
    room_name = "interview-smoke-" + str(int(time.time()) % 100000)

    token = (
        api.AccessToken(API_KEY, API_SECRET)
        .with_identity("smoke-user")
        .with_name("Smoke User")
        .with_grants(api.VideoGrants(
            room=room_name,
            room_join=True,
            can_publish=True,
            can_subscribe=True,
        ))
        .to_jwt()
    )

    client = SmokeClient()
    room = rtc.Room()

    @room.on("participant_connected")
    def on_pc(p):
        client.log(f"participant_connected: {p.identity}")

    @room.on("track_subscribed")
    def on_ts(track, pub, p):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            client.on_track_subscribed(track, pub, p)
        else:
            client.log(f"track_subscribed (non-audio) from {p.identity}: kind={track.kind}, mime={pub.mime_type}")

    @room.on("transcription_received")
    def on_tr(segments, participant, *_):
        client.on_transcription(segments, participant)

    @room.on("disconnected")
    def on_dc(reason):
        client.log(f"disconnected: {reason}")

    client.log(f"connecting room={room_name}")
    await room.connect(LIVEKIT_URL, token)

    # Publish silent mic track so agent can latch on
    src = rtc.AudioSource(24000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", src)
    opts = rtc.TrackPublishOptions()
    opts.source = rtc.TrackSource.SOURCE_MICROPHONE
    await room.local_participant.publish_track(track, opts)

    client.log("waiting for agent (30s)...")
    for _ in range(30):
        await asyncio.sleep(1)
        if _ == 5 and len(client._audio_frames) == 0 and len(client._transcripts) == 0:
            client.log("no audio/transcript after 5s — agent may have failed; keep waiting")
        if _ >= 10 and len(client._audio_frames) > 0:
            # got audio, give a few more seconds to collect
            if _ == 14:
                break

    await room.disconnect()
    client.save_wav()
    sys.exit(client.report())

if __name__ == "__main__":
    asyncio.run(main())
