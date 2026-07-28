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

export const TurnInputBundleSchema = z
  .object({
    prompt: z.string().trim().min(1),
    permission: ExecutionPermissionSelectionSchema,
    planMode: z.boolean(),
    attachmentIds: z.array(z.string().min(1)).max(32),
  })
  .strict();
export type TurnInputBundle = z.infer<typeof TurnInputBundleSchema>;
