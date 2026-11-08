/** Shared public types for the lookout feature. */
export class LookoutError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
        this.name = "LookoutError";
    }
}
//# sourceMappingURL=types.js.map