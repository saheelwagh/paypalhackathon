import { persistedStateSchema, seed, type DeskState } from './domain';
import type { WorkspaceRepository } from './contracts';
export const DEMO_STORAGE_KEY = 'business-desk:demo:v1';
/** Synthetic records only. The browser repository is deliberately not connected authorization. */
export class DemoWorkspaceRepository implements WorkspaceRepository {
  readonly mode = 'demo' as const;
  private fallback: DeskState;
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'>, initial = seed(), private locks?: Pick<LockManager, 'request'>) { this.fallback = persistedStateSchema.parse(initial); }
  read(): DeskState {
    const raw = this.storage.getItem(DEMO_STORAGE_KEY);
    return persistedStateSchema.parse(raw ? JSON.parse(raw) : this.fallback);
  }
  async transact(update: (state: DeskState) => DeskState): Promise<DeskState> {
    const work = () => {
      const next = persistedStateSchema.parse(update(this.read()));
      this.storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(next));
      this.fallback = next;
      return structuredClone(next);
    };
    return this.locks ? this.locks.request(DEMO_STORAGE_KEY, work) : work();
  }
  /** Recovery is explicit: malformed old fixture state need not be parsed before a deliberate replacement. */
  async replace(next: DeskState): Promise<DeskState> {
    const work = () => { const snapshot = persistedStateSchema.parse(next); this.storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(snapshot)); this.fallback = snapshot; return structuredClone(snapshot); };
    return this.locks ? this.locks.request(DEMO_STORAGE_KEY, work) : work();
  }
}
