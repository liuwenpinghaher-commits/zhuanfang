"""Headless smoke test: connect a fake user to LiveKit, capture agent's outgoing
DashScope HTTP request when the agent greets us. Driver script."""
import asyncio
import os
import sys
sys.path.insert(0, "agent/venv/lib/python3.12/site-packages")

import livekit.rtc as rtc
from livekit import api

LIVEKIT_URL = "ws://127.0.0.1:7880"
API_KEY = "devkey"
API_SECRET = "secret"

async def main():
    room_name = "interview-smoke-test-001"
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

    room = rtc.Room()

    @room.on("participant_connected")
    def on_pc(p):
        print(f"[room] participant_connected: {p.identity}")

    @room.on("track_subscribed")
    def on_ts(track, pub, p):
        print(f"[room] track_subscribed from {p.identity}: kind={track.kind}")

    @room.on("disconnected")
    def on_dc(reason):
        print(f"[room] disconnected: {reason}")

    print(f"[main] connecting to {LIVEKIT_URL} room={room_name}")
    await room.connect(LIVEKIT_URL, token)
    print(f"[main] connected; participants: {[p.identity for p in room.remote_participants.values()]}")

    # Publish silent audio so the agent has a track to attach to
    src = rtc.AudioSource(48000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", src)
    options = rtc.TrackPublishOptions()
    options.source = rtc.TrackSource.SOURCE_MICROPHONE
    await room.local_participant.publish_track(track, options)
    print("[main] published silent audio track")

    # Wait 25 seconds for agent to do its thing
    print("[main] waiting 25s for agent activity...")
    for i in range(25):
        await asyncio.sleep(1)
        agents = [p for p in room.remote_participants.values() if p.identity.startswith("agent")]
        if i % 5 == 0:
            print(f"  t={i}s remote_participants={[p.identity for p in room.remote_participants.values()]}")

    print("[main] disconnecting")
    await room.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
