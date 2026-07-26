import { expect, test } from "@playwright/test";
import { e2eIdentity } from "./identity.js";

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: "codexplatform_session",
      value: e2eIdentity.sessionToken,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "codexplatform_csrf",
      value: e2eIdentity.csrfToken,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      sameSite: "Strict",
    },
  ]);
});

test("an admin creates and completes a fake Codex task through the real API and UI", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /E2E 管理员/ })).toBeVisible();
  await page.getByRole("link", { name: "新建任务" }).first().click();
  await page.getByLabel("任务名称").fill("E2E 纵切任务");
  await page.getByLabel("任务说明").fill("生成一个可验证的 Fake Runtime 执行轨迹");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "E2E 纵切任务" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "执行计划" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行命令" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "调用企业工具" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "文件变更" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "任务完成" })).toBeVisible();
  await expect(
    page.getByText("Fake Runtime completed: 生成一个可验证的 Fake Runtime 执行轨迹"),
  ).toBeVisible();

  await page.getByRole("link", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "默认项目" })).toBeVisible();
  await expect(page.getByText("1 个任务")).toBeVisible();

  await page.getByRole("link", { name: "账号池" }).click();
  await expect(page.getByRole("heading", { name: "Codex 账号池" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex A" })).toBeVisible();
  await expect(page.getByText("周额度剩余 90%")).toBeVisible();
  await expect(page.getByText("1 / 4")).toBeVisible();
});
