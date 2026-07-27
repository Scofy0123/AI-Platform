import { describe, expect, test } from "vitest";
import { createWorkspaceLayoutState, reduceWorkspaceLayout } from "./workspace-layout.js";

describe("workspace layout", () => {
  test("opens pinned, side and bottom surfaces independently", () => {
    let state = createWorkspaceLayoutState();
    state = reduceWorkspaceLayout(state, { type: "TOGGLE_PINNED" });
    state = reduceWorkspaceLayout(state, {
      type: "OPEN_SIDE",
      tab: { kind: "subagent", id: "agent-1" },
    });
    state = reduceWorkspaceLayout(state, {
      type: "OPEN_BOTTOM",
      tab: "terminal",
      detailId: "command-1",
    });

    expect(state.pinnedSummaryOpen).toBe(true);
    expect(state.sidePanel).toMatchObject({
      open: true,
      tab: { kind: "subagent", id: "agent-1" },
    });
    expect(state.bottomPanel).toMatchObject({
      open: true,
      tab: "terminal",
      detailId: "command-1",
    });
  });

  test("changes one surface without closing the other two", () => {
    let state = createWorkspaceLayoutState({
      pinnedSummaryOpen: true,
      sidePanelOpen: true,
      bottomPanelOpen: true,
    });

    state = reduceWorkspaceLayout(state, { type: "CLOSE_SIDE" });

    expect(state.pinnedSummaryOpen).toBe(true);
    expect(state.sidePanel.open).toBe(false);
    expect(state.bottomPanel.open).toBe(true);
  });

  test("resets resource selections on Thread change but preserves preferred dimensions", () => {
    let state = createWorkspaceLayoutState({
      sidePanelOpen: true,
      bottomPanelOpen: true,
      sidePanelWidth: 420,
      bottomPanelHeight: 360,
    });
    state = reduceWorkspaceLayout(state, {
      type: "OPEN_SIDE",
      tab: { kind: "subagent", id: "agent-1" },
    });
    state = reduceWorkspaceLayout(state, {
      type: "OPEN_BOTTOM",
      tab: "terminal",
      detailId: "command-1",
    });

    state = reduceWorkspaceLayout(state, { type: "RESET_THREAD" });

    expect(state.sidePanel).toEqual({
      open: false,
      tab: { kind: "plan" },
      width: 420,
    });
    expect(state.bottomPanel).toEqual({
      open: false,
      tab: "terminal",
      detailId: null,
      height: 360,
    });
  });

  test("bounds user-resized dock dimensions", () => {
    let state = createWorkspaceLayoutState();
    state = reduceWorkspaceLayout(state, { type: "RESIZE_SIDE", width: 999 });
    state = reduceWorkspaceLayout(state, { type: "RESIZE_BOTTOM", height: 20 });

    expect(state.sidePanel.width).toBe(560);
    expect(state.bottomPanel.height).toBe(180);
  });
});
