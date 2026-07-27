// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SafeMarkdown } from "./SafeMarkdown.js";

afterEach(cleanup);

describe("SafeMarkdown", () => {
  test("renders the Markdown structures used in Codex messages", () => {
    const { container } = render(
      <SafeMarkdown
        content={[
          "# Result",
          "",
          "**Done**",
          "",
          "- first",
          "- second",
          "",
          "`pnpm test`",
          "",
          "| Check | State |",
          "| --- | --- |",
          "| Unit | Pass |",
          "",
          "[OpenAI](https://openai.com)",
          "",
          "[Email](mailto:team@example.com)",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Result" })).toBeInTheDocument();
    expect(screen.getByText("Done")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByRole("list")).toHaveTextContent(/first\s+second/);
    expect(screen.getByText("pnpm test")).toHaveProperty("tagName", "CODE");
    expect(screen.getByRole("table")).toHaveTextContent("UnitPass");
    expect(screen.getByRole("link", { name: "OpenAI" })).toHaveAttribute(
      "href",
      "https://openai.com",
    );
    expect(screen.getByRole("link", { name: "OpenAI" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.getByRole("link", { name: "Email" })).toHaveAttribute(
      "href",
      "mailto:team@example.com",
    );
    expect(container.querySelector("h1")).not.toBeInTheDocument();
    expect(container.querySelector("h2")).not.toBeInTheDocument();
  });

  test("moves cleanly from incomplete to complete streaming Markdown", () => {
    const { rerender } = render(<SafeMarkdown content="Working on **the fix" />);

    expect(screen.getByText("Working on **the fix")).toBeInTheDocument();
    expect(screen.queryByText("the fix")).not.toBeInTheDocument();

    rerender(<SafeMarkdown content="Working on **the fix**" />);

    expect(screen.getByText("the fix")).toHaveProperty("tagName", "STRONG");
    expect(screen.queryByText("Working on **the fix")).not.toBeInTheDocument();
  });

  test("never executes raw HTML, unsafe links, or remote images", () => {
    const { container } = render(
      <SafeMarkdown
        content={[
          '<script>globalThis.__unsafe = "yes"</script>',
          "",
          "[Run](javascript:alert(1))",
          "",
          "[Relative](/admin/accounts)",
          "",
          "![secret diagram](https://attacker.example/track.png)",
        ].join("\n")}
      />,
    );

    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Relative" })).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "图片：secret diagram" })).toBeInTheDocument();
  });
});
