import type { ActorContext } from "@codexplatform/contracts";

export interface ActorBindingIdentity {
  accountId: string;
  connectionGeneration: number;
  threadId: string;
  turnId: string;
}

export interface RegisteredActor extends ActorBindingIdentity {
  taskId: string;
  actorContext: ActorContext;
}

export class ActorRegistry {
  private readonly byTurn = new Map<string, RegisteredActor>();

  bind(binding: RegisteredActor): void {
    const immutable = cloneBinding(binding);
    const key = bindingKey(immutable);
    const existing = this.byTurn.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(immutable)) {
      throw new Error("Actor binding conflict");
    }
    this.byTurn.set(key, immutable);
  }

  resolve(identity: ActorBindingIdentity): RegisteredActor | null {
    const actor = this.byTurn.get(bindingKey(identity));
    return actor ? cloneBinding(actor) : null;
  }

  clearTurn(identity: ActorBindingIdentity): void {
    this.byTurn.delete(bindingKey(identity));
  }
}

function bindingKey(identity: ActorBindingIdentity): string {
  return JSON.stringify([
    identity.accountId,
    identity.connectionGeneration,
    identity.threadId,
    identity.turnId,
  ]);
}

function cloneBinding(binding: RegisteredActor): RegisteredActor {
  return {
    accountId: binding.accountId,
    connectionGeneration: binding.connectionGeneration,
    threadId: binding.threadId,
    turnId: binding.turnId,
    taskId: binding.taskId,
    actorContext: {
      tenantKey: binding.actorContext.tenantKey,
      userId: binding.actorContext.userId,
      role: binding.actorContext.role,
      toolScopes: [...binding.actorContext.toolScopes],
      approvalPolicy: binding.actorContext.approvalPolicy,
    },
  };
}
