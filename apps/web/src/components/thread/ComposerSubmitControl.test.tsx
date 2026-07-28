// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSubmitControl } from "./ComposerSubmitControl.js";

afterEach(cleanup);

describe("ComposerSubmitControl", () => {
  test("renders a white circular stop control for a running empty Composer", () => {
    const onStop = vi.fn();
    render(<ComposerSubmitControl mode="stop" disabled={false} onStop={onStop} />);

    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop).toHaveAttribute("type", "button");
    expect(stop).toHaveClass("v11-composer-stop");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("renders the submit arrow for Steer or a new Turn", () => {
    const { rerender } = render(
      <ComposerSubmitControl mode="send" disabled={false} onStop={vi.fn()} steer />,
    );

    expect(screen.getByRole("button", { name: "发送 Steer" })).toHaveAttribute("type", "submit");

    rerender(<ComposerSubmitControl mode="send" disabled onStop={vi.fn()} steer={false} />);
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
  });
});
