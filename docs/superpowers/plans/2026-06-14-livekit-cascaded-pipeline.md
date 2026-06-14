# LiveKit 级联语音管线全量重构计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 LiveKit Agents + livekit-plugins-aliyun 替代当前单链路 S2S 模式和手工级联方案，实现全自动的 ASR→LLM→TTS 语音管线。

**Architecture:** Browser(React + @livekit/react) → WebRTC → LiveKit Server(Go) → Python Agent(livekit-plugins-aliyun: Paraformer STT + Qwen LLM + CosyVoice TTS) → HTTP → Fastify TS Backend(专访逻辑)。

**Tech Stack:** LiveKit Server (Go binary), Python 3.11+ (livekit-agents, livekit-plugins-aliyun), React 18 + @livekit/react-client + @livekit/react-components, Fastify 5 (existing).

---

## 文件结构

### 新建

| 文件 | 职责 | 行数 |
|------|------|------|
| `agent/requirements.txt` | Python 依赖声明 | 4 |
| `agent/main.py` | LiveKit Agent 入口 + AgentSession 配置 | ~60 |
| `agent/interview_tools.py` | Function tools：调用 TS 后端获取专访上下文 | ~50 |
| `src/realtime/livekitVoice.ts` | 浏览器端 LiveKit 连接 + 事件桥接 | ~150 |
| `src/realtime/livekitVoice.test.ts` | livekitVoice 单元测试 | ~100 |
| `scripts/start-livekit.sh` | 一键启动 LiveKit Server 的脚本 | 5 |

### 修改

| 文件 | 改动 | 行数 |
|------|------|------|
| `package.json` | 新增 `@livekit/react-client` `@livekit/react-components` | +3 |
| `src/App.tsx` | `toggleRealtimeRecording` 新增 livekit 分支 | +40 |
| `src/features/interview/InterviewView.tsx` | `voiceTransport` 支持 `"livekit"` 值 | +5 |
| `src/styles.css` | LiveKit 连接状态指示器 | +15 |
| `apps/api/src/routes/realtime-voice.ts` | 新增 `GET /agent-context/:interviewSessionId` 端点 | +40 |
| `apps/api/src/routes/realtime-voice.test.ts` | agent-context 端点测试 | +50 |
| `src/domain/engine.ts` | 导出 `buildInterviewAgentContext()` 函数 | +30 |

### 移除

| 文件 | 原因 |
|------|------|
| `src/realtime/bailianWebsocket.ts` | LiveKit 替代 |
| `src/realtime/bailianWebsocket.test.ts` | LiveKit 替代 |
| `src/realtime/bailianWebrtc.ts` | LiveKit 替代 |
| `src/realtime/bailianWebrtc.test.ts` | LiveKit 替代 |
| `src/realtime/turnDetectors/silenceVadDetector.ts` | LiveKit 内置 |
| `src/realtime/turnDetectors/silenceVadDetector.test.ts` | LiveKit 内置 |
| `src/realtime/turnDetectors/types.ts` | LiveKit 内置 |

### 不改

`bailian.ts`、`types.ts`、`InterviewView.tsx`(结构)、`productApi.ts`、`ConfigView.tsx`、`engine.ts`(核心逻辑)、`packages/db/`、`packages/mastra/`

---

### Task 1: 基础设施 — LiveKit Server + Python 环境

**Files:**
- Create: `agent/requirements.txt`
- Create: `scripts/start-livekit.sh`

- [ ] **Step 1: 安装 LiveKit Server**

```bash
brew install livekit
livekit-server --version
```

Expected: 显示版本号（≥ 1.8）

- [ ] **Step 2: 创建 Python agent 依赖文件**

`agent/requirements.txt`:
```
livekit-agents>=1.13.0
livekit-plugins-aliyun>=1.3.0
python-dotenv>=1.1.0
httpx>=0.28.0
```

- [ ] **Step 3: 创建 Python 虚拟环境并安装依赖**

```bash
python3 -m venv agent/venv
source agent/venv/bin/activate
pip install -r agent/requirements.txt
```

