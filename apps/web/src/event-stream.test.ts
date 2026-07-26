// @vitest-environment jsdom

import { waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { subscribeTaskEvents } from "./event-stream.js";

describe("task SSE subscription", () => {
  test("reconnects with Last-Event-ID and de-duplicates replayed events", async () => {
    const event = {
      taskId: "task-1",
      threadId: "thread-1",
      turnId: "turn-1",
      sequence: 18,
      timestamp: "2026-07-21T12:00:00.000Z",
      type: "TURN_STARTED",
      payload: { status: "inProgress" },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(`id: 18\nevent: task\ndata: ${JSON.stringify(event)}\n\n`),
      )
      .mockResolvedValue(new Response("", { status: 200 }));
    const onEvent = vi.fn();

    const stop = subscribeTaskEvents("task-1", onEvent, {
      fetcher,
      initialLastEventId: 17,
      reconnectDelayMs: 1,
    });

    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/threads/task-1/events");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { "Last-Event-ID": "17" },
    });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { "Last-Event-ID": "18" },
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event);

    stop();
  });
});
