import os
import json as _json
import httpx
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    WorkerOptions,
    cli,
)
from livekit.plugins import aliyun
from livekit.plugins.turn_detector.multilingual import MultilingualModel

load_dotenv()

BACKEND_URL = os.getenv("INTERVIEW_BACKEND_URL", "http://127.0.0.1:8787")


async def _fetch_agent_context(
    interview_session_id: str, latest_user_text: str | None = None
) -> dict | None:
    """Fetch the unified interview agent context (instructions + opening) from the backend.

    Returns the InterviewAgentContext dict on success, or None on any failure.
    The ``instructions`` field is the full unified voice prompt built by
    buildRealtimeVoiceInstructions — it already contains the opening discipline
    and card.suggestedOpening, so we use it to update the agent persona and
    to drive the opening generate_reply.

    When ``latest_user_text`` is provided (per-turn refresh, 🔴-1), the backend
    re-ranks memory recall against that utterance so 可引用记忆/历史 tracks the
    conversation instead of staying frozen at the opening-time snapshot.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            params = {"latestUserText": latest_user_text} if latest_user_text else None
            resp = await client.get(
                f"{BACKEND_URL}/api/realtime-voice/agent-context/{interview_session_id}",
                params=params,
            )
            if resp.status_code == 200:
                return resp.json()
            print(
                f"[agent] agent-context fetch failed: "
                f"session={interview_session_id} status={resp.status_code}"
            )
            return None
    except Exception as exc:
        print(f"[agent] agent-context fetch error: {exc}")
        return None

# ----------------------------------------------------------------------------
# Bug fix: livekit-plugins-aliyun==1.2.9's chat-context serializer pre-dates the
# AgentConfigUpdate / AgentHandoff item types added in livekit-agents 1.5+.
# Its _to_chat_item falls off the end and returns None for those items, which
# DashScope rejects with the misleading error: "message must be json_object."
#
# Strip the unsupported item types before the plugin sees them. They carry
# only internal agent state (instructions diffs, agent handoff metadata) and
# should not be sent to the LLM as chat messages.
# ----------------------------------------------------------------------------
from livekit.plugins.aliyun import utils as _aliyun_utils
_orig_to_chat_ctx = _aliyun_utils.to_chat_ctx
_SUPPORTED_ITEM_TYPES = {"message", "function_call", "function_call_output"}

def _patched_to_chat_ctx(chat_ctx, cache_key):
    filtered = chat_ctx.copy()
    filtered.items = [it for it in filtered.items if it.type in _SUPPORTED_ITEM_TYPES]
    return _orig_to_chat_ctx(filtered, cache_key)

_aliyun_utils.to_chat_ctx = _patched_to_chat_ctx
# also patch the symbol that llm.py imported by name
import livekit.plugins.aliyun.llm as _aliyun_llm
_aliyun_llm.to_chat_ctx = _patched_to_chat_ctx

_FALLBACK_INSTRUCTIONS = (
    "你是一个真正的私人专访主持人，不是普通聊天助手。"
    "这是对同一个人的持续跟踪，不是初次见面——绝不寒暄、绝不自我介绍、绝不问『最近怎么样』。"
    "第一句话直接从跟踪点切入：上次要追的问题、反复出现的主题、或未还的知识债。"
    "每次只问一个核心问题，优先追具体事件和真实张力，不替对方下结论。"
    "用户打断时立刻停，沉默时先留白。"
)


class InterviewAgent(Agent):
    def __init__(
        self,
        instructions: str = _FALLBACK_INSTRUCTIONS,
        interview_session_id: str | None = None,
    ):
        super().__init__(instructions=instructions)
        self._interview_session_id = interview_session_id

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        """🔴-1 (livekit): refresh memory recall on every user turn.

        livekit-agents calls this after the user finishes speaking and before the
        LLM replies. We re-fetch the agent context with the latest utterance so the
        backend re-ranks 可引用记忆/历史 by semantic relevance, then update the
        persona instructions. Best-effort: any failure leaves the current
        instructions unchanged (the opening snapshot), never blocks the reply.
        """
        if not self._interview_session_id:
            return
        try:
            user_text = (new_message.text_content or "").strip()
        except Exception:
            user_text = ""
        if not user_text:
            return
        ctx = await _fetch_agent_context(
            self._interview_session_id, latest_user_text=user_text
        )
        fresh = ctx.get("instructions") if ctx else None
        if not fresh:
            return
        try:
            await self.update_instructions(fresh)
        except Exception as exc:
            print(f"[agent] per-turn update_instructions failed: {exc}")


async def entrypoint(ctx: JobContext):
    # Resolve the interview session id from the LiveKit room name.
    # The JS side mints room names as "interview-{interviewSessionId}".
    room_name = ctx.room.name or ""
    interview_session_id: str | None = None
    if room_name.startswith("interview-"):
        interview_session_id = room_name[len("interview-"):]

    # Fetch the unified agent context (persona instructions + opening discipline
    # with card.suggestedOpening already embedded) from the backend.
    agent_context: dict | None = None
    if interview_session_id:
        agent_context = await _fetch_agent_context(interview_session_id)

    # Build the agent with the fetched instructions, falling back to the safe
    # static persona when no session context is available.
    instructions = (
        agent_context.get("instructions") or _FALLBACK_INSTRUCTIONS
        if agent_context
        else _FALLBACK_INSTRUCTIONS
    )
    agent = InterviewAgent(
        instructions=instructions,
        interview_session_id=interview_session_id,
    )

    session = AgentSession(
        stt=aliyun.STT(model="paraformer-realtime-v2"),
        llm=aliyun.LLM(
            model="qwen-plus",
            temperature=0.7,
        ),
        tts=aliyun.TTS(
            model="cosyvoice-v2",
            voice="longcheng_v2",
            sample_rate=24000,
        ),
        turn_detection=MultilingualModel(),
    )

    await ctx.connect()
    await session.start(agent=agent, room=ctx.room)

    # Open from the prepared tracking-point question — never greet or small-talk.
    # The unified instructions (fetched above) already embed the opening discipline
    # and card.suggestedOpening via buildVoiceOpeningDiscipline.  The generate_reply
    # instruction here reinforces that rule so the LLM fires the right first turn.
    if agent_context:
        opening_instruction = (
            "严格遵守你的【开场铁律】：直接说出你的开场问题（card.suggestedOpening），"
            "不要任何寒暄、不要自我介绍、不要说『你好』或『最近怎么样』。"
            "从跟踪点切入第一句话，立刻抛出问题。"
        )
    else:
        opening_instruction = (
            "按你的开场铁律直接开场：从一个跟踪点（上次要追的问题/反复出现的主题/未还的知识债）"
            "切入第一句，绝不寒暄、不自我介绍、不要问『最近怎么样』。"
        )
    await session.generate_reply(instructions=opening_instruction)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
