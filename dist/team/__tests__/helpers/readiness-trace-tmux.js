// The tmux mock behind readiness-trace.harness.test.ts. readiness-diff.mjs copies
// it into the base checkout with the harness, so it imports nothing.
export const PANE_ID = '%2';
export const trace = {
    frame: '',
    pane: null,
    startedAt: 0,
    keys: [],
    unknown: [],
};
// POSIX shell word splitting for the quoting forms the tmux helpers emit:
// single quotes (shellQuote's '"'"' included), double quotes, backslashes, and
// words glued together. Returns null for anything else (expansions, operators,
// unbalanced quotes) so the caller keeps the original text instead of guessing.
function shellWords(command) {
    const words = [];
    let word = null;
    for (let index = 0; index < command.length; index++) {
        const char = command[index];
        if (char === ' ' || char === '\t') {
            if (word !== null)
                words.push(word);
            word = null;
        }
        else if (char === "'") {
            const end = command.indexOf("'", index + 1);
            if (end < 0)
                return null;
            word = (word ?? '') + command.slice(index + 1, end);
            index = end;
        }
        else if (char === '"') {
            let text = '';
            for (index++; index < command.length && command[index] !== '"'; index++) {
                const inner = command[index];
                if (inner === '$' || inner === '`')
                    return null;
                if (inner === '\\' && '$`"\\'.includes(command[index + 1] ?? ''))
                    index++;
                text += command[index];
            }
            if (index >= command.length)
                return null;
            word = (word ?? '') + text;
        }
        else if (char === '\\') {
            if (index + 1 >= command.length || command[index + 1] === '\n')
                return null;
            word = (word ?? '') + command[++index];
        }
        else if (/[$`;&|<>(){}[\]*?~#!\n]/.test(char)) {
            return null;
        }
        else {
            word = (word ?? '') + char;
        }
    }
    if (word !== null)
        words.push(word);
    return words;
}
function recordSend(fn, args, guarded) {
    const target = args.indexOf('-t');
    const keys = args.filter((_, index) => index !== 0 && index !== target && index !== target + 1);
    trace.keys.push({
        fn,
        pane: target >= 0 ? args[target + 1] ?? '' : '',
        guarded,
        keys,
        at_ms: Date.now() - trace.startedAt,
    });
    trace.pane?.send(keys);
}
// `send` is tmux's alias of send-keys.
const SEND_COMMANDS = new Set(['send', 'send-keys']);
// tmux splits argv into several commands at an argument that is `;` or ends in
// an unescaped `;`. A query followed by a send must not be answered as a query.
const chainsCommands = (args) => args.some(arg => /(^|[^\\]);$/.test(arg));
// runGuardedNativeTmuxCommand appends exactly one marker command. Anything after
// it would run unrecorded, so only a trailing marker counts.
const GUARDED_SUCCESS = /^(.*); display-message -p '?(OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+)'?$/s;
export function fakeTmux(fn, rawArgs) {
    let index = 0;
    while (rawArgs[index] === '-S')
        index += 2;
    const args = rawArgs.slice(index);
    const command = args[0];
    if (chainsCommands(args)) {
        trace.unknown.push(`${fn}: ${JSON.stringify(args)}`);
        return '';
    }
    if (command === 'capture-pane')
        return trace.pane?.capture() ?? trace.frame;
    if (command === 'list-panes')
        return `${PANE_ID}\n`;
    if (command === 'display-message') {
        if (args.includes('#{pid}'))
            return `${process.pid}\n`;
        if (args.includes('#{pane_dead} #{pane_current_command}'))
            return '0 cmd\n';
        if (args.includes('#{pane_dead}'))
            return '0\n';
        if (args.includes('#{pane_in_mode}'))
            return '0\n';
    }
    if (command === 'if-shell') {
        const success = args[2] ?? '';
        const match = success.match(GUARDED_SUCCESS);
        const native = match ? shellWords(match[1]) : null;
        if (native !== null && SEND_COMMANDS.has(native[0] ?? ''))
            recordSend(fn, native, true);
        else
            trace.unknown.push(`${fn}: if-shell ${success}`);
        return match ? `${match[2]}\n` : '';
    }
    if (SEND_COMMANDS.has(command ?? '')) {
        recordSend(fn, args, false);
        return '';
    }
    trace.unknown.push(`${fn}: ${JSON.stringify(args)}`);
    return '';
}
export function fakeShell(fn, command) {
    const words = shellWords(command);
    if (words !== null && words.length > 0)
        return fakeTmux(fn, words);
    trace.unknown.push(`${fn}: ${command}`);
    return '';
}
// Every tmux-utils function that starts a tmux process, routed through the mock.
// readiness-trace-tmux.test.ts fails when tmux-utils gains one this map lacks.
export function tmuxUtilsOverrides() {
    return {
        tmuxExec: (args) => fakeTmux('tmuxExec', args),
        tmuxShell: (command) => fakeShell('tmuxShell', command),
        tmuxExecAsync: async (args) => ({ stdout: fakeTmux('tmuxExecAsync', args), stderr: '' }),
        tmuxCmdAsync: async (args) => ({ stdout: fakeTmux('tmuxCmdAsync', args), stderr: '' }),
        tmuxShellAsync: async (command) => ({ stdout: fakeShell('tmuxShellAsync', command), stderr: '' }),
        tmuxSpawn: (args) => {
            const stdout = fakeTmux('tmuxSpawn', args);
            return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
        },
    };
}
//# sourceMappingURL=readiness-trace-tmux.js.map