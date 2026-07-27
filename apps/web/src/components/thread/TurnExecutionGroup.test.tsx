// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TranscriptGroup } from "../../thread-presentation.js";
import { TurnExecutionGroup } from "./TurnExecutionGroup.js";

function group(overrides: Partial<TranscriptGroup> = {}): TranscriptGroup {
  return {
    id: "thread-1:turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
    rows: [],
    prompt: null,
    executionRows: [],
    finalAnswer: null,
    startedAt: "2026-07-27T12:00:00.000Z",
    completedAt: null,
    durationMs: null,
    status: "RUNNING",
    currentAction: "Thinking",
    defaultExpanded: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T12:00:12.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TurnExecutionGroup", () => {
  test("shows a live elapsed timer and current Codex action while running", () => {
    render(
      <TurnExecutionGroup group={group()}>
        <p>Inspecting the runtime</p>
      </TurnExecutionGroup>,
    );

    expect(screen.getByRole("button", { name: "Working for 12s · Thinking" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Inspecting the runtime")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2_000));

    expect(screen.getByRole("button", { name: "Working for 14s · Thinking" })).toBeInTheDocument();
  });

  test("collapses a completed process and allows the user to inspect it", () => {
    render(
      <TurnExecutionGroup
        group={group({
          completedAt: "2026-07-27T12:00:12.000Z",
          durationMs: 12_000,
          status: "COMPLETED",
          defaultExpanded: false,
        })}
      >
        <p>Completed process</p>
      </TurnExecutionGroup>,
    );

    const toggle = screen.getByRole("button", { name: "Worked for 12s" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Completed process")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Completed process")).toBeInTheDocument();
  });

  test.each(["FAILED", "INTERRUPTED", "NEEDS_RECOVERY"] as const)(
    "keeps %s execution details expanded",
    (status) => {
      render(
        <TurnExecutionGroup
          group={group({
            completedAt: "2026-07-27T12:00:12.000Z",
            durationMs: 12_000,
            status,
            defaultExpanded: true,
          })}
        >
          <p>Failure evidence</p>
        </TurnExecutionGroup>,
      );

      expect(screen.getByRole("button", { name: "Worked for 12s" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByText("Failure evidence")).toBeInTheDocument();
    },
  );
});
