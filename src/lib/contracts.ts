import type { Actor, Command, Conversation, DeskState, Invoice, Run } from './domain';
import type { Goal } from './agent';
export type DataMode = 'demo' | 'integration-test' | 'connected-sandbox';
export type CapabilityState = 'not-configured' | 'configured-unverified' | 'verified' | 'error' | 'simulated';
export type Capability = { name: string; status: CapabilityState; checkedAt?: string; error?: string };
export type OperationResult<T> = { ok: true; value: T; mode: DataMode; operationId: string } | { ok: false; error: string; retry: 'safe' | 'reconcile-first' | 'not-permitted'; operationId: string };
/** Repositories own serialization and concurrency. Connected implementations must transact server-side. */
export interface WorkspaceRepository {
  readonly mode: DataMode;
  read(): DeskState;
  transact(update: (state: DeskState) => DeskState): Promise<DeskState>;
}
export interface ConversationService {
  readonly mode: DataMode;
  review(command: Command, actor: Actor): Promise<OperationResult<Conversation>>;
}
export interface AgentService {
  readonly mode: DataMode;
  investigate(state: DeskState, goal: Goal, projectId: string, context?: string): Promise<OperationResult<Run>>;
}
export interface BillingService {
  readonly mode: DataMode;
  execute(command: Command, actor: Actor): Promise<OperationResult<Invoice>>;
}
export interface PaymentStatusService {
  readonly mode: DataMode;
  reconcile(invoiceId: string): Promise<OperationResult<Invoice>>;
}
export interface DashboardBridge<TReport> {
  read(): TReport;
  configure(report: TReport): void;
  undo(): void;
}
