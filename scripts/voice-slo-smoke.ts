/**
 * Stage-3 mock mouth-to-ear budget smoke (no real audio).
 * Run: npx tsx scripts/voice-slo-smoke.ts
 */
import {
  recordVoiceLatency,
  resetRuntimeMetricsForTests,
  summarizeVoiceLatency
} from "../apps/api/src/observability/runtime-metrics";

resetRuntimeMetricsForTests();

// Simulated cascade segment breakdown within local budget.
for (const ttfa of [420, 510, 580, 640, 890]) {
  recordVoiceLatency({
    path: "cascade",
    ttfaMs: ttfa,
    vadEndToSttMs: 80,
    sttToLlmMs: 40,
    llmTtftMs: Math.max(120, ttfa - 280),
    ttsTtfbMs: 90
  });
}
recordVoiceLatency({
  path: "interrupt",
  interrupted: true,
  bargeInSuccess: true,
  interruptRecovery: true,
  ttfaMs: 120
});
// Phase-0: discrete false-trigger events (no ttfa required).
recordVoiceLatency({ path: "cascade", falseTriggerKind: "quarantine_echo_suspect" });
recordVoiceLatency({ path: "cascade", falseTriggerKind: "max_wait_suppressed" });

const s = summarizeVoiceLatency();
const okP95 = (s.ttfaP95Ms ?? Infinity) <= (s.budgetHint.ttfaP95TargetMs ?? 1200);
const okBarge = (s.bargeInSuccessRate ?? 0) >= 0.9 || s.bargeInSuccessCount >= 1;
const okFalseTrigger =
  s.falseTriggerCount >= 1 &&
  (s.falseTriggerByKind.quarantine_echo_suspect ?? 0) >= 1 &&
  (s.falseTriggerByKind.max_wait_suppressed ?? 0) >= 1;

console.log(
  JSON.stringify(
    {
      ttfaP50Ms: s.ttfaP50Ms,
      ttfaP95Ms: s.ttfaP95Ms,
      budget: s.budgetHint,
      bargeInSuccessRate: s.bargeInSuccessRate,
      interruptRecoveryRate: s.interruptRecoveryRate,
      falseTriggerCount: s.falseTriggerCount,
      falseTriggerByKind: s.falseTriggerByKind,
      segments: s.segments,
      okP95,
      okBarge,
      okFalseTrigger
    },
    null,
    2
  )
);

if (!okP95 || !okBarge || !okFalseTrigger) {
  process.exitCode = 1;
}
