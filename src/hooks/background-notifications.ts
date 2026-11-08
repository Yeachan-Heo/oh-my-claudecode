import { spawn } from "child_process";
import type { NotificationEvent, NotificationPayload } from "../notifications/types.js";

export type BackgroundNotificationData = Partial<NotificationPayload> & {
  sessionId: string;
  profileName?: string;
};

/**
 * Dispatch hook-triggered notifications from an isolated detached Node process.
 *
 * Hook foreground processes have a strict stdout JSON protocol, and some CI
 * checks fail on unexpected stderr. Running notification work in-process means
 * late console output from notification formatters, transport failures, custom
 * integrations, or transitive modules can pollute the foreground hook streams.
 * The detached child uses stdio: "ignore" so all notification stdout/stderr is
 * isolated while the foreground hook can return its protocol payload promptly.
 */
export function dispatchNotificationInBackground(
  event: NotificationEvent,
  data: BackgroundNotificationData,
): void {
  if (process.env.OMC_NOTIFY === "0") return;

  let serializedEvent: string;
  let serializedData: string;
  try {
    serializedEvent = JSON.stringify(event);
    serializedData = JSON.stringify(data);
  } catch {
    return;
  }

  const notificationsModuleUrl = new URL(
    "../notifications/index.js",
    import.meta.url,
  ).href;

  const childSource = `import(${JSON.stringify(notificationsModuleUrl)})\n` +
    `  .then(({ notify }) => notify(${serializedEvent}, ${serializedData}))\n` +
    `  .catch(() => {});`;

  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        OMC_HOOK_BACKGROUND_CHILD: "1",
      },
    });
    child.unref();
  } catch {
    // Best-effort only: notification dispatch must never break hook handling.
  }
}
