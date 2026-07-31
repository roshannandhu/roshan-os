import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_MAX_APK_BYTES } from "@tablet-control/shared-types";
import type {
  ControllerUpdateArtifact,
  SignedUpdateActionResult,
  SignedUpdateStatus
} from "@tablet-control/shared-types";
import { ControllerApi, type SignedUpdateInstallResult } from "./api";
import { SignedUpdatePanel } from "./signed-update-panel";

const updateStatus: SignedUpdateStatus = {
  state: "idle",
  currentVersionCode: 42,
  currentVersionName: "4.2",
  baseVersionCode: null,
  baseVersionName: null,
  targetVersionCode: null,
  targetVersionName: null,
  startedAtMs: null,
  updatedAtMs: 1_722_222_222_222,
  lastAppliedAtMs: 1_722_000_000_000,
  lastRollbackAtMs: null,
  lastRolledBackFromVersionCode: null,
  errorCode: null,
  progress: {
    downloadedBytes: 0,
    expectedBytes: null
  },
  controllerOrigin: {
    configured: true,
    state: "ready",
    host: "controller.tailnet-name.ts.net"
  },
  installCapability: {
    deviceOwner: true,
    selfUpdatePermissionGranted: true,
    silentSelfUpdateCapable: true,
    installerUiAllowed: false
  },
  rollback: {
    platformApiPresent: true,
    permissionGranted: true,
    supported: true,
    available: true,
    rollbackId: 7,
    versionRolledBackFrom: 43,
    versionRolledBackTo: 42,
    reasonCode: null,
    requestedForLastUpdate: true,
    dataPolicy: "retain",
    bootFailureAutoRollbackGuaranteed: false
  }
};

const uploadedArtifact: ControllerUpdateArtifact = {
  id: "update_1722222222222_a1b2c3d4e5f60708",
  fileName: "roshanos-release.apk",
  sizeBytes: 12,
  sha256: "a".repeat(64),
  createdAt: "2026-07-29T12:34:56.000Z"
};

const updateAction: SignedUpdateActionResult = {
  accepted: true,
  code: "UPDATE_REQUEST_ACCEPTED",
  update: {
    ...updateStatus,
    state: "downloading",
    targetVersionCode: 43,
    targetVersionName: "4.3",
    progress: {
      downloadedBytes: 4,
      expectedBytes: 12
    }
  }
};

const installResult: SignedUpdateInstallResult = {
  artifact: uploadedArtifact,
  controllerOrigin: "https://controller.tailnet-name.ts.net",
  originResult: {
    accepted: true,
    code: "CONTROLLER_ORIGIN_CONFIGURED",
    update: updateStatus
  },
  requestResult: updateAction
};

class UpdateUploadRequest extends EventTarget {
  public static last: UpdateUploadRequest | undefined;
  public readonly upload = new EventTarget();
  public readonly headers = new Map<string, string>();
  public method = "";
  public url = "";
  public body: Document | XMLHttpRequestBodyInit | null = null;
  public status = 200;
  public responseText = JSON.stringify({ ok: true, data: uploadedArtifact });
  public timeout = 0;
  public withCredentials = false;

  public constructor() {
    super();
    UpdateUploadRequest.last = this;
  }

  public open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  public setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  public getResponseHeader(): string | null {
    return null;
  }

  public send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
    queueMicrotask(() => {
      this.upload.dispatchEvent(
        new ProgressEvent("progress", {
          lengthComputable: true,
          loaded: 1,
          total: 2
        })
      );
      this.dispatchEvent(new Event("load"));
    });
  }
}

