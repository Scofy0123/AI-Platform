import { resolve } from "node:path";
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
  const conversation = page.getByLabel("Thread conversation");
  await expect(page.getByText(`Fake Runtime completed: ${firstPrompt}`)).toBeVisible();
  const firstExecution = conversation.getByRole("button", { name: /^Worked for / }).first();
  await expect(firstExecution).toHaveAttribute("aria-expanded", "false");
  await firstExecution.click();
  await expect(conversation.getByText("已更新计划", { exact: true })).toBeVisible();
  await expect(
    conversation.getByRole("button", { name: /^查看命令 .*printf fake-codexplatform/ }),
  ).toBeVisible();
  await expect(
    conversation.getByRole("button", { name: /^查看工具 .*demo_business_get/ }),
  ).toBeVisible();
  await expect(
    conversation.getByRole("button", { name: "查看文件变更 0 files changed" }),
  ).toBeVisible();
  await expect(conversation.getByRole("status").filter({ hasText: "本轮已完成" })).toBeVisible();

  const secondPrompt = "第二轮继续验证同一 Thread";
  await page.getByLabel("Message Codex").fill(secondPrompt);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page).toHaveURL(threadUrl);
  await expect(page.getByText(secondPrompt, { exact: true })).toBeVisible();
  await expect(page.getByText(`Fake Runtime completed: ${secondPrompt}`)).toBeVisible();
  await expect(conversation.getByText(firstPrompt, { exact: true })).toBeVisible();

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

test("new Thread exposes governed Composer capabilities and submits its Runtime configuration", async ({
  page,
}, testInfo) => {
  await page.goto("/threads/new");

  await page.getByRole("button", { name: "Add files and more" }).click();
  await expect(page.getByRole("menuitem", { name: /Files and folders/ })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: /Goal/ })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: /Plan mode/ })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: /Record a skill/ })).toHaveCount(0);
  if (process.env.CODEXPLATFORM_CAPTURE_UAT === "1") {
    await page.screenshot({ path: testInfo.outputPath("composer-add-menu.png") });
  }
  await page.mouse.click(1000, 40);
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.getByRole("button", { name: "Execution permissions" }).click();
  await expect(page.getByRole("menuitem", { name: /Full access/ })).toBeDisabled();
  if (process.env.CODEXPLATFORM_CAPTURE_UAT === "1") {
    await page.screenshot({ path: testInfo.outputPath("composer-permissions.png") });
  }
  await page.getByRole("menuitem", { name: /Approve for me/ }).click();

  const picker = page.getByRole("button", { name: /Model and Effort:/ });
  await expect(picker).toContainText("Fake Standard");
  await expect(picker).toContainText("medium");
  await picker.click();
  await expect(page.getByRole("listbox", { name: "Runtime models" })).toBeVisible();
  await page.mouse.click(1000, 40);
  await expect(page.getByRole("listbox", { name: "Runtime models" })).toHaveCount(0);
  await picker.click();
  await page.getByRole("option", { name: /Fake Deep/ }).click();
  await expect(picker).toContainText("Fake Deep");
  await expect(picker).toContainText("high");
  await page.getByText("xhigh", { exact: true }).click();
  await expect(picker).toContainText("xhigh");

  await page.getByLabel("Message Codex").fill("E2E selected model and Effort");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/threads\/(?!new$)[^/]+$/);
  await expect(
    page.getByText("Fake Runtime completed: E2E selected model and Effort"),
  ).toBeVisible();

  const threadId = new URL(page.url()).pathname.split("/").at(-1);
  expect(threadId).toBeTruthy();
  const response = await page.request.get(`/api/threads/${threadId}`);
  expect(response.status()).toBe(200);
  const thread = (await response.json()) as {
    turns: Array<{
      model: string | null;
      effort: string | null;
      configSnapshot: { permissionMode: string };
    }>;
  };
  expect(thread.turns).toEqual([
    expect.objectContaining({
      model: "fake-codex-deep",
      effort: "xhigh",
      configSnapshot: expect.objectContaining({
        permissionMode: "APPROVE_FOR_ME",
      }),
    }),
  ]);
});

