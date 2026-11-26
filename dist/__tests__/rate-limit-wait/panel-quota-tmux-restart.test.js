/**
 * The panel quota adapter against a real tmux server: a server that restarts at the same endpoint after the panes were
 * listed reuses the pane ids, so capture, the provider check and the keys must be refused for the pane that was listed.
 * Skipped where tmux is not installed. The server is private to the test (its own socket in a temporary directory).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { panelQuotaTmux } from '../../features/rate-limit-wait/tmux-detector.js';
const { TMUX: _tmux, ...ENV } = process.env;
const tmux = (socket, ...args) => spawnSync('tmux', [...(socket ? ['-S', socket] : []), ...args], { encoding: 'utf8', env: ENV });
const tmuxInstalled = process.platform !== 'win32' && tmux(null, '-V').status === 0;
describe.runIf(tmuxInstalled)('panel quota adapter: a tmux server that restarted after the listing', () => {
    const dirs = [];
    const sockets = [];
    afterEach(() => {
        for (const socket of sockets.splice(0))
            tmux(socket, 'kill-server');
        for (const dir of dirs.splice(0))
            rmSync(dir, { recursive: true, force: true });
    });
    function startServer(socket, command) {
        expect(tmux(socket, 'new-session', '-d', '-s', 'omc-team-restart', command).status).toBe(0);
    }
    it('refuses capture, the provider check and the keys for the pane of the earlier server run, and types nothing into the new one', () => {
        const dir = mkdtempSync(join('/tmp', 'pq-'));
        dirs.push(dir);
        const socket = join(dir, 's.sock');
        sockets.push(socket);
        startServer(socket, 'sleep 60');
        const [server, id] = tmux(socket, 'list-panes', '-a', '-F', '#{pid}:#{start_time} #{pane_id}').stdout.trim().split(' ');
        const listed = { id, server, socket, session: 'omc-team-restart', windowIndex: 0, paneIndex: 0, windowName: 'w' };
        expect(panelQuotaTmux.capture(listed, 5), 'the listed server answers').not.toBeNull();
        expect(panelQuotaTmux.providerRunning(listed)).toBe(true);
        // The server restarts at the same endpoint; the new server gives the same pane id to another worker.
        tmux(socket, 'kill-server');
        startServer(socket, 'cat');
        expect(tmux(socket, 'list-panes', '-a', '-F', '#{pane_id}').stdout.trim(), 'the id is reused').toBe(id);
        expect(panelQuotaTmux.capture(listed, 5)).toBeNull();
        expect(panelQuotaTmux.providerRunning(listed)).toBeNull();
        expect(panelQuotaTmux.sendContinue(listed)).toBe('not_attempted');
        expect(tmux(socket, 'capture-pane', '-t', id, '-p').stdout, 'a key reached the replacement pane').not.toContain('continue');
    });
    it('the identity of the program in the pane is stable while it runs and differs once another program takes the pane', () => {
        const dir = mkdtempSync(join('/tmp', 'pq-'));
        dirs.push(dir);
        const socket = join(dir, 's.sock');
        sockets.push(socket);
        startServer(socket, 'sleep 60');
        const [server, id] = tmux(socket, 'list-panes', '-a', '-F', '#{pid}:#{start_time} #{pane_id}').stdout.trim().split(' ');
        const listed = { id, server, socket, session: 'omc-team-restart', windowIndex: 0, paneIndex: 0, windowName: 'w' };
        const first = panelQuotaTmux.providerIdentity?.(listed);
        expect(first).toBeTruthy();
        expect(panelQuotaTmux.providerIdentity?.(listed)).toBe(first);
        // The program exits and an unrelated one takes the pane; the old error would still be on the screen.
        expect(tmux(socket, 'respawn-pane', '-k', '-t', id, 'cat').status).toBe(0);
        const second = panelQuotaTmux.providerIdentity?.(listed);
        expect(second).toBeTruthy();
        expect(second).not.toBe(first);
    });
});
//# sourceMappingURL=panel-quota-tmux-restart.test.js.map