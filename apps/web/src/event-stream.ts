import type { TaskEvent } from "@codexplatform/contracts";

interface SubscriptionOptions {
  fetcher?: typeof fetch;
  initialLastEventId?: number;
  reconnectDelayMs?: number;
  onConnectionChange?: (state: "connecting" | "connected" | "reconnecting") => void;
}

interface ParsedSseEvent {
  id: string | null;
  data: string;
}

export function subscribeTaskEvents(
  taskId: string,
  onEvent: (event: TaskEvent) => void,
  options: SubscriptionOptions = {},
): () => void {
  const fetcher = options.fetcher ?? fetch;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  const abortController = new AbortController();
  let stopped = false;
  let lastEventId = options.initialLastEventId ?? 0;

  const run = async (): Promise<void> => {
    options.onConnectionChange?.("connecting");

    while (!stopped) {
      try {
        const response = await fetcher(`/api/threads/${encodeURIComponent(taskId)}/events`, {
          credentials: "include",
          headers: {
            Accept: "text/event-stream",
            "Last-Event-ID": String(lastEventId),
          },
          signal: abortController.signal,
        });

        if (!response.ok) {
          if (response.status === 401 || response.status === 403 || response.status === 404) return;
          throw new Error(`SSE request failed: ${response.status}`);
        }

        options.onConnectionChange?.("connected");
        await consumeSse(response, (parsed) => {
          const event = JSON.parse(parsed.data) as TaskEvent;
          const sequenceFromId = parsed.id ? Number.parseInt(parsed.id, 10) : Number.NaN;
          const sequence = Number.isFinite(sequenceFromId) ? sequenceFromId : event.sequence;

          if (sequence <= lastEventId) return;
          lastEventId = sequence;
          onEvent(event);
        });
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
      }

      if (!stopped) {
        options.onConnectionChange?.("reconnecting");
        await delay(reconnectDelayMs, abortController.signal);
      }
    }
  };

  void run();

  return () => {
    stopped = true;
    abortController.abort();
  };
}

async function consumeSse(
  response: Response,
  onEvent: (event: ParsedSseEvent) => void,
): Promise<void> {
  if (!response.body) return;

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += value ?? "";

    const chunks = buffer.replaceAll("\r\n", "\n").split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const event = parseSseChunk(chunk);
      if (event) onEvent(event);
    }

    if (done) break;
  }

  const event = parseSseChunk(buffer);
  if (event) onEvent(event);
}

function parseSseChunk(chunk: string): ParsedSseEvent | null {
  let id: string | null = null;
  const data: string[] = [];

  for (const line of chunk.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }

  return data.length > 0 ? { id, data: data.join("\n") } : null;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}
