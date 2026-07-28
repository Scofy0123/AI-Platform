import { describe, expect, test } from "vitest";
import {
  ComposerCapabilitySchema,
  DraftAttachmentSchema,
  EffectiveTurnInputSnapshotSchema,
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

  test("accepts an attachment-only Turn but rejects a completely empty Turn", () => {
    expect(
      TurnInputBundleSchema.parse({
        prompt: "   ",
        permission: { mode: "ASK_FOR_APPROVAL", profileId: null },
        planMode: false,
        attachmentIds: ["attachment-1"],
      }),
    ).toMatchObject({ prompt: "", attachmentIds: ["attachment-1"] });

    expect(() =>
      TurnInputBundleSchema.parse({
        prompt: "   ",
        permission: { mode: "ASK_FOR_APPROVAL", profileId: null },
        planMode: false,
        attachmentIds: [],
      }),
    ).toThrow();
  });

  test("defines safe attachment and immutable effective input contracts", () => {
    const attachment = DraftAttachmentSchema.parse({
      id: "attachment-1",
      threadId: "thread-1",
      kind: "FILE",
      name: "diagram.png",
      relativePath: ".codexplatform/attachments/attachment-1/diagram.png",
      mimeType: "image/png",
      sizeBytes: 128,
      fileCount: 1,
      scanStatus: "READY",
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    expect(JSON.stringify(attachment)).not.toContain("/private/");
    expect(
      DraftAttachmentSchema.parse({
        ...attachment,
        name: "report..md",
        relativePath: ".codexplatform/attachments/attachment-1/report..md",
      }),
    ).toMatchObject({ name: "report..md" });
    expect(() =>
      DraftAttachmentSchema.parse({
        ...attachment,
        relativePath: ".codexplatform/attachments/../secret.md",
      }),
    ).toThrow();

    expect(
      EffectiveTurnInputSnapshotSchema.parse({
        prompt: "",
        attachments: [attachment],
        capturedAt: "2026-07-28T12:00:01.000Z",
      }),
    ).toMatchObject({
      prompt: "",
      attachments: [{ id: "attachment-1", scanStatus: "READY" }],
    });
  });
});
