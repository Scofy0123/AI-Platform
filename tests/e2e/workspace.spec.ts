import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { e2eWebUrl } from "./config.js";
import {
  type E2eIdentity,
  e2eCanaries,
  e2eIdentity,
  e2eMemberIdentity,
  seededFixture,
} from "./identity.js";

const browserLeakPatterns = [
  e2eCanaries.accountAlias,
  e2eCanaries.codexHome,
  e2eCanaries.credentialSecret,
  e2eCanaries.rawReasoning,
  e2eCanaries.encryptedReasoning,
  "reasoningTextDelta",
  "encrypted_content",
];

test.beforeEach(async ({ context }) => {
  await authenticate(context, e2eIdentity);
});

test("Codex workspace completes two Turns in the same Thread with distinct Item boundaries", async ({
  page,
}, testInfo) => {
  const browserMessages = collectBrowserMessages(page);
  await page.goto("/");

  await expect(page).toHaveURL(/\/threads\/new$/);
  await expect(page.getByRole("link", { name: "New chat" })).toBeVisible();
  await expect(page.getByText(e2eIdentity.name)).toBeVisible();
  await expect(page.getByText("ChatGPT", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Work", { exact: true })).toHaveCount(0);

  const firstPrompt = "E2E Codex 连续对话验证";
  await page.getByLabel("Message Codex").fill(firstPrompt);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page).not.toHaveURL(/\/threads\/new$/);
  await expect(page).toHaveURL(/\/threads\/(?!new$)[^/]+$/);
  const threadUrl = page.url();
  const threadId = new URL(threadUrl).pathname.split("/").at(-1);
  expect(threadId).toBeTruthy();
  await expect(page.getByRole("heading", { name: firstPrompt })).toBeVisible();
  await expect(page.getByRole("heading", { name: "执行计划" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行命令" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "调用企业工具" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "文件变更" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "任务完成" })).toBeVisible();
  await expect(page.getByText(`Fake Runtime completed: ${firstPrompt}`)).toBeVisible();

  const secondPrompt = "第二轮继续验证同一 Thread";
  await page.getByLabel("Message Codex").fill(secondPrompt);
  await page.getByRole("button", { name: "发送调整" }).click();
  await expect(page).toHaveURL(threadUrl);
  await expect(page.getByText(secondPrompt, { exact: true })).toBeVisible();
  await expect(page.getByText(`Fake Runtime completed: ${secondPrompt}`)).toBeVisible();
  await expect(
    page.getByLabel("Thread conversation").getByText(firstPrompt, { exact: true }),
  ).toBeVisible();

  const response = await page.request.get(`/api/threads/${threadId}`);
  expect(response.status()).toBe(200);
  const thread = (await response.json()) as {
    turns: Array<{ id: string }>;
    items: Array<{ id: string; threadId: string; turnId: string | null; type: string }>;
  };
  expect(thread.turns).toHaveLength(2);
  expect(new Set(thread.turns.map((turn) => turn.id)).size).toBe(2);
  const itemIdsByTurn = new Map(
    thread.turns.map((turn) => [
      turn.id,
      new Set(thread.items.filter((item) => item.turnId === turn.id).map((item) => item.id)),
    ]),
  );
  for (const turn of thread.turns) {
    const turnItems = thread.items.filter((item) => item.turnId === turn.id);
    expect(turnItems.length).toBeGreaterThan(0);
    expect(itemIdsByTurn.get(turn.id)?.size).toBeGreaterThan(3);
    expect(turnItems.every((item) => item.threadId === threadId)).toBe(true);
    expect(turnItems.some((item) => item.type === "TURN_COMPLETED")).toBe(true);
    const commandItems = turnItems.filter((item) => item.type.startsWith("COMMAND_"));
    expect(new Set(commandItems.map((item) => item.id)).size).toBe(1);
  }
  const firstTurn = thread.turns[0];
  const secondTurn = thread.turns[1];
  expect(firstTurn).toBeDefined();
  expect(secondTurn).toBeDefined();
  const firstItemIds = itemIdsByTurn.get(firstTurn?.id ?? "");
  const secondItemIds = itemIdsByTurn.get(secondTurn?.id ?? "");
  expect(firstItemIds).toBeDefined();
  expect(secondItemIds).toBeDefined();
  if (!firstItemIds || !secondItemIds) throw new Error("Turn Item boundaries were not projected");
  expect([...firstItemIds].filter((itemId) => secondItemIds.has(itemId))).toEqual([]);
  assertNoBrowserLeaks(JSON.stringify(thread), browserMessages);

  if (process.env.CODEXPLATFORM_CAPTURE_UAT === "1") {
    await page.screenshot({ path: testInfo.outputPath("thread-workspace.png") });
  }
});

test("Settings confirms persistence before reload", async ({ page }) => {
  await page.goto("/settings/general");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Appearance").selectOption("DARK");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await page.reload();
  await expect(page.getByLabel("Appearance")).toHaveValue("DARK");
});

test("Settings fails closed when current settings cannot be loaded", async ({ page }) => {
  await page.route("**/api/me/settings", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "E2E settings unavailable" }),
    });
  });
  await page.goto("/settings/general");
  await expect(
    page.getByText("无法读取个人设置。为避免覆盖已有配置，编辑功能已暂停。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
});

test("queued Thread disables the composer and cannot submit another Turn", async ({ page }) => {
  let turnSubmissions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/threads\/[^/]+\/turns$/.test(request.url())) {
      turnSubmissions += 1;
    }
  });

  await page.goto(`/threads/${seededFixture.queuedThreadId}`);
  await expect(page.getByText("排队中", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message Codex")).toBeDisabled();
  await expect(page.getByLabel("Message Codex")).toHaveAttribute("placeholder", "等待运行资源…");
  await expect(page.getByRole("button", { name: "发送调整" })).toBeDisabled();
  await page.locator("form.v11-thread-composer").evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
  });
  expect(turnSubmissions).toBe(0);

  const response = await page.request.get(`/api/threads/${seededFixture.queuedThreadId}`);
  expect(response.status()).toBe(200);
  const thread = (await response.json()) as {
    turns: Array<{ id: string; status: string }>;
    queue: { position: number } | null;
  };
  expect(thread.turns).toEqual([
    expect.objectContaining({ id: seededFixture.queuedTurnId, status: "QUEUED" }),
  ]);
  expect(thread.queue?.position).toBe(1);
});

