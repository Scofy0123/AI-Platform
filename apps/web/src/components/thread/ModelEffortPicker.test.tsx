// @vitest-environment jsdom

import type { ModelCatalog } from "@codexplatform/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelEffortPicker } from "./ModelEffortPicker.js";

afterEach(cleanup);

const CATALOG: ModelCatalog = {
  models: [
    {
      id: "codex-standard",
      model: "codex-standard",
      displayName: "Codex Standard",
      description: "Balanced model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { value: "low", description: "Fast" },
        { value: "medium", description: "Balanced" },
        { value: "high", description: "Deep" },
      ],
      inputModalities: ["text"],
      supportsPersonality: false,
    },
  ],
  scope: "SINGLE_ACCOUNT",
  accountCount: 1,
  observedAt: "2026-07-28T00:00:00.000Z",
  stale: false,
};

function renderPicker() {
  render(
    <div>
      <ModelEffortPicker
        catalog={CATALOG}
        value={{ model: "codex-standard", reasoningEffort: "medium" }}
        onChange={vi.fn()}
      />
      <button type="button">Outside</button>
    </div>,
  );
}

describe("ModelEffortPicker", () => {
  test("closes when the user clicks outside the popover", () => {
    renderPicker();
    const trigger = screen.getByRole("button", {
      name: "Model and Effort: Codex Standard · medium",
    });

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox", { name: "Runtime models" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("listbox", { name: "Runtime models" })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("closes on Escape and restores focus to the trigger", () => {
    renderPicker();
    const trigger = screen.getByRole("button", {
      name: "Model and Effort: Codex Standard · medium",
    });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "Runtime models" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
