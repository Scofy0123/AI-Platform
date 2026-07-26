import { describe, expect, test } from "vitest";
import { PLATFORM_VERSION, TaskDetailSchema, TaskSummarySchema } from "./index.js";

describe("shared contracts scaffold", () => {
  test("exports the platform protocol version", () => {
    expect(PLATFORM_VERSION).toBe("0.1.0");
  });

  test("defines strict shared task summaries and details", () => {
    const summary = {
      id: "task-1",
      projectId: "project-1",
      title: "Summarize the wiki",
      status: "QUEUED",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(TaskSummarySchema.parse(summary)).toEqual(summary);
    expect(
      TaskDetailSchema.parse({
        ...summary,
        prompt: "Read the source and summarize it",
        accountAlias: null,
        queue: { position: 1, etaMs: 600_000, etaEstimated: true },
      }),
    ).toMatchObject({ prompt: "Read the source and summarize it" });
    expect(() => TaskSummarySchema.parse({ ...summary, status: "UNKNOWN" })).toThrow();
    expect(() => TaskDetailSchema.parse({ ...summary, prompt: null })).toThrow();
  });
});
