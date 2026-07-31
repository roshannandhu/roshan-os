import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioStream } from "../useAudioStream.js";

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAudioStream", () => {
  it("starts connecting when active", () => {
    const { result } = renderHook(() => useAudioStream(true));
    expect(result.current.state).toBe("connecting");
    expect(result.current.src).toMatch(/\/api\/v1\/camera\/audio\?attempt=/);
  });

  it("stays idle when not active", () => {
    const { result } = renderHook(() => useAudioStream(false));
    expect(result.current.state).toBe("idle");
    expect(result.current.src).toBeUndefined();
  });

  it("transitions to connected on load", () => {
    const { result } = renderHook(() => useAudioStream(true));
    act(() => {
      result.current.onLoad();
    });
    expect(result.current.state).toBe("connected");
  });

  it("onBlocked sets state to blocked", () => {
    const { result } = renderHook(() => useAudioStream(true));
    act(() => {
      result.current.onBlocked();
    });
    expect(result.current.state).toBe("blocked");
    // src still available while blocked so user can click play
    expect(result.current.src).toBeDefined();
  });

  it("retry after blocked resets and reconnects", () => {
    const { result } = renderHook(() => useAudioStream(true));
    act(() => {
      result.current.onBlocked();
    });
    act(() => {
      result.current.retry();
    });
    expect(result.current.state).toBe("connecting");
    expect(result.current.src).toBeDefined();
  });

  it("reaches exhausted after 3 errors", () => {
    const { result } = renderHook(() => useAudioStream(true));
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
    expect(result.current.src).toBeUndefined();
  });

  it("stops when page hidden, resumes when visible", () => {
    const { result } = renderHook(() => useAudioStream(true));

    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.state).toBe("hidden");
    expect(result.current.src).toBeUndefined();

    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.state).toBe("connecting");
    expect(result.current.src).toBeDefined();
  });

  it("uses 1s/2s/4s backoff delays", () => {
    const { result } = renderHook(() => useAudioStream(true));
    const src0 = result.current.src;

    act(() => {
      result.current.onError();
    }); // delay=1s
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.src).toBe(src0); // still reconnecting
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toBe("connecting");

    act(() => {
      result.current.onError();
    }); // delay=2s
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(result.current.state).toBe("reconnecting");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toBe("connecting");

    act(() => {
      result.current.onError();
    }); // delay=4s
    act(() => {
      vi.advanceTimersByTime(3_999);
    });
    expect(result.current.state).toBe("reconnecting");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toBe("connecting");
  });

  it("resets attempt counter after 10s stable", () => {
    const { result } = renderHook(() => useAudioStream(true));
    act(() => {
      result.current.onLoad();
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    }); // stability reset

    act(() => {
      result.current.onError();
    }); // should be attempt 0 again → 1s delay
    expect(result.current.state).toBe("reconnecting");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.state).toBe("connecting");
  });

  it("goes idle when active becomes false", () => {
    const { result, rerender } = renderHook(({ a }) => useAudioStream(a), {
      initialProps: { a: true }
    });
    rerender({ a: false });
    expect(result.current.state).toBe("idle");
    expect(result.current.src).toBeUndefined();
  });
});