test("administrator uses a separate management console", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Open admin console" }).click();
  await expect(page).toHaveURL(/\/admin\/accounts$/);
  await expect(page.getByText("管理后台", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Codex" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex 账号池" })).toBeVisible();
  await expect(page.getByRole("heading", { name: e2eCanaries.accountAlias })).toBeVisible();
  await expect(page.getByText("周额度剩余 90%")).toBeVisible();
  await expect(page.getByText(/^\d \/ 4$/)).toBeVisible();

  await page.getByRole("link", { name: "Policies" }).click();
  await expect(page.getByRole("heading", { name: "Policies" })).toBeVisible();
  await expect(
    page.getByText("User and role directory management is not connected in 1.1A."),
  ).toBeVisible();

  if (process.env.CODEXPLATFORM_CAPTURE_UAT === "1") {
    await page.screenshot({ path: testInfo.outputPath("admin-console.png") });
  }
});

test("seeded Subagents render Active and Done summaries with inspectable details", async ({
  page,
}) => {
  await page.goto(`/threads/${seededFixture.threadId}`);
  await expect(page.getByRole("heading", { name: "E2E seeded private Thread" })).toBeVisible();
  await page.getByRole("tab", { name: "Subagents" }).click();

  const active = page.getByRole("heading", { name: "Active" }).locator("..");
  const done = page.getByRole("heading", { name: "Done" }).locator("..");
  await expect(active).toContainText("E2E active researcher");
  await expect(active).toContainText("Inspecting current evidence");
  await expect(done).toContainText("E2E completed reviewer");
  await expect(done).toContainText("Review completed without findings");

  await page.getByRole("button", { name: "Open E2E completed reviewer details" }).click();
  await expect(page.getByRole("heading", { name: "E2E completed reviewer" })).toBeVisible();
  await expect(page.getByText("Review completed without findings", { exact: true })).toBeVisible();
  await expect(page.getByText("DONE", { exact: true })).toBeVisible();
  await expect(page.getByText("Subagent visible detail canary", { exact: true })).toBeVisible();
});

