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
    id: "record-a-skill",
    kind: "SKILL_RECORDER",
    section: "ADD",
    label: "Record a skill",
    description: "Record a reusable workflow",
    availability: "UNSUPPORTED",
    unavailableReason: "Requires an isolated Computer Use Worker",
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

describe("ComposerAddMenu", () => {
  test("renders registry sections and capability descriptions", () => {
    render(<ComposerAddMenu capabilities={CAPABILITIES} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add files and more" }));

    expect(screen.getByText("Add")).toBeInTheDocument();
    expect(screen.getByText("Plugins")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Files and folders/ })).toBeInTheDocument();
    expect(screen.getByText("Read, create, and verify PDF files")).toBeInTheDocument();
  });

  test("selects only available capabilities", () => {
    const onSelect = vi.fn();
    render(<ComposerAddMenu capabilities={CAPABILITIES} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Add files and more" }));

    fireEvent.click(screen.getByRole("menuitem", { name: /Record a skill/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("Requires an isolated Computer Use Worker")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Files and folders/ }));
    expect(onSelect).toHaveBeenCalledWith(CAPABILITIES[0]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
