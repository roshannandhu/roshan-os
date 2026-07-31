import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVideoStream } from "../useVideoStream.js";

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useVideoStream", () => {
  it("starts in connecting state when active", () => {
    const { result } = renderHook(() => useVideoStream(true));
    expect(result.current.state).toBe("connecting");
    expect(result.current.src).toMatch(/\/api\/v1\/camera\/stream\?attempt=/);
  });

  it("stays idle when not active", () => {
    const { result } = renderHook(() => useVideoStream(false));
    expect(result.current.state).toBe("idle");
    expect(result.current.src).toBeUndefined();
  });

  it("transitions to connected on load", () => {
    const { result } = renderHook(() => useVideoStream(true));
    act(() => {
      result.current.onLoad();
    });
    expect(result.current.state).toBe("connected");
  });

  it("transitions to reconnecting on first error", () => {
    const { result } = renderHook(() => useVideoStream(true));
    act(() => {
      result.current.onError();
    });
    expect(result.current.state).toBe("reconnecting");
    expect(result.current.src).toMatch(/stream/);
  });

  it("uses 1s delay for first retry", () => {
    const { result } = renderHook(() => useVideoStream(true));
    const rev1 = result.current.src;
    act(() => {
      result.current.onError();
    });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.src).toBe(rev1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toBe("connecting");
    expect(result.current.src).not.toBe(rev1);
  });

  it("uses 2s delay for second retry", () => {
    const { result } = renderHook(() => useVideoStream(true));
    act(() => {
      result.current.onError();
    }); // attempt 1
    act(() => {
      vi.advanceTimersByTime(1_000);
    }); // retry fires
    const rev2 = result.current.src;
    act(() => {
      result.current.onError();
    }); // attempt 2
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(result.current.src).toBe(rev2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toBe("connecting");
  });

  it("reaches exhausted after 3 errors with no stable period", () => {
    const { result } = renderHook(() => useVideoStream(true));
    act(() => {
      result.current.onError();
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      result.current.onError();
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      result.current.onError();
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    act(() => {
      result.current.onError();
    }); // 4th error = exhausted
    expect(result.current.state).toBe("exhausted");
    expect(result.current.src).toBeUndefined();
  });

  it("retry() resets attempt counter and restarts", () => {
    const { result } = renderHook(() => useVideoStream(true));
    // exhaust retries
    act(() => {
      result.current.onError();
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      result.current.onError();
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      result.current.onError();
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    act(() => {
      result.current.onError();
    });
    expect(result.current.state).toBe("exhausted");

    act(() => {
      result.current.retry();
    });
    expect(result.current.state).toBe("connecting");
    expect(result.current.src).toBeDefined();
  });

  it("resets attempt counter after 10s stable period", () => {
    const { result } = renderHook(() => useVideoStream(true));
    act(() => {
      result.current.onError();
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      result.current.onLoad();
    }); // connected
    act(() => {
      vi.advanceTimersByTime(10_000);
    }); // stability reset fires

    // Now errors should restart the backoff from 0
    act(() => {
      result.current.onError();
    });
    expect(result.current.state).toBe("reconnecting");
    act(() => {
      vi.advanceTimersByTime(1_000);
    }); // 1s first retry again
    expect(result.current.state).toBe("connecting");
  });

  it("stops to hidden when page becomes hidden", () => {
    const { result } = renderHook(() => useVideoStream(true));
    expect(result.current.state).toBe("connecting");

    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.state).toBe("hidden");
    expect(result.current.src).toBeUndefined();
  });

  it("resumes when page becomes visible again", () => {
    const { result } = renderHook(() => useVideoStream(true));

    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.state).toBe("hidden");

    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.state).toBe("connecting");
    expect(result.current.src).toBeDefined();
  });

  it("goes idle when active becomes false", () => {
    const { result, rerender } = renderHook(({ a }) => useVideoStream(a), {
      initialProps: { a: true }
    });
    expect(result.current.state).toBe("connecting");
    rerender({ a: false });
    expect(result.current.state).toBe("idle");
    expect(result.current.src).toBeUndefined();
  });

  it("starts when active becomes true", () => {
    const { result, rerender } = renderHook(({ a }) => useVideoStream(a), {
      initialProps: { a: false }
    });
    expect(result.current.state).toBe("idle");
    rerender({ a: true });
    expect(result.current.state).toBe("connecting");
    expect(result.current.src).toBeDefined();
  });
});
