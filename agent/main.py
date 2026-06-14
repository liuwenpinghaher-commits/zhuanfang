import os
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
from interview_tools import get_interview_context, record_interview_turn

load_dotenv()

class InterviewAgent(Agent):
    def __init__(self):
        super().__init__(
            instructions="""你是一个真正的私人专访主持人。
每次只问一个核心问题，优先追具体事件、真实张力和可验证假设。
使用 get_interview_context 获取专访上下文，使用 record_interview_turn 记录对话轮次。
保持回复简洁，每句话不超过两段，不要替用户下结论。

打断与附和规则：
- 用户说"嗯""对""是的"等短回应时，这是附和，不要停止说话，可以在说完当前句后简短回应
- 用户开始说完整句子时，这是打断，立即停止说话，把控制权还给用户
- 用户沉默时，先留白等待，不要急着填满""",
            tools=[get_interview_context, record_interview_turn],
        )


async def entrypoint(ctx: JobContext):
    agent = InterviewAgent()

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

    await session.generate_reply(
        instructions="向用户问好，说明你是他的私人专访主持人，邀请他开始提问或分享想聊的话题。"
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
