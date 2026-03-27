export function formatSwallowedError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function logSwallowedError(context: string, error: unknown): void {
  try {
    console.warn(`[omc] ${context}: ${formatSwallowedError(error)}`);
  } catch {
    // Never let logging a swallowed error throw.
  }
}

export function createSwallowedErrorLogger(context: string): (error: unknown) => void {
  return (error: unknown) => {
    logSwallowedError(context, error);
  };
}
