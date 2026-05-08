import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();
const unrefMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

describe("dispatchNotificationInBackground", () => {
  beforeEach(() => {
    spawnMock.mockReturnValue({ unref: unrefMock });
    delete process.env.OMC_NOTIFY;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("spawns detached notification work with ignored stdio", async () => {
    const { dispatchNotificationInBackground } = await import("../background-notifications.js");

    dispatchNotificationInBackground("session-start", {
      sessionId: "sess-1",
      projectPath: "/tmp/project",
    });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["--input-type=module", "-e", expect.stringContaining("notify(\"session-start\"")],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: expect.objectContaining({ OMC_HOOK_BACKGROUND_CHILD: "1" }),
      }),
    );
    expect(unrefMock).toHaveBeenCalledOnce();
  });

  it("does not spawn when notifications are explicitly disabled", async () => {
    vi.stubEnv("OMC_NOTIFY", "0");
    const { dispatchNotificationInBackground } = await import("../background-notifications.js");

    dispatchNotificationInBackground("session-idle", { sessionId: "sess-1" });

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
