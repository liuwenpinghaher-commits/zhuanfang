#!/bin/bash
set -e
echo "Starting LiveKit Server (dev mode)..."
livekit-server --dev &
LIVEKIT_PID=$!
echo "LiveKit PID: $LIVEKIT_PID"
sleep 2
echo "Starting Python Agent..."
cd agent && source venv/bin/activate && python main.py dev
