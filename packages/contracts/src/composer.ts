import { z } from "zod";

const BuiltInExecutionPermissionSelectionSchema = z
  .object({
    mode: z.enum(["ASK_FOR_APPROVAL", "APPROVE_FOR_ME", "FULL_ACCESS"]),
    profileId: z.null(),
  })
  .strict();

const CustomExecutionPermissionSelectionSchema = z
  .object({
    mode: z.literal("CUSTOM"),
    profileId: z.string().trim().min(1),
  })
  .strict();

export const ExecutionPermissionSelectionSchema = z.discriminatedUnion("mode", [
  BuiltInExecutionPermissionSelectionSchema,
  CustomExecutionPermissionSelectionSchema,
]);
export type ExecutionPermissionSelection = z.infer<typeof ExecutionPermissionSelectionSchema>;

export const ExecutionPermissionSchema = z
  .object({
    selection: ExecutionPermissionSelectionSchema,
    sandbox: z.enum(["WORKSPACE_WRITE", "DANGER_FULL_ACCESS", "PERMISSION_PROFILE"]),
    approvalPolicy: z.enum(["ON_REQUEST", "NEVER", "PROFILE"]),
    reviewer: z.enum(["USER", "AUTO_REVIEW", "PROFILE"]),
    source: z.enum(["ORG_DEFAULT", "USER_DEFAULT", "THREAD", "TURN"]),
  })
  .strict();
export type ExecutionPermission = z.infer<typeof ExecutionPermissionSchema>;

export const ComposerCapabilitySchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "FILE_PICKER",
      "GOAL",
      "PLAN_MODE",
      "SKILL_RECORDER",
      "SKILL",
      "APP",
      "THREAD_REFERENCE",
      "ENTERPRISE_RESOURCE",
    ]),
    section: z.enum(["ADD", "PLUGINS", "APPS", "FILES_AND_CHATS"]),
    label: z.string().min(1),
    description: z.string(),
    availability: z.enum(["AVAILABLE", "AUTH_REQUIRED", "POLICY_BLOCKED", "UNSUPPORTED"]),
    unavailableReason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((capability, context) => {
    if (capability.availability === "AVAILABLE" && capability.unavailableReason !== null) {
      context.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "Available capabilities cannot have an unavailable reason",
      });
    }
    if (capability.availability !== "AVAILABLE" && capability.unavailableReason === null) {
      context.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "Unavailable capabilities must explain why they are unavailable",
      });
    }
  });
export type ComposerCapability = z.infer<typeof ComposerCapabilitySchema>;

export const AttachmentScanStatusSchema = z.enum([
  "UPLOADING",
  "SCANNING",
  "READY",
  "BLOCKED",
  "FAILED",
]);
export type AttachmentScanStatus = z.infer<typeof AttachmentScanStatusSchema>;

export const DraftAttachmentSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    kind: z.enum(["FILE", "FOLDER"]),
    name: z.string().min(1),
    relativePath: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\0") &&
          !value.includes("\\") &&
          !/^[A-Za-z]:/.test(value) &&
          !value.split("/").includes(".."),
      ),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    fileCount: z.number().int().positive().max(500),
    scanStatus: AttachmentScanStatusSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type DraftAttachment = z.infer<typeof DraftAttachmentSchema>;

export const EffectiveTurnInputSnapshotSchema = z
  .object({
    prompt: z.string(),
    attachments: z.array(DraftAttachmentSchema).max(32),
    capturedAt: z.iso.datetime(),
  })
  .strict();
export type EffectiveTurnInputSnapshot = z.infer<typeof EffectiveTurnInputSnapshotSchema>;

export const TurnInputBundleSchema = z
  .object({
    prompt: z.string().trim(),
    permission: ExecutionPermissionSelectionSchema,
    planMode: z.boolean(),
    attachmentIds: z.array(z.string().min(1)).max(32),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.prompt.length === 0 && input.attachmentIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "A Turn requires a prompt or at least one attachment",
      });
    }
  });
export type TurnInputBundle = z.infer<typeof TurnInputBundleSchema>;
