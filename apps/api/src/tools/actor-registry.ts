export interface RegisteredActor {
  taskId: string;
  userId: string;
  accountId: string;
  turnId: string;
}

export class ActorRegistry {
  private readonly byThread = new Map<string, RegisteredActor>();

  bind(threadId: string, actor: RegisteredActor): void {
    this.byThread.set(threadId, actor);
  }

  resolve(threadId: string, turnId: string): RegisteredActor | null {
    const actor = this.byThread.get(threadId);
    return actor?.turnId === turnId ? actor : null;
  }

  clearTurn(threadId: string, turnId: string): void {
    const actor = this.byThread.get(threadId);
    if (actor?.turnId === turnId) this.byThread.delete(threadId);
  }
}
