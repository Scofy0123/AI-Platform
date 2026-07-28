// @vitest-environment jsdom

import type { ExecutionPermissionSelection } from "@codexplatform/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PermissionModePicker } from "./PermissionModePicker.js";

afterEach(cleanup);

const OPTIONS = [
  {
    mode: "ASK_FOR_APPROVAL" as const,
    label: "Ask for approval",
    description: "Always ask to edit external files and use the internet",
    available: true,
    unavailableReason: null,
  },
  {
    mode: "APPROVE_FOR_ME" as const,
    label: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe",
    available: true,
    unavailableReason: null,
  },
  {
    mode: "FULL_ACCESS" as const,
    label: "Full access",
    description: "Unrestricted access inside the isolated Worker",
    available: false,
    unavailableReason: "Disabled by organization policy",
  },
];

describe("PermissionModePicker", () => {
  test("shows Codex permission descriptions and the current selection", () => {
    render(
      <PermissionModePicker
        value={{ mode: "ASK_FOR_APPROVAL", profileId: null }}
        options={OPTIONS}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Execution permissions" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("How should Codex actions be approved?")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Ask for approval/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(
      screen.getByText("Always ask to edit external files and use the internet"),
    ).toBeInTheDocument();
  });

  test("selects an available option and closes the menu", () => {
    const onChange = vi.fn();
    render(
      <PermissionModePicker
        value={{ mode: "ASK_FOR_APPROVAL", profileId: null }}
        options={OPTIONS}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Execution permissions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Approve for me/ }));

    expect(onChange).toHaveBeenCalledWith({
      mode: "APPROVE_FOR_ME",
      profileId: null,
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("uses a distinct icon for every permission mode and updates the trigger after selection", () => {
    function StatefulPicker() {
      const [value, setValue] = useState<ExecutionPermissionSelection>({
        mode: "ASK_FOR_APPROVAL",
        profileId: null,
      });
      return <PermissionModePicker value={value} options={OPTIONS} onChange={setValue} />;
    }

    render(<StatefulPicker />);

    const trigger = screen.getByRole("button", { name: "Execution permissions" });
    expect(trigger).toHaveAttribute("data-permission-icon", "hand");

    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: /Ask for approval/ })).toHaveAttribute(
      "data-permission-icon",
      "hand",
    );
    expect(screen.getByRole("menuitem", { name: /Approve for me/ })).toHaveAttribute(
      "data-permission-icon",
      "approval-terminal",
    );
    expect(screen.getByRole("menuitem", { name: /Full access/ })).toHaveAttribute(
      "data-permission-icon",
      "shield-alert",
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Approve for me/ }));
    expect(trigger).toHaveAttribute("data-permission-icon", "approval-terminal");
    expect(trigger).toHaveAttribute("title", "Approve for me");
  });

  test("does not select policy-blocked Full access and shows why", () => {
    const onChange = vi.fn();
    render(
      <PermissionModePicker
        value={{ mode: "ASK_FOR_APPROVAL", profileId: null }}
        options={OPTIONS}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Execution permissions" }));
    expect(screen.getByText("Disabled by organization policy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Full access/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  test("closes on Escape", () => {
    render(
      <PermissionModePicker
        value={{ mode: "ASK_FOR_APPROVAL", profileId: null }}
        options={OPTIONS}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Execution permissions" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("closes when the user clicks outside the menu", () => {
    render(
      <div>
        <PermissionModePicker
          value={{ mode: "ASK_FOR_APPROVAL", profileId: null }}
          options={OPTIONS}
          onChange={vi.fn()}
        />
        <button type="button">Outside</button>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Execution permissions" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
