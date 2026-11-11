export function saveAndClear(keys) {
    const saved = {};
    for (const key of keys) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    return saved;
}
export function restore(saved) {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
            delete process.env[key];
        }
        else {
            process.env[key] = value;
        }
    }
}
//# sourceMappingURL=test-helpers.js.map