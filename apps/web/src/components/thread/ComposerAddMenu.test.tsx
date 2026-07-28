// @vitest-environment jsdom

import type { ComposerCapability } from "@codexplatform/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerAddMenu } from "./ComposerAddMenu.js";

afterEach(cleanup);

const CAPABILITIES: ComposerCapability[] = [
  {
    id: "files-and-folders",
    kind: "FILE_PICKER",
    section: "ADD",
    label: "Files and folders",
    description: "Attach files from this device",
    availability: "AVAILABLE",
    unavailableReason: null,
  },
  {
    id: "goal",
    kind: "GOAL",
    section: "ADD",
    label: "Goal",
    description: "Set a goal to keep pursuing",
    availability: "AVAILABLE",
    unavailableReason: null,
  },
  {
    id: "plan-mode",
    kind: "PLAN_MODE",
    section: "ADD",
    label: "Plan mode",
    description: "Turn plan mode on",
    availability: "AVAILABLE",
    unavailableReason: null,
  },
  {
    id: "record-a-skill",
    kind: "SKILL_RECORDER",
    section: "ADD",
    label: "Record a skill",
    description: "Record a reusable workflow",
    availability: "AVAILABLE",
    unavailableReason: null,
  },
  {
    id: "skill:pdf",
    kind: "SKILL",
    section: "PLUGINS",
    label: "PDF",
    description: "Read, create, and verify PDF files",
    availability: "AVAILABLE",
    unavailableReason: null,
  },
];

function renderMenu(overrides: Partial<React.ComponentProps<typeof ComposerAddMenu>> = {}) {
  const props = {
    capabilities: CAPABILITIES,
    onChooseFiles: vi.fn(),
    onOpenGoal: vi.fn(),
    onTogglePlanMode: vi.fn(),
    planMode: false,
    ...overrides,
  };
  render(<ComposerAddMenu {...props} />);
  return props;
}

describe("ComposerAddMenu", () => {
  test("shows only Files, Goal and Plan and hides unsupported product surfaces", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add files and more" }));

    expect(screen.getByRole("menuitem", { name: /Files and folders/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Goal/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /Plan mode/ })).toBeInTheDocument();
    expect(screen.queryByText("Record a skill")).not.toBeInTheDocument();
    expect(screen.queryByText("PDF")).not.toBeInTheDocument();
    expect(screen.queryByText("Plugins")).not.toBeInTheDocument();
  });

  test("opens a files submenu and preserves folder relative paths", () => {
    const props = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add files and more" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Files and folders/ }));

    expect(screen.getByRole("menuitem", { name: "Choose files" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Choose folder" })).toBeInTheDocument();

    const first = new File(["one"], "one.txt", { type: "text/plain" });
    Object.defineProperty(first, "webkitRelativePath", { value: "reports/one.txt" });
    fireEvent.change(screen.getByLabelText("Choose folder input"), {
      target: { files: [first] },
    });

    expect(props.onChooseFiles).toHaveBeenCalledWith([first]);
    expect(first.webkitRelativePath).toBe("reports/one.txt");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add files and more" })).toHaveFocus();
  });

  test("resets the native input so the same file can be selected again", () => {
    const props = renderMenu();
    const file = new File(["same"], "same.txt", { type: "text/plain" });

    fireEvent.click(screen.getByRole("button", { name: "Add files and more" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Files and folders/ }));
    const firstInput = screen.getByLabelText("Choose files input");
    fireEvent.change(firstInput, { target: { files: [file] } });
    expect(firstInput).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Add files and more" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Files and folders/ }));
    const secondInput = screen.getByLabelText("Choose files input");
    fireEvent.change(secondInput, { target: { files: [file] } });

    expect(props.onChooseFiles).toHaveBeenCalledTimes(2);
    expect(secondInput).toHaveValue("");
  });

  test("synchronizes Plan selection and exposes a typed lock reason", () => {
    const props = renderMenu({ planMode: true, planLockedReason: "ACTIVE_TURN" });
    fireEvent.click(screen.getByRole("button", { name: "Add files and more" }));

    const plan = screen.getByRole("menuitemcheckbox", { name: /Plan mode/ });
    expect(plan).toHaveAttribute("aria-checked", "true");
    expect(plan).toBeDisabled();
    expect(screen.getByText("当前 Turn 执行中，Plan mode 已锁定")).toBeInTheDocument();
    fireEvent.click(plan);
    expect(props.onTogglePlanMode).not.toHaveBeenCalled();
  });

  test("closes on selection, outside click and Escape and returns focus", () => {
    const props = renderMenu();
    const trigger = screen.getByRole("button", { name: "Add files and more" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /Goal/ }));
    expect(props.onOpenGoal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("keeps only one Composer popover open at a time", () => {
    const props = {
      capabilities: CAPABILITIES,
      onChooseFiles: vi.fn(),
      onOpenGoal: vi.fn(),
      onTogglePlanMode: vi.fn(),
      planMode: false,
    };
    render(
      <>
        <ComposerAddMenu {...props} />
        <ComposerAddMenu {...props} />
      </>,
    );

    const triggers = screen.getAllByRole("button", { name: "Add files and more" });
    fireEvent.click(triggers[0] as HTMLElement);
    expect(screen.getAllByRole("menu")).toHaveLength(1);

    fireEvent.click(triggers[1] as HTMLElement);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });
});
