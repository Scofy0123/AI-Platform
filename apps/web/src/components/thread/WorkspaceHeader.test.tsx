// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkspaceHeader } from "./WorkspaceHeader.js";

afterEach(cleanup);

function renderHeader(canArchive = true) {
  const onArchive = vi.fn();
  render(
    <WorkspaceHeader
      title="AI 平台"
      pinnedOpen={false}
      bottomOpen={false}
      bottomAvailable
      sideOpen={false}
      canArchive={canArchive}
      archivePending={false}
      onTogglePinned={vi.fn()}
      onToggleBottom={vi.fn()}
      onToggleSide={vi.fn()}
      onArchive={onArchive}
    />,
  );
  return { onArchive };
}

describe("WorkspaceHeader", () => {
  test("renders the minimal Codex header controls without execution state actions", () => {
    renderHeader();

    expect(screen.getByRole("heading", { name: "AI 平台" })).toBeInTheDocument();
    expect(screen.getByLabelText("当前项目")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle pinned summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle bottom panel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle side panel" })).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Thread" })).not.toBeInTheDocument();
  });

  test("moves Archive into the overflow menu", () => {
    const { onArchive } = renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive Thread" }));

    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  test("does not offer Archive for an active Thread", () => {
    renderHeader(false);

    const trigger = screen.getByRole("button", { name: "Thread actions" });
    fireEvent.click(trigger);
    expect(screen.queryByRole("menuitem", { name: "Archive Thread" })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("closes the Thread menu when the user clicks outside", () => {
    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Toggle pinned summary" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("closes the Thread menu on Escape and restores focus", () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: "Thread actions" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
