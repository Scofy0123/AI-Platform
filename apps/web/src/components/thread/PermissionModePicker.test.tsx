// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "Execution permissions" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
