export const colors = {
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    green: (text) => `\x1b[32m${text}\x1b[0m`,
    yellow: (text) => `\x1b[33m${text}\x1b[0m`,
    blue: (text) => `\x1b[34m${text}\x1b[0m`,
    magenta: (text) => `\x1b[35m${text}\x1b[0m`,
    cyan: (text) => `\x1b[36m${text}\x1b[0m`,
    gray: (text) => `\x1b[90m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`
};
export function formatTokenCount(tokens) {
    if (tokens < 1000)
        return `${tokens}`;
    if (tokens < 1000000)
        return `${(tokens / 1000).toFixed(1)}k`;
    return `${(tokens / 1000000).toFixed(2)}M`;
}
//# sourceMappingURL=formatting.js.map