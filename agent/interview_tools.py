import os
import httpx
from livekit.agents import function_tool, RunContext


BACKEND_URL = os.getenv("INTERVIEW_BACKEND_URL", "http://127.0.0.1:3210")


@function_tool()
async def get_interview_context(
    context: RunContext, interview_session_id: str
) -> dict:
    """Fetch the full interview context including instructions and conversation history.
    Call this at the start of every conversation turn to get the latest context.

    Args:
        interview_session_id: The interview session ID from the frontend.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{BACKEND_URL}/api/realtime-voice/agent-context/{interview_session_id}"
        )
        if resp.status_code != 200:
            return {"error": f"Backend returned {resp.status_code}"}
        return resp.json()


@function_tool()
async def record_interview_turn(
    context: RunContext,
    interview_session_id: str,
    role: str,
    text: str,
    strategy: str = "",
) -> dict:
    """Record a conversation turn (user speech or assistant response) in the interview session.

    Args:
        interview_session_id: The interview session ID.
        role: Either "user" or "assistant".
        text: The full text of the turn.
        strategy: Optional strategy identifier for assistant turns.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{BACKEND_URL}/api/realtime-voice/agent-turn/{interview_session_id}",
            json={"role": role, "text": text, "strategy": strategy},
        )
        return {"status": resp.status_code, "body": resp.text}