test("Pinned, Side, and Bottom surfaces coexist while command output stays out of Transcript", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1_000 });
  await page.goto("/threads/new");
  await page.getByLabel("Message Codex").fill("E2E independent workspace surfaces");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Fake Runtime completed: E2E independent workspace surfaces"),
  ).toBeVisible();

  const conversation = page.getByLabel("Thread conversation");
  const rawCommandOutput = "fake-codexplatform";
  await expect(conversation.getByText(rawCommandOutput, { exact: true })).toHaveCount(0);
  await expect(conversation).not.toContainText(e2eCanaries.rawReasoning);
  const initialConversationBox = await conversation.boundingBox();
  expect(initialConversationBox).not.toBeNull();

  await page.getByRole("button", { name: "Toggle pinned summary" }).click();
  const pinned = page.getByRole("complementary", { name: "Pinned execution summary" });
  await expect(pinned).toBeVisible();
  const pinnedConversationBox = await conversation.boundingBox();
  expect(pinnedConversationBox?.width).toBeCloseTo(initialConversationBox?.width ?? 0, 0);

  await page.getByRole("button", { name: "Toggle side panel" }).click();
  const side = page.getByRole("region", { name: "Side panel" });
  await expect(side).toBeVisible();
  const sideConversationBox = await conversation.boundingBox();
  expect(sideConversationBox?.width ?? 0).toBeLessThan(initialConversationBox?.width ?? 0);

  await page.getByRole("button", { name: "Toggle bottom panel" }).click();
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  await expect(bottom).toBeVisible();
  await expect(bottom.getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(bottom.getByRole("tab", { name: /Changes|Files|Tool details/ })).toHaveCount(0);
  await expect(side).toBeVisible();
  await expect(pinned).toBeVisible();
  await expect(bottom).toContainText(rawCommandOutput);

  await page.getByRole("button", { name: "Close pinned summary" }).click();
  await expect(pinned).toHaveCount(0);
  await expect(side).toBeVisible();
  await expect(bottom).toBeVisible();
  await expect(conversation.getByText(rawCommandOutput, { exact: true })).toHaveCount(0);

  const execution = conversation.getByRole("button", { name: /^Worked for / });
  await expect(execution).toHaveAttribute("aria-expanded", "false");
  await execution.click();
  await conversation.getByRole("button", { name: /^查看工具 .*demo_business_get/ }).click();
  await expect(side).toContainText("demo_business_get");
  await expect(side).toContainText("Arguments");
  await conversation.getByRole("button", { name: "查看文件变更 0 files changed" }).click();
  await expect(side).toContainText("0 files changed");
  await expect(bottom.getByRole("tab", { name: "Terminal" })).toBeVisible();
});

test("Settings confirms persistence before reload", async ({ page }) => {
  await page.goto("/settings/general");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Appearance").selectOption("DARK");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已保存" })).toContainText("已保存");
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
  await expect(page.getByText("Queued at position 1", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message Codex")).toBeDisabled();
  await expect(page.getByLabel("Message Codex")).toHaveAttribute("placeholder", "等待运行资源…");
  await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
  await expect(
    page.getByRole("link", { name: /E2E queued Thread/ }).getByRole("status", {
      name: "任务正在运行",
    }),
  ).toBeVisible();
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

test("running Thread matches the Codex shell, message alignment, and Composer control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 949 });
  await page.goto(`/threads/${seededFixture.runningThreadId}`);

  const header = page.locator("header.v11-thread-header");
  await expect(header.getByRole("heading", { name: "E2E running Thread" })).toBeVisible();
  await expect(header.getByRole("button")).toHaveCount(4);
  await expect(header.getByRole("button", { name: "Thread actions" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Toggle pinned summary" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Toggle bottom panel" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Toggle side panel" })).toBeVisible();
  await expect(header.getByText("Live", { exact: true })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "停止" })).toHaveCount(0);

  const prompt = page.getByText("E2E running prompt", { exact: true });
  await expect(prompt).toBeVisible();
  await expect(prompt.locator("xpath=ancestor::article[1]")).toHaveAttribute(
    "data-message-side",
    "right",
  );
  await expect(page.getByRole("button", { name: /^Working for / })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /E2E running Thread/ }).getByRole("status", {
      name: "任务正在运行",
    }),
  ).toBeVisible();

  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();

  const desktopHeaderBox = await header.boundingBox();
  const desktopPromptBox = await prompt.boundingBox();
  const desktopConversationBox = await page.getByLabel("Thread conversation").boundingBox();
  expect(desktopHeaderBox).not.toBeNull();
  expect(desktopPromptBox).not.toBeNull();
  expect(desktopConversationBox).not.toBeNull();
  expect((desktopPromptBox?.x ?? 0) + (desktopPromptBox?.width ?? 0)).toBeGreaterThan(
    (desktopConversationBox?.x ?? 0) + (desktopConversationBox?.width ?? 0) / 2,
  );

  if (process.env.CODEXPLATFORM_CAPTURE_UAT === "1") {
    await page.screenshot({
      path: resolve("docs/research/codex-reference/codexplatform-parity-uat.png"),
      fullPage: true,
    });
  }

  await page.getByLabel("Message Codex").fill("调整执行方向");
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送 Steer" })).toBeVisible();

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(header.getByRole("heading", { name: "E2E running Thread" })).toBeVisible();
  await expect(header.getByRole("button")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "发送 Steer" })).toBeVisible();
  const narrowHeaderBox = await header.boundingBox();
  const narrowComposerBox = await page.locator("form.v11-thread-composer").boundingBox();
  expect(narrowHeaderBox).not.toBeNull();
  expect(narrowComposerBox).not.toBeNull();
  expect(narrowComposerBox?.y ?? 0).toBeGreaterThan(
    (narrowHeaderBox?.y ?? 0) + (narrowHeaderBox?.height ?? 0),
  );
});

