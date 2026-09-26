export interface IdleTimer {
  touch(): void;
  stop(): void;
}

export function createIdleTimer(
  timeoutMs: number,
  onIdle: () => void,
  checkIntervalMs = Math.max(50, Math.min(timeoutMs / 5, 5000)),
): IdleTimer {
  let last = Date.now();
  const interval = setInterval(() => {
    if (Date.now() - last >= timeoutMs) {
      last = Date.now();
      onIdle();
    }
  }, checkIntervalMs);
  return {
    touch: () => {
      last = Date.now();
    },
    stop: () => clearInterval(interval),
  };
}
