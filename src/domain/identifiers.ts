export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}
