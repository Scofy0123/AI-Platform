// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./app.js";
import type { TaskEvent, Thread } from "./types.js";

const session = {
  authenticated: true as const,
  user: { id: "user-1", name: "林可", role: "ADMIN" as const },
};

const projects = [
  { id: "project-1", name: "企业知识助手", taskCount: 3, updatedAt: "2026-07-21T12:00:00.000Z" },
];

const tasks = [
  {
    id: "task-1",
    projectId: "project-1",
    title: "梳理客户成功周报",
    status: "RUNNING" as const,
    updatedAt: "2026-07-21T12:02:00.000Z",
  },
];

function createApi() {
  return {
    getSession: vi.fn().mockResolvedValue(session),
    getBootstrap: vi.fn().mockResolvedValue({
      platformVersion: "0.1.0",
      defaultMode: "CODEX",
      enabledModes: ["CODEX"],
      capabilities: {
        threads: true,
        settings: true,
        subagents: true,
        reasoningSummaries: true,
      },
    }),
    listProjects: vi.fn().mockResolvedValue(projects),
    createProject: vi.fn().mockResolvedValue({ id: "project-created" }),
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn().mockResolvedValue({
      ...tasks[0],
      prompt: "读取飞书知识库并形成摘要",
      accountAlias: "Codex 01",
      queue: null,
    }),
    createTask: vi.fn().mockResolvedValue({ id: "task-created" }),
    startTurn: vi.fn().mockResolvedValue({ status: "RUNNING" }),
    taskAction: vi.fn().mockResolvedValue({ ok: true }),
    getMySettings: vi.fn().mockResolvedValue({
      general: {
        language: "zh-CN",
        theme: "SYSTEM",
        defaultProjectId: null,
        notificationsEnabled: true,
      },
      execution: {
        model: null,
        reasoningEffort: "MEDIUM",
        permissionMode: "DEFAULT",
        approvalPreference: "ASK",
      },
      personalization: { personality: "PRAGMATIC", instructions: "" },
      updatedAt: "2026-07-21T12:00:00.000Z",
      policy: {
        allowedModels: null,
        allowedReasoningEfforts: ["LOW", "MEDIUM", "HIGH"],
        allowedPermissionModes: ["DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"],
        allowedApprovalPreferences: ["ASK"],
        lockedFields: [],
      },
    }),
    patchMySettings: vi.fn(),
    decideApproval: vi.fn().mockResolvedValue({ ok: true }),
    addAccount: vi.fn().mockResolvedValue({ id: "account-created" }),
    listAccounts: vi.fn().mockResolvedValue([
      {
        id: "account-1",
        alias: "Codex 01",
        status: "AVAILABLE",
        activeUsers: 2,
        maxUsers: 4,
        weeklyRemainingPercent: 73,
        health: 98,
      },
    ]),
    accountAction: vi.fn().mockResolvedValue({ ok: true }),
    listAudit: vi.fn().mockResolvedValue([
      {
        id: "audit-1",
        timestamp: "2026-07-21T12:03:00.000Z",
        actorName: "林可",
        action: "TOOL_COMPLETED",
        resource: "飞书文档",
        result: "成功",
        accountAlias: "Codex 01",
      },
    ]),
  };
}

afterEach(cleanup);

