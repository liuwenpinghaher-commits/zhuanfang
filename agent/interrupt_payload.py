"""Pure LiveKit data-channel interrupt contract (no LiveKit/httpx deps)."""
from __future__ import annotations

import json
from typing import Any


def parse_interrupt_data_payload(payload: Any) -> bool:
    """Return True if payload is a client barge-in interrupt signal."""
    try:
        if isinstance(payload, dict):
            msg = payload
        else:
            if isinstance(payload, (bytes, bytearray)):
                raw = bytes(payload).decode("utf-8", errors="replace")
            else:
                raw = str(payload)
            msg = json.loads(raw)
        return isinstance(msg, dict) and msg.get("type") == "interrupt"
    except Exception:
        return False