afterEach(() => {
  cleanup();
  UpdateUploadRequest.last = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signed update API client", () => {
  it("uploads an APK as raw multipart with owner CSRF and enforces the 128 MiB limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          data: {
            username: "admin",
            csrfToken: "signed-update-csrf",
            expiresAt: Date.now() + 60_000,
            mode: "companion"
          }
        })
      )
    );
    vi.stubGlobal("XMLHttpRequest", UpdateUploadRequest as unknown as typeof XMLHttpRequest);
    const readAsDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const api = new ControllerApi();
    await api.login("admin", "test-only-password");
    const file = new File(
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8])],
      "roshanos-release.apk",
      { type: "application/vnd.android.package-archive" }
    );
    const progress: number[] = [];

    await expect(
      api.uploadUpdateArtifact(file, (percent) => progress.push(percent))
    ).resolves.toEqual(uploadedArtifact);

    const request = UpdateUploadRequest.last;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/api/v1/update/artifacts");
    expect(request?.withCredentials).toBe(true);
    expect(request?.timeout).toBe(600_000);
    expect(request?.headers.get("x-csrf-token")).toBe("signed-update-csrf");
    expect(request?.headers.has("content-type")).toBe(false);
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect([...form.keys()]).toEqual(["file"]);
    expect((form.get("file") as File).name).toBe("roshanos-release.apk");
    expect((form.get("file") as File).size).toBe(file.size);
    expect(progress).toEqual([50, 100]);
    expect(readAsDataUrl).not.toHaveBeenCalled();

    const oversizedFile = {
      name: "oversized.apk",
      size: UPDATE_MAX_APK_BYTES + 1
    } as File;
    await expect(api.uploadUpdateArtifact(oversizedFile)).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  it("uses owner CSRF for install and sends the exact confirmed rollback body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: {
            username: "admin",
            csrfToken: "signed-update-csrf",
            expiresAt: Date.now() + 60_000,
            mode: "companion"
          }
        })
      )
      .mockResolvedValueOnce(Response.json({ ok: true, data: updateStatus }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: installResult }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: updateAction }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ControllerApi();
    await api.login("admin", "test-only-password");

    await expect(api.getSignedUpdateStatus()).resolves.toEqual(updateStatus);
    await expect(api.installUpdateArtifact(uploadedArtifact.id)).resolves.toEqual(installResult);
    await expect(api.rollbackSignedUpdate()).resolves.toEqual(updateAction);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/update/status",
      expect.objectContaining({ method: "GET", credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/v1/update/artifacts/${uploadedArtifact.id}/install`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({})
      })
    );
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("x-csrf-token")).toBe(
      "signed-update-csrf"
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/v1/update/rollback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ confirm: true })
      })
    );
  });
});

describe("signed update owner panel", () => {
  it("polls status, shows artifact metadata, triggers install, and requires rollback confirmation", async () => {
    const api = new ControllerApi();
    const statusSpy = vi.spyOn(api, "getSignedUpdateStatus").mockResolvedValue(updateStatus);
    const uploadSpy = vi
      .spyOn(api, "uploadUpdateArtifact")
      .mockImplementation(async (_file, onProgress) => {
        onProgress?.(65);
        return uploadedArtifact;
      });
    const installSpy = vi.spyOn(api, "installUpdateArtifact").mockResolvedValue(installResult);
    const rollbackSpy = vi.spyOn(api, "rollbackSignedUpdate").mockResolvedValue({
      accepted: true,
      code: "ROLLBACK_REQUEST_ACCEPTED",
      update: {
        ...updateStatus,
        state: "rollback_committing"
      }
    });
    const runAction = vi.fn(async (action: () => Promise<{ message: string }>): Promise<void> => {
      await action();
    });

    render(<SignedUpdatePanel controllerApi={api} disabled={false} runAction={runAction} />);

    expect(await screen.findByText("4.2 (code 42)")).toBeInTheDocument();
    expect(statusSpy).toHaveBeenCalled();
    const file = new File(
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8])],
      "roshanos-release.apk",
      { type: "application/vnd.android.package-archive" }
    );
    fireEvent.change(screen.getByLabelText("RoshanOS update APK"), {
      target: { files: [file] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload APK securely" }));

    expect(
      await screen.findByRole("heading", { name: "Stored update artifact" })
    ).toBeInTheDocument();
    expect(screen.getByText(uploadedArtifact.sha256)).toBeInTheDocument();
    expect(uploadSpy).toHaveBeenCalledWith(file, expect.any(Function));

    fireEvent.click(screen.getByRole("button", { name: "Install uploaded update" }));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith(uploadedArtifact.id));
    expect(await screen.findByText("Downloading")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Roll back last update" }));
    expect(
      await screen.findByRole("heading", { name: "Roll back the last RoshanOS update?" })
    ).toBeInTheDocument();
    expect(rollbackSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await waitFor(() => expect(rollbackSpy).toHaveBeenCalledTimes(1));
  });
});
