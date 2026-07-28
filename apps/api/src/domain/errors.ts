export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
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
