# App hooks

`App.tsx` 业务钩子逐步下沉到此目录。
已有：useRealtimeVoiceSession、useOfflineProductSync、useInterviewSessionShell 等。
新增逻辑优先加 hook，避免继续膨胀 App.tsx。
