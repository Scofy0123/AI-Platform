export function requireSmokeEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the local environment before enabling this real smoke test; never commit the value.`,
    );
  }
  return value;
}

export function rethrowWithoutSecrets(error: unknown, secrets: readonly string[]): never {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  throw new Error(message || "Real smoke test failed without an error message");
}
