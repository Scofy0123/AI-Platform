// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { ThreadNavItem } from "./ThreadNavItem.js";

afterEach(cleanup);

function renderItem(status: Parameters<typeof ThreadNavItem>[0]["status"]) {
  render(
    <MemoryRouter>
      <ThreadNavItem id="thread-1" title="真实任务" status={status} />
    </MemoryRouter>,
  );
}

describe("ThreadNavItem", () => {
  test.each(["ALLOCATING", "QUEUED", "RUNNING", "WAITING_APPROVAL"] as const)(
    "shows the Codex running ring for %s",
    (status) => {
      renderItem(status);

      expect(screen.getByRole("status", { name: "任务正在运行" })).toBeInTheDocument();
    },
  );

  test.each(["DRAFT", "READY", "COMPLETED", "FAILED", "INTERRUPTED", "NEEDS_RECOVERY"] as const)(
    "does not show the running ring for %s",
    (status) => {
      renderItem(status);

      expect(screen.queryByRole("status", { name: "任务正在运行" })).not.toBeInTheDocument();
    },
  );
});
