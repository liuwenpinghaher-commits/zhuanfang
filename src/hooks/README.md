# App hooks

`App.tsx` 业务钩子逐步下沉到此目录。新增逻辑优先加 hook，避免继续膨胀 App.tsx。

| Hook | 职责 |
|------|------|
| `useOfflineProductSync` | 离线 outbox、三方合并、重连探测 |
| `useSearchBriefActions` | 搜索简报转换/删除/默认供应商 |
| `useCorpusPlaybookActions` | 语料音频选择、insight 删除、playbook apply/revert |
| `useInterviewSessionActions` | 开始/继续/结束/提交回合/控制/丢弃空场 |
| `useRealtimeVoiceControls` | 关闭会话、打断、开关实时录音（cascade/livekit/omni；live 路径） |
| `useInterviewSessionShell` | 会话壳 state + 防重入 guards（未接入 App） |
| `useRealtimeVoiceSession` | 语音 transport 早期骨架（未接入 App；现用 Controls） |
