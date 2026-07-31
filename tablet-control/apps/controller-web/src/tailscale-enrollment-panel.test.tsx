import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TailscaleEnrollmentActionResult,
  TailscaleEnrollmentStatus
} from "@tablet-control/shared-types";
import { ControllerApi } from "./api";
import { TailscaleEnrollmentPanel } from "./tailscale-enrollment-panel";

const idleStatus: TailscaleEnrollmentStatus = {
  state: "never_requested",
  code: "NONE",
  startedAtMs: 0,
  finishedAtMs: 0,
  deadlineAtMs: 0,
  timeoutSeconds: 0,
  deviceOwner: true,
  tailscaleInstalled: true,
  tailscaleEnabled: true,
  tailscaleVersion: "1.84.0",
  alwaysOnVpnConfigured: true,
  vpnTransportDetected: false,
  vpnValidated: false,
  tailnetAddressDetected: false,
  credentialConsumptionProven: false,
  transientAuthKeyPresent: false,
  supportedPolicies: {
    authKey: true,
    forceEnabled: true,
    onboardingFlow: true
  },
  appliedNonSecretPolicy: {
    alwaysOnVpnPackage: true,
    forceEnabled: true,
    onboardingHidden: true
  }
};

const enrollingResult: TailscaleEnrollmentActionResult = {
  accepted: true,
  code: "ENROLLMENT_STARTED",
  enrollment: {
    ...idleStatus,
    state: "enrolling",
    code: "WAITING_FOR_TAILNET",
    startedAtMs: 1_722_000_000_000,
    deadlineAtMs: 1_722_000_120_000,
    timeoutSeconds: 120,
    transientAuthKeyPresent: true
  }
};

const authKey = "tskey-auth-k1234567890abcDEF-1234567890abcDEF";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Tailscale enrollment API client", () => {
  it("sends the exact owner-CSRF request and validates without placing the key in an error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: {
            username: "admin",
            csrfToken: "tailscale-csrf",
            expiresAt: Date.now() + 60_000,
            mode: "companion"
          }
        })
      )
      .mockResolvedValueOnce(Response.json({ ok: true, data: idleStatus }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: enrollingResult }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ControllerApi();
    await api.login("admin", "test-only-password");

    await expect(api.getTailscaleEnrollmentStatus()).resolves.toEqual(idleStatus);
    await expect(api.enrollTailscale(authKey, 120)).resolves.toEqual(enrollingResult);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/tailscale/enrollment",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ authKey, timeoutSeconds: 120 })
      })
    );
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("x-csrf-token")).toBe(
      "tailscale-csrf"
    );

    const invalidKey = `not-valid-${authKey}`;
    let rejected: unknown;
    try {
      await api.enrollTailscale(invalidKey, 120);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(String(rejected)).not.toContain(invalidKey);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("Tailscale owner enrollment panel", () => {
  it("clears the masked key immediately after submission and never echoes it", async () => {
    const api = new ControllerApi();
    vi.spyOn(api, "getTailscaleEnrollmentStatus").mockResolvedValue(idleStatus);
    const enroll = vi.spyOn(api, "enrollTailscale").mockResolvedValue(enrollingResult);
    const runAction = vi.fn(async (action: () => Promise<{ message: string }>) => {
      await action();
    });
    render(<TailscaleEnrollmentPanel controllerApi={api} disabled={false} runAction={runAction} />);

    expect(await screen.findByText("Not enrolled")).toBeInTheDocument();
    const input = screen.getByLabelText("One-off Tailscale auth key") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: authKey } });
    fireEvent.click(screen.getByRole("button", { name: "Recovery: re-enroll Tailscale" }));

    await waitFor(() => expect(enroll).toHaveBeenCalledWith(authKey, 120));
    expect(input.value).toBe("");
    expect(screen.queryByText(authKey)).not.toBeInTheDocument();
    expect(await screen.findByText("Enrolling")).toBeInTheDocument();
    expect(screen.getByText("WAITING_FOR_TAILNET")).toBeInTheDocument();
  });

  it("clears the key on rejection and treats unreadable restriction state as unsafe", async () => {
    const unsafeStatus: TailscaleEnrollmentStatus = {
      ...idleStatus,
      state: "failed",
      code: "APPLICATION_RESTRICTIONS_STATE_UNKNOWN",
      transientAuthKeyPresent: null
    };
    const api = new ControllerApi();
    vi.spyOn(api, "getTailscaleEnrollmentStatus").mockResolvedValue(unsafeStatus);
    vi.spyOn(api, "enrollTailscale").mockRejectedValue(
      new Error("Enrollment was rejected; inspect secret-free status.")
    );
    const runAction = vi.fn(async (action: () => Promise<{ message: string }>) => {
      await action().catch(() => undefined);
    });
    render(<TailscaleEnrollmentPanel controllerApi={api} disabled={false} runAction={runAction} />);

    expect(await screen.findByText(/key removal is not confirmed/i)).toBeInTheDocument();
    const input = screen.getByLabelText("One-off Tailscale auth key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: authKey } });
    fireEvent.click(screen.getByRole("button", { name: "Recovery: re-enroll Tailscale" }));

    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.queryByText(authKey)).not.toBeInTheDocument();
  });
});
