import { describe, expect, test } from "vitest";
import {
  ComposerCapabilitySchema,
  ExecutionPermissionSelectionSchema,
  TurnInputBundleSchema,
} from "./composer.js";

describe("ExecutionPermissionSelectionSchema", () => {
  test.each(["ASK_FOR_APPROVAL", "APPROVE_FOR_ME", "FULL_ACCESS"] as const)(
    "accepts %s without a profile",
    (mode) => {
      expect(ExecutionPermissionSelectionSchema.parse({ mode, profileId: null })).toEqual({
        mode,
        profileId: null,
      });
    },
  );

  test("requires a profile id for CUSTOM", () => {
    expect(
      ExecutionPermissionSelectionSchema.parse({
        mode: "CUSTOM",
        profileId: "restricted-network",
      }),
    ).toEqual({ mode: "CUSTOM", profileId: "restricted-network" });

    expect(() =>
      ExecutionPermissionSelectionSchema.parse({ mode: "CUSTOM", profileId: null }),
    ).toThrow();
  });

  test("rejects profile ids for built-in modes", () => {
    expect(() =>
      ExecutionPermissionSelectionSchema.parse({
        mode: "ASK_FOR_APPROVAL",
        profileId: "unexpected",
      }),
    ).toThrow();
  });
});

describe("ComposerCapabilitySchema", () => {
  test("requires an unavailable reason whenever a capability is not available", () => {
    expect(() =>
      ComposerCapabilitySchema.parse({
        id: "record-skill",
        kind: "SKILL_RECORDER",
        section: "ADD",
        label: "Record a skill",
        description: "Record a reusable workflow",
        availability: "UNSUPPORTED",
        unavailableReason: null,
      }),
    ).toThrow();
  });
});

describe("TurnInputBundleSchema", () => {
  test("accepts a text-only turn with an explicit permission selection", () => {
    expect(
      TurnInputBundleSchema.parse({
        prompt: "Inspect the repository",
        permission: { mode: "ASK_FOR_APPROVAL", profileId: null },
        planMode: false,
        attachmentIds: [],
      }),
    ).toMatchObject({
      prompt: "Inspect the repository",
      permission: { mode: "ASK_FOR_APPROVAL" },
    });
  });
});
