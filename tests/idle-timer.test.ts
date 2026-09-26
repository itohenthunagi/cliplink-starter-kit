import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdleTimer } from "../src/server/idle-timer";

describe("createIdleTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("タイムアウト時間を超えるとコールバックを呼ぶ", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const timer = createIdleTimer(1000, onIdle, 100);
    vi.advanceTimersByTime(1100);
    expect(onIdle).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it("touch()を呼ぶとタイムアウトがリセットされる", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const timer = createIdleTimer(1000, onIdle, 100);
    vi.advanceTimersByTime(600);
    timer.touch();
    vi.advanceTimersByTime(600);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onIdle).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it("stop()以降はコールバックを呼ばない", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const timer = createIdleTimer(1000, onIdle, 100);
    timer.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
