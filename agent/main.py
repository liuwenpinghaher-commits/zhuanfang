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

BACKEND_URL = os.getenv("INTERVIEW_BACKEND_URL", "http://127.0.0.1:3210")


def _log(event: str, **fields) -> None:
    """Structured stdout log (the agent worker's log channel)."""
    print(_json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


async def _fetch_agent_context(
    interview_session_id: str, latest_user_text: str | None = None
) -> dict:
    """Fetch the unified interview agent context (instructions + opening) from the backend.

    Returns the InterviewAgentContext dict on success and RAISES on any failure —
    真实性原则：拿不到用户的专访上下文（记忆召回/追踪点/开场问题）绝不能静默退回
    "不认识你"的通用主持人人设，那是产品核心价值（持续跟踪）的静默失效。
    The ``instructions`` field is the full unified voice prompt built by
    buildRealtimeVoiceInstructions.

    When ``latest_user_text`` is provided (per-turn refresh, 🔴-1), the backend
    re-ranks memory recall against that utterance so 可引用记忆/历史 tracks the
    conversation instead of staying frozen at the opening-time snapshot.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        params = {"latestUserText": latest_user_text} if latest_user_text else None
        resp = await client.get(
            f"{BACKEND_URL}/api/realtime-voice/agent-context/{interview_session_id}",
            params=params,
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"agent-context fetch failed: session={interview_session_id} "
                f"status={resp.status_code} body={resp.text[:200]}"
            )
        ctx = resp.json()
        if not isinstance(ctx, dict) or not ctx.get("instructions"):
            raise RuntimeError(
                f"agent-context missing instructions: session={interview_session_id}"
            )
        return ctx

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

# 上下文不可用时对用户的诚实播报（不冒充能正常跟踪的主持人）。
_CONTEXT_UNAVAILABLE_ANNOUNCEMENT = (
    "抱歉，我现在读取不到你的专访资料和历史记忆，无法开始这次专访。"
    "请稍后重试，或检查服务是否在运行。"
)
_STALE_CONTEXT_ANNOUNCEMENT = (
    "提醒一下：我暂时读取不到你最新的资料，接下来的追问可能引用不到最近的内容。"
)


class InterviewAgent(Agent):
    def __init__(
        self,
        instructions: str,
        interview_session_id: str,
    ):
        super().__init__(instructions=instructions)
        self._interview_session_id = interview_session_id
        self._refresh_failures = 0
        self._stale_announced = False
        self._agent_session: AgentSession | None = None

    def bind_session(self, session: AgentSession) -> None:
        self._agent_session = session

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        """🔴-1 (livekit): refresh memory recall on every user turn.

        livekit-agents calls this after the user finishes speaking and before the
        LLM replies. We re-fetch the agent context with the latest utterance so the
        backend re-ranks 可引用记忆/历史 by semantic relevance, then update the
        persona instructions.

        实时性权衡（显式策略，非静默兜底）：刷新失败不阻塞本轮回复（对话必须继续），
        但失败必须暴露——结构化日志逐次记录；连续第 2 次失败时向用户口头播报一次
        "读不到最新资料"，绝不让记忆静默滞留在开场快照。
        """
        try:
            user_text = (new_message.text_content or "").strip()
        except Exception:
            user_text = ""
        if not user_text:
            return
        try:
            ctx = await _fetch_agent_context(
                self._interview_session_id, latest_user_text=user_text
            )
            await self.update_instructions(ctx["instructions"])
            self._refresh_failures = 0
        except Exception as exc:
            self._refresh_failures += 1
            _log(
                "agent_context_refresh_failed",
                session=self._interview_session_id,
                consecutive=self._refresh_failures,
                error=str(exc),
            )
            if self._refresh_failures >= 2 and not self._stale_announced and self._agent_session:
                self._stale_announced = True
                try:
                    await self._agent_session.say(_STALE_CONTEXT_ANNOUNCEMENT)
                except Exception as say_exc:
                    _log("stale_announcement_failed", error=str(say_exc))


async def _announce_and_shutdown(ctx: JobContext, reason: str) -> None:
    """诚实失败路径：连上房间、把"无法开始"的原因播报给用户，然后关闭任务。

    绝不静默退回通用人设开场——那会把"系统不可用"伪装成"专访正常进行"。
    """
    _log("agent_start_refused", room=ctx.room.name or "", reason=reason)
    try:
        announcer = Agent(instructions="你只负责播报系统状态。")
        session = AgentSession(
            tts=aliyun.TTS(
                model="cosyvoice-v2",
                voice="longcheng_v2",
                sample_rate=24000,
            ),
        )
        await ctx.connect()
        await session.start(agent=announcer, room=ctx.room)
        await session.say(_CONTEXT_UNAVAILABLE_ANNOUNCEMENT)
    except Exception as exc:
        # 连播报都失败（如 TTS 也不可用）：只能靠日志与客房关闭暴露。
        _log("agent_refusal_announcement_failed", error=str(exc))
    finally:
        ctx.shutdown(reason=reason)


async def entrypoint(ctx: JobContext):
    # Resolve the interview session id from the LiveKit room name.
    # The JS side mints room names as "interview-{interviewSessionId}".
    room_name = ctx.room.name or ""
    if not room_name.startswith("interview-"):
        await _announce_and_shutdown(ctx, f"room name has no interview session id: {room_name}")
        return
    interview_session_id = room_name[len("interview-"):]

    # Fetch the unified agent context (persona instructions + opening discipline
    # with card.suggestedOpening already embedded) from the backend.
    # 失败 → 诚实播报并结束，不再用通用人设冒充。
    try:
        agent_context = await _fetch_agent_context(interview_session_id)
    except Exception as exc:
        await _announce_and_shutdown(ctx, str(exc))
        return

    agent = InterviewAgent(
        instructions=agent_context["instructions"],
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
    agent.bind_session(session)

    await ctx.connect()
    await session.start(agent=agent, room=ctx.room)

    # Open from the prepared tracking-point question — never greet or small-talk.
    # The unified instructions (fetched above) already embed the opening discipline
    # and card.suggestedOpening via buildVoiceOpeningDiscipline.  The generate_reply
    # instruction here reinforces that rule so the LLM fires the right first turn.
    opening_instruction = (
        "严格遵守你的【开场铁律】：直接说出你的开场问题（card.suggestedOpening），"
        "不要任何寒暄、不要自我介绍、不要说『你好』或『最近怎么样』。"
        "从跟踪点切入第一句话，立刻抛出问题。"
    )
    await session.generate_reply(instructions=opening_instruction)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
