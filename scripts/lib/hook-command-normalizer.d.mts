export const UNIX_HOOK_PREFIX: string;

export interface HookInvocation {
  script: string;
  extra: string[];
}

export function parseHookInvocation(hook: unknown): HookInvocation | null;

export function windowsExecArgs(script: string, extra?: string[]): string[];

export function unixShellCommand(script: string, extra?: string[]): string;

export function hookPrefixForPlatform(platform?: string): string;

export function normalizeHookCommand(command: string, prefix?: string): string;

export function normalizeHooksDataForPlatform(data: unknown, platform?: string): boolean;
