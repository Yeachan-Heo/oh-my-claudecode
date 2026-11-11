export function formatSwallowedError(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
export function logSwallowedError(context, error) {
    try {
        console.warn(`[omc] ${context}: ${formatSwallowedError(error)}`);
    }
    catch {
        // Never let logging a swallowed error throw.
    }
}
export function createSwallowedErrorLogger(context) {
    return (error) => {
        logSwallowedError(context, error);
    };
}
//# sourceMappingURL=swallowed-error.js.map