Expected: 全部安装成功，无错误。

- [ ] **Step 4: 创建一键启动脚本**

`scripts/start-livekit.sh`:
```bash
#!/bin/bash
set -e
echo "Starting LiveKit Server (dev mode)..."
livekit-server --dev &
LIVEKIT_PID=$!
echo "LiveKit PID: $LIVEKIT_PID"
sleep 2
echo "Starting Python Agent..."
cd agent && source venv/bin/activate && python main.py dev
```

```bash
chmod +x scripts/start-livekit.sh
```

- [ ] **Step 5: 验证 LiveKit Server 启动**

```bash
livekit-server --dev &
sleep 3
curl http://localhost:7880
kill %1
```

Expected: HTTP 200 或 404（说明服务在运行）。

- [ ] **Step 6: Commit**

```bash
git add agent/requirements.txt scripts/start-livekit.sh
git commit -m "chore: add LiveKit server and Python agent infrastructure"
```

---

### Task 2: TypeScript 后端 — 专访上下文 API

**Files:**
- Modify: `src/domain/engine.ts` (新增函数)
- Modify: `apps/api/src/routes/realtime-voice.ts` (新增端点)
- Create: `apps/api/src/routes/realtime-voice.test.ts` 新增测试

- [ ] **Step 1: 写测试 — agent-context 端点返回完整专访上下文**

`apps/api/src/routes/realtime-voice.test.ts` 末尾追加：

```typescript
test("GET /agent-context/:sessionId returns complete interview context", async ({ server, stateRepo, db }) => {
  const session = createTestInterviewSession(db);
  stateRepo.getInterviewSession.mockResolvedValue(session);

  const res = await server.inject({
    method: "GET",
    url: `/api/realtime-voice/agent-context/${session.id}`
  });

  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.instructions).toContain("你是一个真正的私人专访主持人");
  expect(body.sessionTitle).toBe(session.title);
  expect(body.turnCount).toBe(session.turns.length);
  expect(body.latestUserTurn).toBeDefined();
  expect(body.history).toBeInstanceOf(Array);
});

test("GET /agent-context/:sessionId returns 404 for unknown session", async ({ server, stateRepo }) => {
  stateRepo.getInterviewSession.mockResolvedValue(null);
  const res = await server.inject({
    method: "GET",
    url: "/api/realtime-voice/agent-context/nonexistent"
  });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run apps/api/src/routes/realtime-voice.test.ts
```

Expected: 2 NEW tests FAIL — 端点未实现。

- [ ] **Step 3: 在 engine.ts 中新增 `buildInterviewAgentContext` 函数**

`src/domain/engine.ts` 末尾追加：

```typescript
export interface InterviewAgentContext {
  instructions: string;
  sessionTitle: string;
  turnCount: number;
  latestUserTurn: string | null;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  activeStrategies: string[];
}

export function buildInterviewAgentContext(session: InterviewSession): InterviewAgentContext {
  const instructions = buildRealtimeVoiceInstructions(session);
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const turn of session.turns) {
    if (turn.role === "user" || turn.role === "assistant") {
      history.push({ role: turn.role, text: turn.content });
    }
  }
  const lastUserTurn = [...session.turns].reverse().find(t => t.role === "user");
  const activeStrategies = session.enginePolicy?.appliedPlaybookRules?.slice(0, 5) ?? [];

  return {
    instructions,
    sessionTitle: session.title,
    turnCount: session.turns.length,
    latestUserTurn: lastUserTurn?.content ?? null,
    history: history.slice(-20),
    activeStrategies
  };
}
```

- [ ] **Step 4: 在 realtime-voice.ts 中新增 agent-context 端点**

`apps/api/src/routes/realtime-voice.ts` 中，在所有路由注册之后（`registerVoiceRoutes` 函数内）追加：

