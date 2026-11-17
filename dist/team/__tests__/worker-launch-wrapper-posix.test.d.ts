/**
 * Regression suite for issue #3931 — POSIX worker launch wrapper content.
 *
 * buildWorkerLaunchWrapper() previously unconditionally emitted a Windows
 * .cmd batch script (CRLF, @echo off, %~dp0, %ERRORLEVEL%) on all platforms,
 * breaking worker launches on macOS/Linux. This suite pins the platform-aware
 * contract: Windows wrapper stays as batch, POSIX wrapper is a valid sh script.
 */
export {};
//# sourceMappingURL=worker-launch-wrapper-posix.test.d.ts.map