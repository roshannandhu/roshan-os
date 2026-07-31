import { describe, expect, it } from "vitest";
import { ApiProblem } from "./errors.js";
import { TalkCoordinator } from "./talk.js";
import { isAllowedTalkOrigin } from "./routes.js";

describe("TalkCoordinator", () => {
  it("enforces a single active transmission and clears it on stop", () => {
    const coordinator = new TalkCoordinator();

    coordinator.start("session-a");
    expect(coordinator.isActiveFor("session-a")).toBe(true);

    expect(() => coordinator.start("session-b")).toThrow(ApiProblem);
    expect(coordinator.stop("session-a")).toBe(true);
    expect(coordinator.isActiveFor("session-a")).toBe(false);
    expect(coordinator.stop("session-a")).toBe(false);
  });
});

describe("talk WebSocket origin validation", () => {
  const request = {
    origin: "https://tablet-controller.private",
    requestHost: "127.0.0.1:3000",
    forwardedHost: "tablet-controller.private",
    requestProtocol: "http",
    forwardedProtocol: "https",
    configuredOrigin: "http://127.0.0.1:5173",
    isTest: false
  };

  it("accepts the private proxy's exact same origin", () => {
    expect(isAllowedTalkOrigin(request)).toBe(true);
  });

  it("rejects cross-origin and missing production origins", () => {
    expect(isAllowedTalkOrigin({ ...request, origin: "https://untrusted.invalid" })).toBe(false);
    expect(isAllowedTalkOrigin({ ...request, origin: undefined })).toBe(false);
  });

  it("preserves the explicitly configured local development origin", () => {
    expect(
      isAllowedTalkOrigin({
        ...request,
        origin: "http://127.0.0.1:5173",
        forwardedHost: undefined,
        forwardedProtocol: undefined
      })
    ).toBe(true);
  });
});
