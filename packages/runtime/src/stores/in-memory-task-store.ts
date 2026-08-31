import type { Task, TaskStore } from '@memnox/core';

/** A task lives as long as its session; nothing here outlives the process. */
export class InMemoryTaskStore implements TaskStore {
  private readonly byId = new Map<string, Task>();

  async save(task: Task): Promise<void> {
    this.byId.set(task.id, task);
  }

  /** An open task wins: a closed one must not be reopened by declaring nothing. */
  async findBySession(sessionId: string): Promise<Task | null> {
    let ended: Task | null = null;
    for (const task of this.byId.values()) {
      if (task.sessionId !== sessionId) continue;
      if (task.endedAt === undefined) return task;
      ended = task;
    }
    return ended;
  }

  async findById(id: string): Promise<Task | null> {
    return this.byId.get(id) ?? null;
  }
}