test("administrator uses a separate management console", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Open admin console" }).click();
  await expect(page).toHaveURL(/\/admin\/accounts$/);
  await expect(page.getByText("管理后台", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Codex" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex 账号池" })).toBeVisible();
  await expect(page.getByRole("heading", { name: e2eCanaries.accountAlias })).toBeVisible();
  await expect(page.getByText("本周已用 10%")).toBeVisible();
  await expect(page.getByText("剩余 90%")).toBeVisible();
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

test("1280px administrator audit keeps every traceability field and opens a read-only Thread", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/admin/audit");

  const auditEntry = page.locator(".v11-audit-list article", {
    has: page.getByRole("link", { name: `Thread ${seededFixture.threadId}` }),
  });
  await expect(auditEntry.locator('[data-label="Actor"]')).toHaveText(e2eIdentity.name);
  await expect(auditEntry.locator('[data-label="Account"]')).toHaveText(e2eCanaries.accountAlias);
  await expect(auditEntry.locator('[data-label="Thread"]')).toBeVisible();
  await expect(auditEntry.locator('[data-label="Result"]')).toHaveText("SUCCESS");

  const adminThreadResponse = await page.request.get(
    `/api/admin/threads/${seededFixture.threadId}`,
  );
  expect(adminThreadResponse.status()).toBe(200);
  assertNoBrowserLeaks(await adminThreadResponse.text(), []);

  await auditEntry.locator('[data-label="Thread"]').click();
  await expect(page).toHaveURL(new RegExp(`/admin/threads/${seededFixture.threadId}$`));
  await expect(page.getByRole("heading", { name: "E2E seeded private Thread" })).toBeVisible();
  await expect(page.getByText("只读审计视图")).toBeVisible();
  await expect(page.getByLabel("Read-only Thread conversation")).toBeVisible();
  await expect(page.getByLabel("Message Codex")).toHaveCount(0);
});

test("seeded Subagents render Active and Done summaries with inspectable details", async ({
  page,
}) => {
  await page.goto(`/threads/${seededFixture.threadId}`);
  await expect(page.getByRole("heading", { name: "E2E seeded private Thread" })).toBeVisible();
  await page.getByRole("button", { name: "Toggle side panel" }).click();
  const side = page.getByRole("region", { name: "Side panel" });
  await side.getByRole("tab", { name: "Subagents" }).click();

  const active = side.getByRole("heading", { name: "Active" }).locator("..");
  const done = side.getByRole("heading", { name: "Done" }).locator("..");
  await expect(active).toContainText("E2E active researcher");
  await expect(active).toContainText("Inspecting current evidence");
  await expect(done).toContainText("E2E completed reviewer");
  await expect(done).toContainText("Review completed without findings");

  await side.getByRole("button", { name: "Open E2E completed reviewer details" }).click();
  await expect(side.getByRole("heading", { name: "E2E completed reviewer" })).toBeVisible();
  await expect(side.getByText("Review completed without findings", { exact: true })).toBeVisible();
  await expect(side.getByText("DONE", { exact: true })).toBeVisible();
  await expect(side.getByText("Subagent visible detail canary", { exact: true })).toBeVisible();
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
  const adminThreadApi = await page.request.get(`/api/admin/threads/${seededFixture.threadId}`);
  expect(adminThreadApi.status()).toBe(403);
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
