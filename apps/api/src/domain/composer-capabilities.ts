import { type ComposerCapability, ComposerCapabilitySchema } from "@codexplatform/contracts";

interface CatalogItem {
  id: string;
  label: string;
  description: string;
}

interface AppCatalogItem extends CatalogItem {
  connected: boolean;
}

export interface ComposerCapabilityContext {
  stagingAvailable: boolean;
  stagingUnavailableReason?: string;
  goalAvailable: boolean;
  goalUnavailableReason?: string;
  goalUnavailableReasonCode?: string;
  planModeAvailable: boolean;
  planModeUnavailableReason?: string;
  skillRecorderAvailable: boolean;
  skillRecorderUnavailableReason?: string;
  approvedSkills: readonly CatalogItem[];
  approvedApps: readonly AppCatalogItem[];
  recentThreads: readonly CatalogItem[];
}

export function listComposerCapabilities(context: ComposerCapabilityContext): ComposerCapability[] {
  const capabilities: ComposerCapability[] = [
    capability({
      id: "files-and-folders",
      kind: "FILE_PICKER",
      section: "ADD",
      label: "Files and folders",
      description: "Attach files from this device",
      available: context.stagingAvailable,
      unavailableReason:
        context.stagingUnavailableReason ?? "Organization file policy blocks uploads",
      unavailableAvailability: "POLICY_BLOCKED",
    }),
    capability({
      id: "goal",
      kind: "GOAL",
      section: "ADD",
      label: "Goal",
      description: "Set a goal to keep pursuing",
      available: context.goalAvailable,
      unavailableReason: context.goalUnavailableReason ?? "Goal is unavailable for this Runtime",
      ...(context.goalUnavailableReasonCode
        ? { unavailableReasonCode: context.goalUnavailableReasonCode }
        : {}),
      unavailableAvailability: "UNSUPPORTED",
    }),
    capability({
      id: "plan-mode",
      kind: "PLAN_MODE",
      section: "ADD",
      label: "Plan mode",
      description: "Turn plan mode on",
      available: context.planModeAvailable,
      unavailableReason:
        context.planModeUnavailableReason ?? "Runtime version does not support plan mode",
      unavailableAvailability: "UNSUPPORTED",
    }),
  ];

  return capabilities;
}

function capability(input: {
  id: string;
  kind: ComposerCapability["kind"];
  section: ComposerCapability["section"];
  label: string;
  description: string;
  available: boolean;
  unavailableReason: string;
  unavailableReasonCode?: string;
  unavailableAvailability: "POLICY_BLOCKED" | "UNSUPPORTED";
}): ComposerCapability {
  return ComposerCapabilitySchema.parse({
    id: input.id,
    kind: input.kind,
    section: input.section,
    label: input.label,
    description: input.description,
    availability: input.available ? "AVAILABLE" : input.unavailableAvailability,
    unavailableReason: input.available ? null : input.unavailableReason,
    unavailableReasonCode: input.available ? null : (input.unavailableReasonCode ?? null),
  });
}
