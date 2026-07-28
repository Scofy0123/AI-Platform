import { describe, expect, test } from "vitest";
import { listComposerCapabilities } from "./composer-capabilities.js";

const BASE_INPUT = {
  stagingAvailable: true,
  goalAvailable: true,
  planModeAvailable: true,
  skillRecorderAvailable: false,
  approvedSkills: [],
  approvedApps: [],
  recentThreads: [],
} as const;

describe("listComposerCapabilities", () => {
  test("reports real Add capabilities and explains unsupported host features", () => {
    const result = listComposerCapabilities(BASE_INPUT);

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "files-and-folders",
          kind: "FILE_PICKER",
          availability: "AVAILABLE",
        }),
        expect.objectContaining({
          id: "goal",
          kind: "GOAL",
          availability: "AVAILABLE",
        }),
        expect.objectContaining({
          id: "plan-mode",
          kind: "PLAN_MODE",
          availability: "AVAILABLE",
        }),
        expect.objectContaining({
          id: "record-a-skill",
          kind: "SKILL_RECORDER",
          availability: "UNSUPPORTED",
          unavailableReason: expect.stringContaining("Computer Use Worker"),
        }),
      ]),
    );
  });

  test("does not infer plugin, app or thread capabilities without approved records", () => {
    const result = listComposerCapabilities(BASE_INPUT);

    expect(result.filter((capability) => capability.section === "PLUGINS")).toEqual([]);
    expect(result.filter((capability) => capability.section === "APPS")).toEqual([]);
    expect(result.filter((capability) => capability.section === "FILES_AND_CHATS")).toEqual([]);
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

  test("adds only server-approved skills, apps and current-user threads", () => {
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

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:pdf", kind: "SKILL", section: "PLUGINS" }),
        expect.objectContaining({
          id: "app:plugin-management",
          kind: "APP",
          section: "APPS",
          availability: "AVAILABLE",
        }),
        expect.objectContaining({
          id: "thread:thread-owned",
          kind: "THREAD_REFERENCE",
          section: "FILES_AND_CHATS",
        }),
      ]),
    );
  });
});
