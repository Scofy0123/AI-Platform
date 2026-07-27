import { isAbsolute } from "node:path";

const RAW_REASONING_TRANSPORT_KEYS = new Set([
  "reasoningTextDelta",
  "reasoning_text_delta",
  "encrypted_content",
  "encryptedContent",
]);

const PUBLIC_REASONING_ENVELOPE_KEYS = new Set([
  "type",
  "id",
  "provider",
  "kind",
  "summary",
  "displayable",
  "auditEligible",
]);

export interface RuntimePathRedactionContext {
  runtimeDataDir?: string | null;
  codexHome?: string | null;
  workspaceDir?: string | null;
}

export function sanitizeReasoningTransport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeReasoningTransport);
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  if (source.type === "reasoning") return sanitizeReasoningEnvelope(source);

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    if (RAW_REASONING_TRANSPORT_KEYS.has(key)) continue;
    if (key === "reasoning") {
      const reasoning = sanitizeReasoningEnvelope(nested);
      if (reasoning !== undefined) clean[key] = reasoning;
      continue;
    }
    clean[key] = sanitizeReasoningTransport(nested);
  }
  return clean;
}

export function sanitizeRuntimePathTransport(
  value: unknown,
  context: RuntimePathRedactionContext = {},
): unknown {
  const replacements = runtimePathReplacements(context);
  if (replacements.length === 0) return value;

  const sanitize = (nested: unknown): unknown => {
    if (Array.isArray(nested)) return nested.map(sanitize);
    if (typeof nested === "string") {
      return replacements.reduce(
        (text, [sensitivePath, placeholder]) => text.replaceAll(sensitivePath, placeholder),
        nested,
      );
    }
    if (!nested || typeof nested !== "object") return nested;
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>).map(([key, item]) => [key, sanitize(item)]),
    );
  };

  return sanitize(value);
}

export function sanitizeEventTransport(
  value: unknown,
  context: RuntimePathRedactionContext = {},
): unknown {
  return sanitizeRuntimePathTransport(sanitizeReasoningTransport(value), context);
}

function sanitizeReasoningEnvelope(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!PUBLIC_REASONING_ENVELOPE_KEYS.has(key)) continue;
    clean[key] = sanitizeReasoningTransport(nested);
  }
  return clean;
}

function runtimePathReplacements(
  context: RuntimePathRedactionContext,
): Array<readonly [string, string]> {
  const candidates: Array<readonly [string | null | undefined, string]> = [
    [context.codexHome, "[CODEX_HOME]"],
    [context.workspaceDir, "[WORKSPACE]"],
    [context.runtimeDataDir, "[RUNTIME_DATA]"],
  ];
  return candidates
    .filter(
      (candidate): candidate is readonly [string, string] =>
        typeof candidate[0] === "string" && isAbsolute(candidate[0]) && candidate[0].length > 1,
    )
    .sort((left, right) => right[0].length - left[0].length);
}
