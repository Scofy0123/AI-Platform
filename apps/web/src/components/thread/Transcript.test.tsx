// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TranscriptGroup, TranscriptRow } from "../../thread-presentation.js";
import { Transcript } from "./Transcript.js";

const IDENTITY = {
  threadId: "thread-1",
  turnId: "turn-1",
  sequence: 1,
  timestamp: "2026-07-27T12:00:00.000Z",
} as const;

afterEach(cleanup);

function transcriptGroup(rows: TranscriptRow[]): TranscriptGroup {
  return {
    id: "thread-1:turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
    rows,
    prompt: (rows.find((row) => row.kind === "user") as TranscriptGroup["prompt"]) ?? null,
    executionRows: rows.filter((row) => row.kind !== "user"),
    finalAnswer: null,
    startedAt: "2026-07-27T12:00:00.000Z",
    completedAt: null,
    durationMs: null,
    status: "RUNNING",
    currentAction: "Thinking",
    defaultExpanded: true,
  };
}

describe("Transcript", () => {
  test("renders the user prompt as a right-side bubble without a You label", () => {
    const prompt: TranscriptRow = {
      ...IDENTITY,
      id: "user",
      itemId: "user:turn-1",
      kind: "user",
      text: "修复运行时",
    };
    const group = transcriptGroup([prompt]);
    group.prompt = prompt;
    group.executionRows = [];

    render(
      <Transcript
        groups={[group]}
        onOpenBottom={vi.fn()}
        onOpenSide={vi.fn()}
        renderApproval={() => null}
      />,
    );

    expect(screen.getByText("修复运行时").closest("article")).toHaveAttribute(
      "data-message-side",
      "right",
    );
    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });

  test("renders Steer as the same right-side bubble with a subtle Steer label", () => {
    const steer: TranscriptRow = {
      ...IDENTITY,
      id: "steer",
      itemId: "steer-1",
      kind: "user",
      text: "优先验证交互",
    };
    const group = transcriptGroup([steer]);
    group.prompt = steer;
    group.executionRows = [];

    render(
      <Transcript
        groups={[group]}
        onOpenBottom={vi.fn()}
        onOpenSide={vi.fn()}
        renderApproval={() => null}
      />,
    );

    const bubble = screen.getByText("优先验证交互").closest("article");
    expect(bubble).toHaveAttribute("data-message-side", "right");
    expect(bubble).toHaveAttribute("data-message-kind", "steer");
    expect(screen.getByText("Steer")).toBeInTheDocument();
    expect(screen.queryByText("You · Steer")).not.toBeInTheDocument();
  });

  test("keeps the final answer visible while completed execution details are collapsed", () => {
    const prompt: TranscriptRow = {
      ...IDENTITY,
      id: "user",
      itemId: "user:turn-1",
      kind: "user",
      text: "修复运行时",
    };
    const commentary: TranscriptRow = {
      ...IDENTITY,
      id: "commentary",
      itemId: "commentary-1",
      kind: "assistant",
      messagePhase: "commentary",
      text: "我正在检查运行链路。",
    };
    const finalAnswer: TranscriptRow = {
      ...IDENTITY,
      id: "final",
      itemId: "final-1",
      kind: "assistant",
      messagePhase: "final_answer",
      text: "运行链路已修复。",
    };
    const completed = transcriptGroup([prompt, commentary, finalAnswer]);
    completed.prompt = prompt;
    completed.executionRows = [commentary];
    completed.finalAnswer = finalAnswer;
    completed.completedAt = "2026-07-27T12:00:12.000Z";
    completed.durationMs = 12_000;
    completed.status = "COMPLETED";
    completed.defaultExpanded = false;

    render(
      <Transcript
        groups={[completed]}
        onOpenBottom={vi.fn()}
        onOpenSide={vi.fn()}
        renderApproval={() => null}
      />,
    );

    expect(screen.getByText("修复运行时")).toBeInTheDocument();
    expect(screen.getByText("运行链路已修复。")).toBeInTheDocument();
    expect(screen.queryByText("我正在检查运行链路。")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Worked for 12s" }));

    expect(screen.getByText("我正在检查运行链路。")).toBeInTheDocument();
  });

  test("does not invent a running Turn for thread-scoped runtime notices", () => {
    const notice: TranscriptRow = {
      ...IDENTITY,
      turnId: null,
      id: "runtime-warning",
      itemId: "runtime-warning",
      kind: "status",
      status: "runtime-warning",
      text: "Transport fallback",
    };
    const notices = transcriptGroup([notice]);
    notices.turnId = null;
    notices.prompt = null;
    notices.executionRows = [notice];
    notices.startedAt = null;
    notices.status = "UNKNOWN";

    render(
      <Transcript
        groups={[notices]}
        onOpenBottom={vi.fn()}
        onOpenSide={vi.fn()}
        renderApproval={() => null}
      />,
    );

    expect(screen.getByText("Transport fallback")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Working for/ })).not.toBeInTheDocument();
  });

  test("renders a continuous conversation and opens evidence in dedicated panels", () => {
    const groups: TranscriptGroup[] = [
      transcriptGroup([
        {
          ...IDENTITY,
          id: "user",
          itemId: "user:turn-1",
          kind: "user",
          text: "完成 UAT",
        },
        {
          ...IDENTITY,
          id: "reasoning",
          itemId: "reasoning-1",
          kind: "reasoning-summary",
          text: "先检查配置，再执行验证。",
        },
        {
          ...IDENTITY,
          id: "assistant",
          itemId: "assistant-1",
          kind: "assistant",
          text: "我正在验证工作区。",
        },
        {
          ...IDENTITY,
          id: "command",
          itemId: "command-1",
          kind: "command",
          text: "pnpm test",
          command: "pnpm test",
          cwd: "/repo",
          status: "completed",
          exitCode: 0,
          durationMs: 120,
        },
        {
          ...IDENTITY,
          id: "tool",
          itemId: "tool-1",
          kind: "tool",
          text: "feishu_doc_read",
          tool: "feishu_doc_read",
          status: "completed",
          error: null,
          durationMs: 240,
        },
        {
          ...IDENTITY,
          id: "diff",
          itemId: "diff-1",
          kind: "diff",
          text: "1 file changed",
          changedFiles: 1,
        },
        {
          ...IDENTITY,
          id: "subagent",
          itemId: "subagent-1",
          kind: "subagent",
          text: "代码审查完成",
          agentThreadId: "agent-thread-1",
          name: "Reviewer",
          role: "review",
          status: "DONE",
          resultSummary: "代码审查完成",
        },
      ]),
    ];
    const openBottom = vi.fn();
    const openSide = vi.fn();
    const openSubagent = vi.fn();

    render(
      <Transcript
        groups={groups}
        onOpenBottom={openBottom}
        onOpenSide={openSide}
        onOpenSubagent={openSubagent}
        renderApproval={() => null}
      />,
    );

    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("完成 UAT")).toBeInTheDocument();
    expect(screen.getByText("执行思路")).toBeInTheDocument();
    expect(screen.getByText("我正在验证工作区。")).toBeInTheDocument();
    expect(screen.queryByText("UAT_COMMAND_RAW_OUTPUT")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看命令 已运行 pnpm test 120 ms" }));
    expect(openBottom).toHaveBeenCalledWith("terminal", "command");

    fireEvent.click(screen.getByRole("button", { name: "查看工具 已调用 feishu_doc_read 240 ms" }));
    expect(openSide).toHaveBeenCalledWith({ kind: "tool", detailId: "tool" });

    fireEvent.click(screen.getByRole("button", { name: "查看文件变更 1 file changed" }));
    expect(openSide).toHaveBeenCalledWith({ kind: "changes", detailId: "diff" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "查看子 Agent Reviewer · Done 代码审查完成",
      }),
    );
    expect(openSubagent).toHaveBeenCalledWith("agent-thread-1");
  });

  test("shows nested Subagent activity as read-only when no navigation handler is available", () => {
    const groups: TranscriptGroup[] = [
      transcriptGroup([
        {
          ...IDENTITY,
          id: "nested-subagent",
          itemId: "provider-item-1",
          kind: "subagent",
          text: "Nested review",
          agentThreadId: "nested-agent-thread",
          name: "Nested reviewer",
          role: "review",
          status: "ACTIVE",
          resultSummary: null,
        },
      ]),
    ];

    render(
      <Transcript
        groups={groups}
        onOpenBottom={vi.fn()}
        onOpenSide={vi.fn()}
        renderApproval={() => null}
      />,
    );

    expect(screen.getByText("Nested reviewer · Working")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nested reviewer/ })).not.toBeInTheDocument();
  });

  test("uses safe Markdown for user, assistant, and reasoning summary rows", () => {
    const groups: TranscriptGroup[] = [
      transcriptGroup([
        {
          ...IDENTITY,
          id: "user-markdown",
          itemId: "user:turn-1",
          kind: "user",
          text: "**User request**",
        },
        {
          ...IDENTITY,
          id: "assistant-markdown",
          itemId: "assistant-1",
          kind: "assistant",
          text: "- one\n- two",
        },
        {
          ...IDENTITY,
          id: "reasoning-markdown",
          itemId: "reasoning-1",
          kind: "reasoning-summary",
          text: "`inspect` then [run](javascript:alert(1))",
        },
      ]),
    ];

    render(
      <Transcript
        groups={groups}
        onOpenBottom={vi.fn()}
        onOpenSide={vi.fn()}
        onOpenSubagent={vi.fn()}
        renderApproval={() => null}
        busy
      />,
    );

    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("User request")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByRole("list")).toHaveTextContent(/one\s+two/);
    expect(screen.getByText("inspect")).toHaveProperty("tagName", "CODE");
    expect(screen.queryByRole("link", { name: "run" })).not.toBeInTheDocument();
  });
});
