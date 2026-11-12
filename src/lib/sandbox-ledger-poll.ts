/** Read-only polling for the local sandbox ledger. Never calls a payment provider. */
export type LedgerPoller = {
  start(): void;
  refresh(): void;
  visibilityChanged(): void;
  suspend(): void;
  resume(): void;
  dispose(): void;
};
type Schedule = (callback: () => void, milliseconds: number) => unknown;
export function createLedgerPoller<T>(options: {
  read(signal: AbortSignal): Promise<T>;
  onValue(value: T): void;
  onError(error: unknown): void;
  onBusy?(busy: boolean): void;
  isVisible(): boolean;
  intervalMs?: number;
  schedule?: Schedule;
  cancel?: (handle: unknown) => void;
}): LedgerPoller {
  const schedule = options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const interval = Math.max(1_000, options.intervalMs ?? 3_000);
  let timer: unknown;
  let active: AbortController | undefined;
  let generation = 0;
  let started = false;
  let stopped = false;
  let suspended = false;
  let followUp = false;

  function clearTimer() { if (timer !== undefined) { cancel(timer); timer = undefined; } }
  function available() { return started && !stopped && !suspended && options.isVisible(); }
  function invalidate() { generation++; active?.abort(); clearTimer(); followUp = false; }
  function later() {
    if (!available() || active) return;
    clearTimer();
    timer = schedule(() => { timer = undefined; run(); }, interval);
  }
  function run() {
    if (!available()) return;
    clearTimer();
    // Focus/visibility/manual refresh coalesce behind the current request.
    if (active) { followUp = true; return; }
    const controller = new AbortController();
    active = controller;
    const requestGeneration = generation;
    options.onBusy?.(true);
    void (async () => {
      try {
        const value = await options.read(controller.signal);
        if (!stopped && requestGeneration === generation && !controller.signal.aborted) options.onValue(value);
      } catch (error) {
        if (!stopped && requestGeneration === generation && !controller.signal.aborted) options.onError(error);
      } finally {
        active = undefined;
        if (!stopped) options.onBusy?.(false);
        if (followUp && available()) { followUp = false; run(); }
        else { followUp = false; later(); }
      }
    })();
  }
  return {
    start() { if (stopped || started) return; started = true; run(); },
    refresh: run,
    visibilityChanged() {
      if (!options.isVisible()) invalidate();
      else run();
    },
    suspend() { suspended = true; invalidate(); },
    resume() { suspended = false; run(); },
    dispose() { stopped = true; invalidate(); },
  };
}
