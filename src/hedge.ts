export interface HedgeAttempt<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export function raceWithHedge<T>(launch: (isHedge: boolean) => HedgeAttempt<T>, delayMs: number): Promise<{
  value: T; winner: "primary" | "hedge"; hedged: boolean;
}> {
  if (!Number.isFinite(delayMs) || delayMs < 0) {throw new Error("Invalid hedge delay");}
  return new Promise((resolve, reject) => {
    let hedge: HedgeAttempt<T> | null = null;
    let settled = false;
    let failures = 0;
    let primaryError: unknown = null;
    const watch = (attempt: HedgeAttempt<T>, isHedge: boolean): void => {
      attempt.promise.then(value => {
        if (settled) {return;}
        settled = true;
        clearTimeout(timer);
        try {(isHedge ? primary : hedge)?.cancel();}
        catch { /* Cancellation must not replace a successful read. */ }
        resolve({value, winner: isHedge ? "hedge" : "primary", hedged: hedge !== null});
      }, (error: unknown) => {
        if (settled) {return;}
        failures++;
        if (!isHedge) {primaryError = error;}
        if (hedge === null || failures === 2) {
          settled = true;
          clearTimeout(timer);
          reject(primaryError);
        }
      });
    };
    const primary = launch(false);
    const timer = setTimeout(() => {
      if (settled) {return;}
      try {
        hedge = launch(true);
      } catch (error: unknown) {
        // A failed hedge launch must not abandon a still-running primary.
        hedge = {promise: Promise.reject(error), cancel: () => {}};
      }
      watch(hedge, true);
    }, delayMs);
    watch(primary, false);
  });
}
