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
export declare function dispatchNotificationInBackground(event: NotificationEvent, data: BackgroundNotificationData): void;
//# sourceMappingURL=background-notifications.d.ts.map