test("MEMBER has no admin affordance and cannot access admin or another user's Thread tree", async ({
  context,
  page,
}) => {
  await authenticate(context, e2eMemberIdentity);
  await page.goto("/");
  await expect(page.getByText(e2eMemberIdentity.name)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open admin console" })).toHaveCount(0);

  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: "无权访问管理功能" })).toBeVisible();

  const adminApi = await page.request.get("/api/admin/accounts");
  expect(adminApi.status()).toBe(403);
  await expectNotFound(page, `/api/threads/${seededFixture.threadId}`);
  await expectNotFound(page, `/api/threads/${seededFixture.threadId}/subagents`);
  await expectNotFound(page, `/api/subagents/${seededFixture.doneSubagentId}`);
  const sse = await page.request.get(`/api/threads/${seededFixture.threadId}/events`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(sse.status()).toBe(404);
  expect(await sse.text()).not.toContain("Subagent visible detail canary");
});

test("user Thread JSON, replay, DOM, and console exclude runtime and reasoning canaries", async ({
  page,
}) => {
  const browserMessages = collectBrowserMessages(page);
  await page.goto(`/threads/${seededFixture.threadId}`);
  await expect(page.getByRole("heading", { name: "E2E seeded private Thread" })).toBeVisible();
  await expect(page.getByText("E2E persisted steer instruction", { exact: true })).toBeVisible();

  const threadResponse = await page.request.get(`/api/threads/${seededFixture.threadId}`);
  const replayResponse = await page.request.get(`/api/threads/${seededFixture.threadId}/events`);
  const subagentsResponse = await page.request.get(
    `/api/threads/${seededFixture.threadId}/subagents`,
  );
  const detailResponse = await page.request.get(`/api/subagents/${seededFixture.doneSubagentId}`);
  const responseBodies: string[] = [];
  for (const response of [threadResponse, replayResponse, subagentsResponse, detailResponse]) {
    expect(response.status()).toBe(200);
    const body = await response.text();
    responseBodies.push(body);
    assertNoBrowserLeaks(body, browserMessages);
  }
  expect(responseBodies[0]).toContain('"type":"USER_MESSAGE"');
  expect(responseBodies[0]).toContain("E2E persisted steer instruction");
  expect(responseBodies[1]).toContain('"type":"USER_MESSAGE"');
  const stream = await readSseReplay(page, seededFixture.threadId);
  expect(stream.status).toBe(200);
  expect(stream.text).toContain("event: USER_MESSAGE");
  expect(stream.text).toContain("E2E persisted steer instruction");
  expect(stream.text).toContain("event: TURN_COMPLETED");
  assertNoBrowserLeaks(stream.text, browserMessages);
  assertNoBrowserLeaks(await page.locator("body").innerText(), browserMessages);
});

async function authenticate(context: BrowserContext, identity: E2eIdentity): Promise<void> {
  await context.clearCookies();
  await context.addCookies([
    {
      name: "codexplatform_session",
      value: identity.sessionToken,
      url: e2eWebUrl,
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "codexplatform_csrf",
      value: identity.csrfToken,
      url: e2eWebUrl,
      httpOnly: false,
      sameSite: "Strict",
    },
  ]);
}

async function expectNotFound(page: Page, path: string): Promise<void> {
  const response = await page.request.get(path);
  expect(response.status()).toBe(404);
}

function collectBrowserMessages(page: Page): string[] {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  page.on("pageerror", (error) => messages.push(error.message));
  return messages;
}

async function readSseReplay(
  page: Page,
  threadId: string,
): Promise<{ status: number; text: string }> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { headers: { Accept: "text/event-stream" } });
    if (!response.body) return { status: response.status, text: "" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: TURN_COMPLETED")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    return { status: response.status, text };
  }, `/api/threads/${threadId}/events`);
}

function assertNoBrowserLeaks(...values: Array<string | string[]>): void {
  const combined = values.flat().join("\n");
  for (const pattern of browserLeakPatterns) expect(combined).not.toContain(pattern);
}