```typescript
fastify.get("/api/realtime-voice/agent-context/:interviewSessionId", async (request, reply) => {
  const { interviewSessionId } = request.params as { interviewSessionId: string };
  const stateRepo = options.stateRepo;
  if (!stateRepo) {
    return reply.status(503).send({ error: "state_repo_unavailable" });
  }
  const session = await stateRepo.getInterviewSession(interviewSessionId);
  if (!session) {
    return reply.status(404).send({ error: "session_not_found" });
  }
  const { buildInterviewAgentContext } = await import("../../../../src/domain/engine");
  return buildInterviewAgentContext(session);
});
```

- [ ] **Step 5: 运行测试验证通过**

```bash
npx vitest run apps/api/src/routes/realtime-voice.test.ts
```

Expected: ALL tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/engine.ts apps/api/src/routes/realtime-voice.ts apps/api/src/routes/realtime-voice.test.ts
git commit -m "feat: add agent-context API endpoint for LiveKit Python agent"
```

---

### Task 3: Python Agent — 核心管线

**Files:**
- Create: `agent/main.py`
- Create: `agent/interview_tools.py`

- [ ] **Step 1: 创建 interview_tools.py**

`agent/interview_tools.py`:

```python
import os
import httpx
from livekit.agents import function_tool, RunContext


BACKEND_URL = os.getenv("INTERVIEW_BACKEND_URL", "http://127.0.0.1:8787")


@function_tool()
async def get_interview_context(
    context: RunContext, interview_session_id: str
) -> dict:
    """Fetch the full interview context including instructions, history, and active strategies.
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
```

- [ ] **Step 2: 创建 main.py — 最小可运行 Agent**

`agent/main.py`:

```python
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
from interview_tools import get_interview_context, record_interview_turn

load_dotenv()

INTERVIEW_SESSION_ID = os.getenv("INTERVIEW_SESSION_ID", "")


class InterviewAgent(Agent):
    def __init__(self):
        super().__init__(
            instructions="""你是一个真正的私人专访主持人。
