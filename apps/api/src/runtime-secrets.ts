export function normalizeConfiguredSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function resolveBailianApiKey(
  env: Record<string, string | undefined>
): string | undefined {
  return normalizeConfiguredSecret(env.DASHSCOPE_API_KEY)
    ?? normalizeConfiguredSecret(env.BAILIAN_API_KEY);
}
