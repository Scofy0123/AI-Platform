import { describe, expect, test } from "vitest";
import { listComposerCapabilities } from "./composer-capabilities.js";

const BASE_INPUT = {
  stagingAvailable: true,
  goalAvailable: false,
  goalUnavailableReason: "Goal persistence is not enabled in this build",
  planModeAvailable: false,
  planModeUnavailableReason: "Plan mode is awaiting locked-version protocol validation",
  skillRecorderAvailable: false,
  approvedSkills: [],
  approvedApps: [],
  recentThreads: [],
} as const;

describe("listComposerCapabilities", () => {
  test("returns only the three 1.1A registry entries", () => {
    const result = listComposerCapabilities(BASE_INPUT);

    expect(result.map(({ id, availability }) => ({ id, availability }))).toEqual([
      { id: "files-and-folders", availability: "AVAILABLE" },
      { id: "goal", availability: "UNSUPPORTED" },
      { id: "plan-mode", availability: "UNSUPPORTED" },
    ]);
  });

  test("preserves policy-blocked reasons instead of presenting a false action", () => {
    const result = listComposerCapabilities({
      ...BASE_INPUT,
      stagingAvailable: false,
      stagingUnavailableReason: "Organization file policy blocks uploads",
      planModeAvailable: false,
      planModeUnavailableReason: "Runtime version does not support plan mode",
    });

    expect(result.find((capability) => capability.id === "files-and-folders")).toMatchObject({
      availability: "POLICY_BLOCKED",
      unavailableReason: "Organization file policy blocks uploads",
    });
    expect(result.find((capability) => capability.id === "plan-mode")).toMatchObject({
      availability: "UNSUPPORTED",
      unavailableReason: "Runtime version does not support plan mode",
    });
  });

  test("does not return skill, app, recorder, or thread-reference entries", () => {
    const result = listComposerCapabilities({
      ...BASE_INPUT,
      approvedSkills: [
        { id: "pdf", label: "PDF", description: "Read, create, and verify PDF files" },
      ],
      approvedApps: [
        {
          id: "plugin-management",
          label: "Plugin Management",
          description: "Inspect managed plugins",
          connected: true,
        },
      ],
      recentThreads: [
        { id: "thread-owned", label: "AI产品方案分析", description: "CodexPlatform thread" },
      ],
    });

    expect(result).toHaveLength(3);
  });
});