describe("CodexPlatform workspace", () => {
  test("offers Feishu SSO without collecting credentials", () => {
    render(<App initialEntries={["/login"]} api={createApi()} />);

    expect(
      screen.getByRole("heading", { name: "让 AI 工作可见、可控、可追溯" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "使用飞书登录" })).toHaveAttribute(
      "href",
      "/api/auth/feishu/start",
    );
    expect(screen.queryByLabelText(/密码|Token|Cookie/i)).not.toBeInTheDocument();
  });

  test("shows projects, recent Threads and the CODEX workspace navigation", async () => {
    render(<App initialEntries={["/"]} api={createApi()} />);

    expect(
      await screen.findByRole("heading", { name: "What do you want to build?" }),
    ).toBeInTheDocument();
    expect((await screen.findAllByText("企业知识助手")).length).toBeGreaterThan(0);
    expect(await screen.findByText("梳理客户成功周报")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Codex workspace" })).toBeInTheDocument();
  });

  test("renders the full Codex task timeline and task controls", async () => {
    const events: TaskEvent[] = [
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 1,
        timestamp: "2026-07-21T12:00:01.000Z",
        type: "PLAN_UPDATED",
        payload: {
          explanation: "先读取资料，再整理结论",
          plan: [{ step: "搜索知识库", status: "completed" }],
        },
      },
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 2,
        timestamp: "2026-07-21T12:00:02.000Z",
        type: "COMMAND_COMPLETED",
        payload: { itemId: "cmd-1", command: "pnpm test", exitCode: 0, durationMs: 820 },
      },
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 3,
        timestamp: "2026-07-21T12:00:03.000Z",
        type: "TOOL_COMPLETED",
        payload: { itemId: "tool-1", tool: "feishu_doc_read", durationMs: 128 },
      },
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 4,
        timestamp: "2026-07-21T12:00:04.000Z",
        type: "DIFF_UPDATED",
        payload: { diff: "+ 本周完成 8 项客户跟进\n- 删除重复条目" },
      },
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 5,
        timestamp: "2026-07-21T12:00:05.000Z",
        type: "APPROVAL_REQUESTED",
        payload: {
          approvalId: "approval-platform-1",
          itemId: "cmd-2",
          approvalType: "COMMAND",
          reason: "需要运行校验命令",
          command: "pnpm verify",
        },
      },
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 6,
        timestamp: "2026-07-21T12:00:06.000Z",
        type: "QUEUED",
        payload: { position: 2, etaMs: 240000, etaEstimated: true },
      },
    ];
    const subscribe = vi.fn(() => () => undefined);

    const api = createApi();
    const turn: Thread["turns"][number] = {
      id: "turn-1",
      threadId: "task-1",
      prompt: "读取飞书知识库并形成摘要",
      status: "RUNNING",
      startedAt: "2026-07-21T12:00:00.000Z",
      completedAt: null,
      durationMs: null,
      model: null,
      effort: "MEDIUM",
      permissionMode: "DEFAULT",
      configSnapshot: {
        model: null,
        reasoningEffort: "MEDIUM",
        permissionMode: "DEFAULT",
        approvalMode: "ASK",
        personality: "PRAGMATIC",
        instructions: "",
        sourceVersion: "test",
      },
    };
    const runtimeApi = {
      ...api,
      getThread: vi.fn().mockResolvedValue({
        id: "task-1",
        projectId: "project-1",
        title: "梳理客户成功周报",
        status: "RUNNING",
        updatedAt: "2026-07-21T12:02:00.000Z",
        currentTurn: turn,
        turns: [turn],
        queue: null,
        items: events.map((event) => ({
          id: event.itemId ?? `event-${event.sequence}`,
          threadId: "task-1",
          turnId: event.turnId,
          sequence: event.sequence,
          type: event.type,
          timestamp: event.timestamp,
          payload: event.payload,
        })),
      } satisfies Thread),
    };
    render(
      <App initialEntries={["/tasks/task-1"]} api={runtimeApi} subscribeToTaskEvents={subscribe} />,
    );

    expect(await screen.findByRole("heading", { name: "梳理客户成功周报" })).toBeInTheDocument();
    expect(await screen.findByText("执行计划")).toBeInTheDocument();
    expect(await screen.findByText("pnpm test")).toBeInTheDocument();
    expect(await screen.findByText("feishu_doc_read")).toBeInTheDocument();
    expect(await screen.findByText("文件变更")).toBeInTheDocument();
    expect(await screen.findByText("等待审批")).toBeInTheDocument();
    expect(screen.getAllByText(/队列第 2 位/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送调整" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await waitFor(() =>
      expect(runtimeApi.decideApproval).toHaveBeenCalledWith("approval-platform-1", "accept"),
    );
  });

  test("coalesces streamed Codex message deltas into one timeline card", async () => {
    const api = createApi();
    const subscribe = vi.fn((_taskId, onEvent) => {
      for (const [index, delta] of ["U", "AT", "_BASIC", "_OK"].entries()) {
        onEvent({
          taskId: "task-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: index + 1,
          timestamp: "2026-07-21T12:00:01.000Z",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-1", delta },
        });
      }
      return () => undefined;
    });

    render(<App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />);

    expect(await screen.findByText("UAT_BASIC_OK")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Codex" })).toHaveLength(1);
  });

  test("keeps streamed Codex messages separate across item and Turn boundaries", async () => {
    const api = createApi();
    const messages = [
      { turnId: "turn-1", itemId: "message-shared", delta: "First" },
      { turnId: "turn-1", itemId: "message-shared", delta: " message" },
      { turnId: "turn-2", itemId: "message-shared", delta: "Second" },
      { turnId: "turn-2", itemId: "message-shared", delta: " message" },
      { turnId: "turn-2", itemId: "message-next", delta: "Third" },
      { turnId: "turn-2", itemId: "message-next", delta: " message" },
    ];
    const subscribe = vi.fn((_taskId, onEvent) => {
      for (const [index, message] of messages.entries()) {
        onEvent({
          taskId: "task-1",
          threadId: "thread-1",
          turnId: message.turnId,
          sequence: index + 1,
          timestamp: "2026-07-21T12:00:01.000Z",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: message.itemId, delta: message.delta },
        });
      }
      return () => undefined;
    });

    render(<App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />);

    expect(await screen.findByText("First message")).toBeInTheDocument();
    expect(screen.getByText("Second message")).toBeInTheDocument();
    expect(screen.getByText("Third message")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Codex" })).toHaveLength(3);
  });

  test("coalesces streamed reasoning and command output by item", async () => {
    const api = createApi();
    const subscribe = vi.fn((_taskId, onEvent) => {
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 1,
        timestamp: "2026-07-21T12:00:01.000Z",
        type: "REASONING_SUMMARY_DELTA",
        payload: { itemId: "reasoning-1", delta: "Inspect" },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 2,
        timestamp: "2026-07-21T12:00:02.000Z",
        type: "REASONING_SUMMARY_DELTA",
        payload: { itemId: "reasoning-1", delta: " context" },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 3,
        timestamp: "2026-07-21T12:00:03.000Z",
        type: "COMMAND_OUTPUT",
        payload: { itemId: "command-1", delta: "line 1\n" },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 4,
        timestamp: "2026-07-21T12:00:04.000Z",
        type: "COMMAND_OUTPUT",
        payload: { itemId: "command-1", delta: "line 2" },
      });
      return () => undefined;
    });

    const view = render(
      <App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />,
    );

    expect(await screen.findByText("Inspect context")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "执行摘要" })).toHaveLength(1);
    expect(view.container.querySelectorAll(".command-output")).toHaveLength(1);
    expect(view.container.querySelector(".command-output")).toHaveTextContent("line 1 line 2");
  });

  test("refreshes task status after a terminal SSE event", async () => {
    const api = createApi();
    api.getTask
      .mockResolvedValueOnce({ ...tasks[0], accountAlias: "Codex 01", queue: null })
      .mockResolvedValue({
        ...tasks[0],
        status: "COMPLETED",
        accountAlias: "Codex 01",
        queue: null,
      });
    const subscribe = vi.fn((_taskId, onEvent) => {
      queueMicrotask(() =>
        onEvent({
          taskId: "task-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 9,
          timestamp: "2026-07-21T12:04:00.000Z",
          type: "TURN_COMPLETED",
          payload: { status: "completed" },
        }),
      );
      return () => undefined;
    });

    render(<App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />);

    expect(await screen.findByRole("heading", { name: "梳理客户成功周报" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "继续" })).toBeEnabled());
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
  });

  test("does not project an old Turn terminal over the currently running Turn", async () => {
    const api = createApi();
    api.getTask
      .mockResolvedValueOnce({ ...tasks[0], accountAlias: "Codex 01", queue: null })
      .mockImplementation(() => new Promise(() => undefined));
    const subscribe = vi.fn((_taskId, onEvent) => {
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-old",
        sequence: 10,
        timestamp: "2026-07-21T12:05:00.000Z",
        type: "TURN_STARTED",
        payload: { status: "inProgress" },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-new",
        sequence: 11,
        timestamp: "2026-07-21T12:05:01.000Z",
        type: "LEASE_ACQUIRED",
        payload: { accountAlias: "Codex 01" },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-old",
        sequence: 12,
        timestamp: "2026-07-21T12:05:02.000Z",
        type: "TURN_FAILED",
        payload: { status: "failed", error: "late old failure" },
      });
      return () => undefined;
    });

    render(<App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />);

    expect(await screen.findByRole("heading", { name: "梳理客户成功周报" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
    expect(screen.getAllByText("执行中").length).toBeGreaterThan(0);
  });

  test("does not project old Turn events over a newly queued Turn", async () => {
    const api = createApi();
    api.getTask
      .mockResolvedValueOnce({ ...tasks[0], accountAlias: "Codex 01", queue: null })
      .mockImplementation(() => new Promise(() => undefined));
    const subscribe = vi.fn((_taskId, onEvent) => {
      onEvent({
        taskId: "task-1",
        threadId: null,
        turnId: null,
        sequence: 20,
        timestamp: "2026-07-21T12:06:00.000Z",
        type: "QUEUED",
        payload: { position: 1, etaMs: 60_000, etaEstimated: true },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-old",
        sequence: 21,
        timestamp: "2026-07-21T12:06:01.000Z",
        type: "TURN_STARTED",
        payload: { status: "inProgress" },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-old",
        sequence: 22,
        timestamp: "2026-07-21T12:06:02.000Z",
        type: "TURN_FAILED",
        payload: { status: "failed", error: "late old failure" },
      });
      return () => undefined;
    });

    render(<App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />);

    expect(await screen.findByRole("heading", { name: "梳理客户成功周报" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("排队中").length).toBeGreaterThan(0));
    expect(screen.getAllByText("队列第 1 位").length).toBeGreaterThan(0);
  });

  test.each(["COMPLETED", "FAILED", "INTERRUPTED", "NEEDS_RECOVERY"] as const)(
    "keeps replayed approvals disabled when the task is %s",
    async (status) => {
      const api = createApi();
      api.getTask
        .mockResolvedValueOnce({
          ...tasks[0],
          status,
          accountAlias: "Codex 01",
          queue: null,
        })
        .mockImplementation(() => new Promise(() => undefined));
      const subscribe = vi.fn((_taskId, onEvent) => {
        onEvent({
          taskId: "task-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 10,
          timestamp: "2026-07-21T12:05:00.000Z",
          type: "APPROVAL_REQUESTED",
          payload: {
            approvalId: "approval-stale-1",
            requestId: "10",
            itemId: "cmd-stale-1",
            approvalType: "COMMAND",
            reason: "这是一条重放的历史审批",
            command: "pnpm verify",
          },
        });
        return () => undefined;
      });

      render(
        <App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />,
      );

      expect(await screen.findByText("这是一条重放的历史审批")).toBeInTheDocument();
      const accept = screen.getByRole("button", { name: "允许一次" });
      const decline = screen.getByRole("button", { name: "拒绝" });
      expect(accept).toBeDisabled();
      expect(decline).toBeDisabled();
      fireEvent.click(accept);
      expect(api.decideApproval).not.toHaveBeenCalled();
    },
  );

  test("does not offer actions for an approval already decided in the replayed timeline", async () => {
    const api = createApi();
    api.getTask.mockResolvedValue({
      ...tasks[0],
      status: "WAITING_APPROVAL",
      accountAlias: "Codex 01",
      queue: null,
    });
    const subscribe = vi.fn((_taskId, onEvent) => {
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 11,
        timestamp: "2026-07-21T12:06:00.000Z",
        type: "APPROVAL_REQUESTED",
        payload: {
          approvalId: "approval-decided-1",
          requestId: "11",
          itemId: "cmd-decided-1",
          approvalType: "COMMAND",
          reason: "这条审批已经处理",
          command: "pnpm test",
        },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 12,
        timestamp: "2026-07-21T12:06:01.000Z",
        type: "APPROVAL_DECIDED",
        payload: {
          approvalId: "approval-decided-1",
          requestId: "11",
          decision: "accept",
        },
      });
      return () => undefined;
    });

    render(<App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />);

    expect(await screen.findByText("这条审批已经处理")).toBeInTheDocument();
    expect(screen.getByText("已允许")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "允许一次" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(api.decideApproval).not.toHaveBeenCalled();
  });

  test("keeps an old Turn approval locked after the task resumes in a new Turn", async () => {
    const api = createApi();
    api.getTask.mockResolvedValue({
      ...tasks[0],
      status: "RUNNING",
      accountAlias: "Codex 01",
      queue: null,
    });
    const subscribe = vi.fn((_taskId, onEvent) => {
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-old",
        sequence: 20,
        timestamp: "2026-07-21T12:10:00.000Z",
        type: "APPROVAL_REQUESTED",
        payload: {
          approvalId: "approval-old-1",
          requestId: "20",
          itemId: "cmd-old-1",
          approvalType: "COMMAND",
          reason: "旧 Turn 的审批",
          command: "pnpm test",
        },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-old",
        sequence: 21,
        timestamp: "2026-07-21T12:10:01.000Z",
        type: "TURN_INTERRUPTED",
        payload: { status: "interrupted" },
      });
      onEvent({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-new",
        sequence: 22,
        timestamp: "2026-07-21T12:11:00.000Z",
        type: "TURN_STARTED",
        payload: { status: "inProgress" },
      });
      return () => undefined;
    });

    render(<App initialEntries={["/tasks/task-1"]} api={api} subscribeToTaskEvents={subscribe} />);

    expect(await screen.findByText("旧 Turn 的审批")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    expect(api.decideApproval).not.toHaveBeenCalled();
  });

  test("creates a task and starts its first turn", async () => {
    const api = createApi();
    render(<App initialEntries={["/tasks/new"]} api={api} />);

    expect(
      await screen.findByRole("heading", { name: "What do you want to build?" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "分析本周核心指标" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
    expect(api.startTurn).toHaveBeenCalledWith("task-created", "分析本周核心指标");
  });

  test("refreshes project and task caches after creating the first task", async () => {
    const api = createApi();
    api.listProjects.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "project-created",
        name: "默认项目",
        taskCount: 1,
        updatedAt: "2026-07-21T12:00:00.000Z",
      },
    ]);
    render(<App initialEntries={["/tasks/new"]} api={api} />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "验证缓存更新" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith("默认项目"));
    await waitFor(() => expect(api.startTurn).toHaveBeenCalled());
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("link", { name: "All projects" }));

    expect((await screen.findAllByText("默认项目")).length).toBeGreaterThan(0);
  });

  test("shows only safe account metadata and the audit trail", async () => {
    const api = createApi();
    const accountsView = render(<App initialEntries={["/admin/accounts"]} api={api} />);

    expect(await screen.findByRole("heading", { name: "Codex 账号池" })).toBeInTheDocument();
    expect(await screen.findByText("2 / 4")).toBeInTheDocument();
    expect(await screen.findByText("周额度剩余 73%")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/@|CODEX_HOME|token|cookie/i);
    fireEvent.click(screen.getByRole("button", { name: "添加账号" }));
    fireEvent.change(screen.getByLabelText("账号别名"), { target: { value: "Codex 02" } });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(api.addAccount).toHaveBeenCalledWith("Codex 02"));

    accountsView.unmount();
    render(<App initialEntries={["/admin/audit"]} api={api} />);
    expect(await screen.findByRole("heading", { name: "审计记录" })).toBeInTheDocument();
    expect(await screen.findByText("飞书文档")).toBeInTheDocument();
    expect(await screen.findByText("TOOL_COMPLETED")).toBeInTheDocument();
  });
});
