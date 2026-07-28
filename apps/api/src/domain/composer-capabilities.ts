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
    capability({
      id: "record-a-skill",
      kind: "SKILL_RECORDER",
      section: "ADD",
      label: "Record a skill",
      description: "Record a reusable workflow",
      available: context.skillRecorderAvailable,
      unavailableReason:
        context.skillRecorderUnavailableReason ?? "Requires an isolated Computer Use Worker",
      unavailableAvailability: "UNSUPPORTED",
    }),
  ];

  for (const skill of context.approvedSkills) {
    capabilities.push(
      ComposerCapabilitySchema.parse({
        id: `skill:${skill.id}`,
        kind: "SKILL",
        section: "PLUGINS",
        label: skill.label,
        description: skill.description,
        availability: "AVAILABLE",
        unavailableReason: null,
      }),
    );
  }

  for (const app of context.approvedApps) {
    capabilities.push(
      ComposerCapabilitySchema.parse({
        id: `app:${app.id}`,
        kind: "APP",
        section: "APPS",
        label: app.label,
        description: app.description,
        availability: app.connected ? "AVAILABLE" : "AUTH_REQUIRED",
        unavailableReason: app.connected
          ? null
          : "Connect this app with your own enterprise identity",
      }),
    );
  }

  for (const thread of context.recentThreads) {
    capabilities.push(
      ComposerCapabilitySchema.parse({
        id: `thread:${thread.id}`,
        kind: "THREAD_REFERENCE",
        section: "FILES_AND_CHATS",
        label: thread.label,
        description: thread.description,
        availability: "AVAILABLE",
        unavailableReason: null,
      }),
    );
  }

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
  });
}
