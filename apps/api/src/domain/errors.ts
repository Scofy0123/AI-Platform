export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 409 | 503 = 409,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class GoalCapabilityUnavailableError extends DomainError {
  constructor(
    readonly reasonCode: string,
    message: string,
    httpStatus: 409 | 503,
  ) {
    super("GOAL_CAPABILITY_UNAVAILABLE", message, httpStatus);
    this.name = "GoalCapabilityUnavailableError";
  }
}

export class GoalSyncConflictError extends DomainError {
  constructor(
    readonly field:
      | "objective"
      | "status"
      | "tokenBudget"
      | "tokensUsed"
      | "timeUsedSeconds"
      | "clear",
    message: string,
  ) {
    super("GOAL_SYNC_CONFLICT", message);
    this.name = "GoalSyncConflictError";
  }
}

export class GoalMutationSupersededError extends DomainError {
  constructor() {
    super(
      "GOAL_MUTATION_SUPERSEDED",
      "A newer Goal mutation superseded this Runtime synchronization",
    );
    this.name = "GoalMutationSupersededError";
  }
}

export class GoalMutationBlockedByPendingTurnError extends DomainError {
  constructor(readonly turnStatus: "ALLOCATING" | "QUEUED") {
    super(
      "GOAL_MUTATION_BLOCKED_BY_PENDING_TURN",
      `A ${turnStatus} Turn already froze the Goal input snapshot`,
    );
    this.name = "GoalMutationBlockedByPendingTurnError";
  }
}

export class PlanModeMutationBlockedError extends DomainError {
  constructor(readonly turnStatus: "ALLOCATING" | "QUEUED" | "RUNNING" | "WAITING_APPROVAL") {
    super(
      "PLAN_MODE_MUTATION_BLOCKED_BY_PENDING_TURN",
      `A ${turnStatus} Turn already froze the Plan mode input snapshot`,
    );
    this.name = "PlanModeMutationBlockedError";
  }
}

export class ComposerRevisionConflictError extends DomainError {
  constructor() {
    super("COMPOSER_REVISION_CONFLICT", "Composer state changed; reload before editing");
    this.name = "ComposerRevisionConflictError";
  }
}

export class PlanModeCapabilityChangedError extends DomainError {
  constructor() {
    super("PLAN_MODE_CAPABILITY_CHANGED", "Plan mode capability changed before execution.");
    this.name = "PlanModeCapabilityChangedError";
  }
}

export class PlanPresetModelUnavailableError extends DomainError {
  constructor() {
    super(
      "PLAN_PRESET_MODEL_UNAVAILABLE",
      "The selected collaboration preset is unavailable before execution.",
    );
    this.name = "PlanPresetModelUnavailableError";
  }
}
