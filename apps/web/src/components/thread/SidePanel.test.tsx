// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SidePanelTab } from "../../workspace-layout.js";
import { SidePanel } from "./SidePanel.js";

const PANEL_PROPS = {
  open: true,
  width: 340,
  onClose: vi.fn(),
  renderContent: (tab: SidePanelTab) => <p>{`content:${tab.kind}`}</p>,
} as const;

afterEach(cleanup);

describe("SidePanel", () => {
  test("presents Changes as an Outputs-owned detail view with an explicit return action", () => {
    const onSelect = vi.fn();

    render(
      <SidePanel
        {...PANEL_PROPS}
        tab={{ kind: "changes", detailId: "diff-1" }}
        onSelect={onSelect}
      />,
    );

    const outputsTab = screen.getByRole("tab", { name: "Outputs" });
    const panel = screen.getByRole("tabpanel", { name: "Outputs" });
    expect(outputsTab).toHaveAttribute("aria-selected", "true");
    expect(outputsTab).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", outputsTab.id);
    expect(within(panel).getByRole("heading", { name: "Changes" })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Back to Outputs" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "outputs" });
  });

  test("presents Tool details as a Sources-owned detail view with an explicit return action", () => {
    const onSelect = vi.fn();

    render(
      <SidePanel {...PANEL_PROPS} tab={{ kind: "tool", detailId: "tool-1" }} onSelect={onSelect} />,
    );

    const sourcesTab = screen.getByRole("tab", { name: "Sources" });
    const panel = screen.getByRole("tabpanel", { name: "Sources" });
    expect(sourcesTab).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByRole("heading", { name: "Tool details" })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Back to Sources" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "sources" });
  });

  test("supports roving keyboard navigation across the main tabs", () => {
    function ControlledSidePanel() {
      const [tab, setTab] = useState<SidePanelTab>({ kind: "plan" });
      return <SidePanel {...PANEL_PROPS} tab={tab} onSelect={setTab} />;
    }

    render(<ControlledSidePanel />);

    const planTab = screen.getByRole("tab", { name: "Plan" });
    fireEvent.keyDown(planTab, { key: "ArrowRight" });

    const outputsTab = screen.getByRole("tab", { name: "Outputs" });
    expect(outputsTab).toHaveAttribute("aria-selected", "true");
    expect(outputsTab).toHaveFocus();
    expect(planTab).toHaveAttribute("tabindex", "-1");
  });
});