每次只问一个核心问题，优先追具体事件、真实张力和可验证假设。
使用 get_interview_context 获取专访上下文，使用 record_interview_turn 记录对话轮次。
保持回复简洁，每句话不超过两段，不要替用户下结论。""",
        )


async def entrypoint(ctx: JobContext):
    agent = InterviewAgent()

    session = AgentSession(
        stt=aliyun.STT(model="paraformer-realtime-v2"),
        llm=aliyun.LLM(
            model="qwen-plus",
            temperature=0.7,
            max_tokens=1500,
        ),
        tts=aliyun.TTS(
            model="cosyvoice-v2",
            voice="longcheng_v2",
            sample_rate=24000,
            format="pcm",
        ),
    )

    await session.start(agent=agent, room=ctx.room)
    await ctx.connect()

    await session.generate_reply(
        instructions="向用户问好，说明你是他的私人专访主持人，邀请他开始提问或分享想聊的话题。"
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
```

- [ ] **Step 3: 配置环境变量**

创建 `agent/.env`:

```
DASHSCOPE_API_KEY=your_dashscope_key
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
INTERVIEW_BACKEND_URL=http://127.0.0.1:8787
```

- [ ] **Step 4: 启动验证 — 确保 Agent 能连接 LiveKit Server**

```bash
# 终端 1
livekit-server --dev

# 终端 2
cd agent && source venv/bin/activate && python main.py dev
```

Expected: 终端输出 `Agent started` 或类似日志，无 crash。

- [ ] **Step 5: Commit**

```bash
git add agent/main.py agent/interview_tools.py agent/.env.example
git commit -m "feat: add LiveKit Python agent with Aliyun STT/LLM/TTS pipeline"
```

---

### Task 4: 前端 — LiveKit 连接模块

**Files:**
- Create: `src/realtime/livekitVoice.ts`
- Create: `src/realtime/livekitVoice.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 安装依赖**

```bash
npm install @livekit/react-client @livekit/react-components
```

- [ ] **Step 2: 写测试**

`src/realtime/livekitVoice.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLivekitVoiceSession, type LivekitVoiceCallbacks } from "./livekitVoice";

// Mock @livekit/react-client
vi.mock("@livekit/react-client", () => ({
  Room: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    localParticipant: {
      setMicrophoneEnabled: vi.fn(),
      on: vi.fn(),
    },
    remoteParticipants: new Map(),
    state: "disconnected",
  })),
  RoomEvent: {
    Connected: "connected",
    Disconnected: "disconnected",
    TrackSubscribed: "trackSubscribed",
    DataReceived: "dataReceived",
  },
  ConnectionState: {
    Connected: "connected",
  },
}));

describe("createLivekitVoiceSession", () => {
  it("resolves with session controls on successful connect", async () => {
    const callbacks: LivekitVoiceCallbacks = {
      onStateChange: vi.fn(),
      onUserTranscript: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onAudioLevel: vi.fn(),
      onError: vi.fn(),
    };

    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks,
    });

    expect(session).toHaveProperty("startListening");
    expect(session).toHaveProperty("interrupt");
    expect(session).toHaveProperty("close");
    expect(typeof session.startListening).toBe("function");
    expect(typeof session.interrupt).toBe("function");
    expect(typeof session.close).toBe("function");
  });
});
```

- [ ] **Step 3: 运行测试验证失败**

```bash
npx vitest run src/realtime/livekitVoice.test.ts
```

Expected: FAIL — `createLivekitVoiceSession` 未定义。

- [ ] **Step 4: 实现 livekitVoice.ts**

`src/realtime/livekitVoice.ts`:

```typescript
import {
  Room,
  RoomEvent,
  type ConnectionState,
} from "@livekit/react-client";

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

export async function createLivekitVoiceSession(
  options: CreateLivekitVoiceSessionOptions
): Promise<LivekitVoiceSession> {
  const { serverUrl, token, callbacks } = options;
  const room = new Room();

  room.on(RoomEvent.Connected, () => {
    callbacks.onStateChange("connected");
  });

  room.on(RoomEvent.Disconnected, () => {
    callbacks.onStateChange("disconnected");
  });

  room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(payload));
      if (msg.type === "user_transcript") {
        callbacks.onUserTranscript(msg.text, msg.isFinal ?? false);
      } else if (msg.type === "assistant_transcript") {
        callbacks.onAssistantTranscript(msg.text, msg.isFinal ?? false);
      }
    } catch {
      // non-JSON data, ignore
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
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: "interrupt" })),
        { reliable: true }
      );
    },
    close() {
      room.disconnect();
    },
  };
}
```

- [ ] **Step 5: 运行测试验证通过**

```bash
npx vitest run src/realtime/livekitVoice.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/realtime/livekitVoice.ts src/realtime/livekitVoice.test.ts
git commit -m "feat: add LiveKit browser voice connection module"
```

---

### Task 5: 前端 — App.tsx 接入 LiveKit 模式

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 在 App.tsx 顶部新增 import**

```typescript
import { createLivekitVoiceSession, type LivekitVoiceSession } from "./realtime/livekitVoice";
```

- [ ] **Step 2: 在 App 函数内新增 state（紧接 `realtimeVoiceConnection` state 之后）**

```typescript
const [livekitVoiceSession, setLivekitVoiceSession] = useState<LivekitVoiceSession | null>(null);
```

- [ ] **Step 3: 修改 `toggleRealtimeRecording` — 在现有 transport 分支之前插入 livekit 分支**

在 `toggleRealtimeRecording` 函数中，`transport === "websocket"` 判断之前（约第 795 行），插入：

```typescript
// LiveKit 级联模式
const voiceMode = productState.systemConfig.voice.realtimeMode ?? "s2s";
if (voiceMode === "livekit") {
  try {
    setVoiceStatus("connecting");
    const tokenResp = await fetch(`http://127.0.0.1:8787/api/realtime-voice/livekit-token?sessionId=${voiceSession.sessionId}&interviewSessionId=${session?.id ?? ""}`);
    const { token, serverUrl } = await tokenResp.json();

    const livekitSession = await createLivekitVoiceSession({
      serverUrl: serverUrl ?? "ws://127.0.0.1:7880",
      token,
      interviewSessionId: session?.id ?? "",
      callbacks: {
        onStateChange: (state) => {
          if (state === "connected") setVoiceStatus("listening");
          if (state === "disconnected") { setRecording(false); setVoiceStatus("idle"); }
        },
        onUserTranscript: (text, isFinal) => {
          setLiveUserTranscript(isFinal ? "" : text);
          if (!isFinal || !text.trim()) return;
          setSession((prev) => {
            if (!prev) return prev;
            return receiveUserTurn(prev, text);
          });
        },
        onAssistantTranscript: (text, isFinal) => {
          if (!isFinal || !text.trim()) return;
          setSession((prev) => {
            if (!prev) return prev;
            const turns = [...prev.turns];
            const lastIdx = turns.length - 1;
            if (lastIdx >= 0 && turns[lastIdx].role === "assistant") {
              turns[lastIdx] = { ...turns[lastIdx], content: text };
            }
            return { ...prev, turns };
          });
        },
        onAudioLevel: (level) => setAudioLevel(level),
        onError: (err) => {
          setNotice(buildNotice("warning", "语音连接失败", err.message));
        },
      },
    });

    setLivekitVoiceSession(livekitSession);
    setRealtimeVoiceConnection(null);
    setRecording(true);
    setVoiceStatus("listening");
    return;
  } catch {
    setNotice(buildNotice("warning", "LiveKit 连接失败", "请确认 LiveKit Server 和 Python Agent 已启动"));
    return;
  }
}
```

- [ ] **Step 4: 修改录制停止逻辑 — `closeRealtimeVoiceSession` 中处理 livekit**

在 `closeRealtimeVoiceSession` 函数中（约第 245 行）：

```typescript
function closeRealtimeVoiceSession() {
  if (livekitVoiceSession) {
    livekitVoiceSession.close();
    setLivekitVoiceSession(null);
  }
  // ... existing logic
  setRecording(false);
  setVoiceStatus("idle");
  setRealtimeVoiceSession(null);
}
```

- [ ] **Step 5: 修改打断逻辑 — `interruptAssistant` 中处理 livekit**

```typescript
async function interruptAssistant() {
  if (livekitVoiceSession) {
    livekitVoiceSession.interrupt();
    setVoiceStatus("interrupted");
    setTimeout(() => setVoiceStatus("listening"), 1500);
    return;
  }
  // ... existing logic
}
```

- [ ] **Step 6: 运行 TypeScript 编译检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat: integrate LiveKit voice mode into App.tsx"
```

---

### Task 6: 后端 — LiveKit Token 生成端点

**Files:**
- Modify: `apps/api/src/routes/realtime-voice.ts`

- [ ] **Step 1: 安装 livekit-server-sdk**

```bash
npm install livekit-server-sdk
```

- [ ] **Step 2: 在 `realitime-voice.ts` 中新增 token 端点**

```typescript
import { AccessToken } from "livekit-server-sdk";

// 在 registerVoiceRoutes 中追加:
fastify.get("/api/realtime-voice/livekit-token", async (request) => {
  const { sessionId, interviewSessionId } = request.query as {
    sessionId?: string;
    interviewSessionId?: string;
  };
  const roomName = interviewSessionId
    ? `interview-${interviewSessionId}`
    : `session-${sessionId ?? randomUUID()}`;

  const token = new AccessToken(
    process.env.LIVEKIT_API_KEY ?? "devkey",
    process.env.LIVEKIT_API_SECRET ?? "secret",
    {
      identity: `user-${randomUUID()}`,
      name: "Interview User",
    }
  );
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  return {
    token: await token.toJwt(),
    serverUrl: process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880",
    room: roomName,
  };
});
```

- [ ] **Step 3: 运行后端测试**

```bash
npx vitest run apps/api/src/routes/
```

Expected: 现有测试全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/realtime-voice.ts package.json package-lock.json
git commit -m "feat: add LiveKit token generation endpoint"
```

---

### Task 7: 后端 — Agent 记录轮次端点

**Files:**
- Modify: `apps/api/src/routes/realtime-voice.ts`

- [ ] **Step 1: 新增 POST /agent-turn 端点**

```typescript
fastify.post("/api/realtime-voice/agent-turn/:interviewSessionId", async (request, reply) => {
  const { interviewSessionId } = request.params as { interviewSessionId: string };
  const { role, text, strategy } = request.body as {
    role: string;
    text: string;
    strategy?: string;
  };
  const stateRepo = options.stateRepo;
  if (!stateRepo) {
    return reply.status(503).send({ error: "state_repo_unavailable" });
  }
  const session = await stateRepo.getInterviewSession(interviewSessionId);
  if (!session) {
    return reply.status(404).send({ error: "session_not_found" });
  }

  const { receiveUserTurn } = await import("../../../../src/domain/engine");
  const updated = role === "user"
    ? receiveUserTurn(session, text)
    : {
        ...session,
        turns: [
          ...session.turns,
          {
            id: randomUUID(),
            role: "assistant" as const,
            content: text,
            strategy: strategy ?? "",
            createdAt: new Date().toISOString(),
          },
        ],
      };

  await stateRepo.saveInterviewSession(updated);
  return { status: "recorded" };
});
```

- [ ] **Step 2: 运行类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/realtime-voice.ts
git commit -m "feat: add agent-turn recording endpoint for LiveKit agent"
```

---

### Task 8: UI — InterviewView 适配 LiveKit 模式

**Files:**
- Modify: `src/features/interview/InterviewView.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: 在 InterviewViewProps 的 `voiceTransport` 类型中新增 `"livekit"`**

```typescript
voiceTransport: "webrtc" | "websocket" | "livekit" | null;
```

- [ ] **Step 2: 在 transport-badge 渲染中新增 LiveKit 标签**

将现有的 transport-badge 部分（约第 114 行）：

```tsx
{voiceTransport && (
  <span className="transport-badge">
    {voiceTransport === "websocket" ? "WS" : voiceTransport === "livekit" ? "LK" : "RTC"}
  </span>
)}
```

- [ ] **Step 3: 在 App.tsx 中将 voiceTransport 传给 InterviewView**

在 `App.tsx` 中 InterviewView 调用处，传递：

```tsx
voiceTransport={
  livekitVoiceSession ? "livekit"
  : voiceSession?.transport ?? null
}
```

- [ ] **Step 4: CSS — 新增 LiveKit 连接状态**

`src/styles.css` 追加：

```css
.voice-status-label .status-dot.livekit-connecting {
  background: #a855f7;
  animation: pulse 1.5s ease-in-out infinite;
}
.voice-status-label .status-dot.livekit-active {
  background: #22c55e;
  box-shadow: 0 0 8px #22c55e88;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/features/interview/InterviewView.tsx src/App.tsx src/styles.css
git commit -m "feat: add LiveKit transport badge and UI states"
```

---

### Task 9: 系统配置 — 新增 LiveKit 模式选项

**Files:**
- Modify: `apps/api/src/routes/system.ts`

- [ ] **Step 1: 在 system.ts 的 voice 配置段中新增 REALTIME_MODE 项**

在现有 voice 配置 array 中追加：

```typescript
{
  key: "REALTIME_MODE",
  section: "voice",
  label: "实时语音模式",
  valueKind: "select",
  defaultValue: "s2s",
  options: [
    { label: "端到端 (Omni S2S)", value: "s2s" },
    { label: "级联 LiveKit (Paraformer→Qwen→CosyVoice)", value: "livekit" },
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/routes/system.ts
git commit -m "feat: add LiveKit as voice mode option in system config"
```

---

### Task 10: 清理 — 移除旧语音管线文件

**Files:**
- Remove: `src/realtime/bailianWebsocket.ts`
- Remove: `src/realtime/bailianWebsocket.test.ts`
- Remove: `src/realtime/bailianWebrtc.ts`
- Remove: `src/realtime/bailianWebrtc.test.ts`
- Remove: `src/realtime/turnDetectors/silenceVadDetector.ts`
- Remove: `src/realtime/turnDetectors/silenceVadDetector.test.ts`
- Remove: `src/realtime/turnDetectors/types.ts`
- Modify: `src/App.tsx` (移除旧 import)

- [ ] **Step 1: 删除旧文件**

```bash
rm -f src/realtime/bailianWebsocket.ts
rm -f src/realtime/bailianWebsocket.test.ts
rm -f src/realtime/bailianWebrtc.ts
rm -f src/realtime/bailianWebrtc.test.ts
rm -rf src/realtime/turnDetectors/
```

- [ ] **Step 2: 清理 App.tsx 中的旧 import**

移除：
```typescript
import { connectBailianRealtimeWebsocket, type BailianRealtimeWebsocketConnection } from "./realtime/bailianWebsocket";
import { connectBailianRealtimeWebrtc, type BailianRealtimeWebrtcConnection } from "./realtime/bailianWebrtc";
```

- [ ] **Step 3: 清理 App.tsx 中的旧 state**

将：
```typescript
const [realtimeVoiceConnection, setRealtimeVoiceConnection] = useState<BailianRealtimeWebrtcConnection | BailianRealtimeWebsocketConnection | null>(null);
```
替换为：
```typescript
const [realtimeVoiceConnection, setRealtimeVoiceConnection] = useState<LivekitVoiceSession | null>(null);
```

- [ ] **Step 4: 简化 `toggleRealtimeRecording` — 移除旧的 WebSocket/WebRTC 分支**

移除 `toggleRealtimeRecording` 中所有 S2S transport 分支（约 40 行），只保留 livekit 分支和降级 fallback。

- [ ] **Step 5: 运行全量测试**

```bash
npx vitest run
```

Expected: `src/realtime/` 下无旧测试残留，其余测试 PASS。

- [ ] **Step 6: 运行构建**

```bash
npx vite build
```

Expected: 构建成功。

- [ ] **Step 7: Commit**

```bash
git add -A src/realtime/ src/App.tsx
git commit -m "refactor: remove old S2S voice pipeline, replaced by LiveKit"
```

---

### Task 11: 端到端验证

- [ ] **Step 1: 启动全栈**

```bash
# 终端 1: LiveKit Server
livekit-server --dev

# 终端 2: Python Agent
cd agent && source venv/bin/activate && python main.py dev

# 终端 3: TypeScript 后端
npm run dev:api

# 终端 4: 前端
npm run dev
```

- [ ] **Step 2: 验证语音流程**

1. 打开 `http://localhost:5173`
2. 配置页选择 "级联 LiveKit (Paraformer→Qwen→CosyVoice)"
3. 进入专访页，点击语音按钮
4. 验证：浏览器获取麦克风权限，LiveKit 连接成功
5. 验证：声波动画显示，实时转写文本出现
6. 验证：AI 语音回复播放
7. 验证打断：AI 说话时用户开口 → TTS 停止 → 新回复生成

- [ ] **Step 3: 运行全量测试**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: 全部通过。

- [ ] **Step 4: 运行 E2E 测试**

```bash
npx playwright test
```

Expected: 无回归。

---

## 爆炸半径

| 类型 | 文件 | 行数 |
|------|------|------|
| 新建 | `agent/main.py`, `agent/interview_tools.py`, `agent/requirements.txt` | ~115 |
| 新建 | `src/realtime/livekitVoice.ts`, `src/realtime/livekitVoice.test.ts` | ~250 |
| 新建 | `scripts/start-livekit.sh` | 5 |
| 修改 | `src/App.tsx` | +40, -80 (移除旧代码) |
| 修改 | `src/features/interview/InterviewView.tsx` | +5 |
| 修改 | `src/styles.css` | +15 |
| 修改 | `src/domain/engine.ts` | +30 |
| 修改 | `apps/api/src/routes/realtime-voice.ts` | +100 |
| 修改 | `apps/api/src/routes/realtime-voice.test.ts` | +50 |
| 修改 | `apps/api/src/routes/system.ts` | +10 |
| 修改 | `package.json` | +3 |
| 删除 | `bailianWebsocket.ts`, `bailianWebrtc.ts`, `turnDetectors/` | -1200 |
| **净增** | | **~-600 行** |

---
