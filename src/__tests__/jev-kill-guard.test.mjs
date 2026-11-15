/**
 * Kill guard (scripts/lib/jev-kill-guard.mjs) and its wiring into the PreToolUse hook (opt-in: OMC_JEV_KILL_GUARD=1).
 * The decision tables use neutral names; the protected names of the tables come from the environment of each run.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { afterAll, describe, it, test } from 'vitest';
import * as KG from '../../scripts/lib/jev-kill-guard.mjs';
import { keyHash, denialKey } from '../../scripts/lib/jev-denial-counter.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLEANUPS = [];
afterAll(() => {
  for (const path of CLEANUPS.splice(0)) rmSync(path, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-kill-guard-'));
  CLEANUPS.push(dir);
  return dir;
}

// Neutral names of the decision tables. Generic names (caddy, sshd, docker and similar) are kept as they are.
const FIXTURE_SERVICES = [
  'example-web', 'example-worker', 'example-proxy', 'example-demo-web', 'example-app-prod', 'example-terminal',
  'example-slice', 'example-user@0', 'example-x', 'caddy', 'sshd', 'ssh', 'cron', 'docker', 'containerd', 'earlyoom',
  'syncthing@syncthing',
];
const FIXTURE_CONTAINERS = ['example-db-prod', 'example-cache'];
const FIXTURE_ENV = {
  OMC_JEV_KILL_GUARD: '1',
  OMC_JEV_KILL_GUARD_SERVICES: FIXTURE_SERVICES.join(','),
  OMC_JEV_KILL_GUARD_CONTAINERS: FIXTURE_CONTAINERS.join(','),
};
// Fixed description of the ancestors of the hook (the tables do not depend on the real process tree).
const TABLE_ANCESTORS = {
  pids: new Set([4242, 4243]),
  pgids: new Set([4242]),
  hasProc: true,
  comms: ['bash', 'example-wrapper'],
  cmdline: ['/opt/example/bin/example-wrapper --settings x.json', '/bin/bash /tmp/example-wrapper/run example-wrapper'],
};
const RT = (command) => KG.judgeKill(command, FIXTURE_ENV, '/opt/example', { ancestors: TABLE_ANCESTORS });
const R = (command, env = {}) => KG.judgeKill(command, { ...FIXTURE_ENV, ...env });
const REFUSAL_SHAPE = /^\[KILL-GUARD\] refused: .*requires an explicit operator instruction\.$/;

test('table p1: basic refusals, wrappers, shell syntax, pkill selectors', () => {
  const T = (n, o) => ({ n, o });
  const table = [
    T('/bin/kill 1', 'refuse'), T('env kill 1', 'refuse'), T('command kill 1', 'refuse'), T('exec kill 1', 'refuse'), T('builtin kill 1', 'refuse'),
    T('time kill 1', 'refuse'), T('sudo kill 1', 'refuse'), T('timeout 5 pkill -f caddy', 'refuse'),
    T("sh -c 'kill 1'", 'refuse'), T("bash -lc 'kill 1'", 'refuse'), T("bash -ic 'kill 1'", 'refuse'), T("bash --login -c 'kill 1'", 'refuse'),
    T('echo 1 | xargs kill', 'refuse'), T('kill -s TERM 1', 'refuse'), T('kill -SIGKILL 1', 'refuse'),
    T('killall5', 'refuse'), T('killall5 -9', 'refuse'),
    T('service caddy restart', 'refuse'), T('service docker stop', 'refuse'),
    T('docker stop example-db-prod', 'refuse'), T('docker restart example-db-prod', 'refuse'), T('docker rm -f example-db-prod', 'refuse'),
    T('docker rm -fv example-db-prod', 'refuse'), T('docker rm -vf example-db-prod', 'refuse'), T('docker kill example-db-prod', 'refuse'),
    T('docker compose -f /opt/x/docker-compose.yml down', 'refuse'), T('docker compose -f /opt/x/docker-compose.yml restart', 'refuse'), T('docker compose -p x down', 'refuse'),
    T('docker compose down', 'refuse'), T('docker-compose down', 'refuse'), T('docker-compose -f x.yml down', 'refuse'),
    T('docker compose --project-directory /opt/x down', 'refuse'), T('docker -H unix:///var/run/docker.sock stop example-db-prod', 'refuse'),
    T('docker stop $(docker ps -q)', 'refuse'), T('docker rm -f $(docker ps -aq)', 'refuse'), T('docker kill $(docker ps -q)', 'refuse'),
    T('docker stop $CID', 'refuse'), T('docker stop "$C"', 'refuse'),
    T('docker update --restart=no example-db-prod', 'pass'), T('docker system prune -af', 'pass'), T('docker container prune -f', 'pass'),
    T('systemctl --user stop caddy', 'refuse'), T('systemctl -t service stop caddy', 'refuse'), T('systemctl -H root@host stop caddy', 'refuse'),
    T('systemctl stop caddy', 'refuse'), T('systemctl stop caddy.service', 'refuse'), T('systemctl restart docker', 'refuse'),
    T('systemctl reboot', 'refuse'), T('systemctl poweroff', 'refuse'),
    T('reboot', 'refuse'), T('shutdown -h now', 'refuse'), T('poweroff', 'refuse'), T('init 0', 'refuse'),
    T('systemctl isolate rescue.target', 'refuse'), T('systemctl stop example-x.timer', 'refuse'), T('systemctl stop example-web example-worker', 'refuse'),
    T('systemctl disable --now caddy', 'refuse'), T('systemctl try-reload-or-restart caddy', 'refuse'),
    T('systemctl reload caddy', 'pass'), T('systemctl daemon-reexec', 'pass'),
    T('kill 1 && echo ok', 'refuse'), T('echo ok; kill 1', 'refuse'), T('echo ok | kill 1', 'refuse'), T('echo $(kill 1)', 'refuse'), T('echo `kill 1`', 'refuse'),
    T('pkill claude', 'refuse'), T('pkill -f claude', 'refuse'),
    T('killall claude', 'refuse'), T('pkill -f example-wrapper', 'refuse'), T('pkill tmux', 'refuse'), T('killall tmux', 'refuse'),
    T('pkill -f "claude-test-xyz"', 'pass'), T('pkill -f "tmux new -s test"', 'pass'),
    T('pkill -f bash', 'refuse'), T('pkill bash', 'refuse'),
    T('pkill -f example-session', 'pass'),
    T('pkill -u root', 'refuse'), T('pkill -9 -u root', 'refuse'), T('pkill -u $USER', 'refuse'), T('killall -u root', 'refuse'), T('pkill -t pts/0', 'refuse'),
    T('pkill -f example-term', 'refuse'),
    T('pkill sshd', 'refuse'), T('pkill -x sshd', 'refuse'), T('pkill -9 -f "ssh"', 'refuse'),
    T('kill 0', 'pass'), T('kill -9 0', 'pass'), T('kill -- -0', 'pass'),
    T('eval "kill 1"', 'pass'), T("eval 'docker stop example-db-prod'", 'pass'),
    T('echo "kill 1" | sh', 'pass'), T('echo "kill 1" | bash', 'pass'),
    T('find /proc -name x -exec kill 1 {} \\;', 'pass'), T('python3 -c "import os; os.kill(1,9)"', 'pass'),
    T("ssh localhost 'docker stop example-db-prod'", 'pass'),
    T("su -c 'kill 1'", 'refuse'), T('nsenter -t 1 -m kill 1', 'refuse'), T('watch kill 1', 'refuse'), T('chroot / kill 1', 'refuse'),
    T('nohup kill 1', 'refuse'), T('setsid kill 1', 'refuse'), T('ionice kill 1', 'refuse'), T('stdbuf kill 1', 'refuse'), T('unbuffer kill 1', 'pass'),
    T('(kill 1)', 'refuse'), T('{ kill 1; }', 'refuse'), T('if true; then kill 1; fi', 'refuse'), T('for i in 1; do kill $i; done', 'pass'),
    T('kill 1 2>/dev/null', 'refuse'), T('kill -9 1 >/dev/null 2>&1', 'refuse'), T('\\kill 1', 'refuse'), T('"kill" 1', 'refuse'), T("'kill' 1", 'refuse'),
    T('k=kill; $k 1', 'pass'),
  ];
  for (const { n, o } of table) {
    const expected = typeof o === 'function' ? o() : o;
    const w = RT(n);
    const decision = w?.refuse ? 'refuse' : 'pass';
    assert.equal(decision, expected, `p1: ${JSON.stringify(n)} → ${decision} (expected ${expected})${w?.refuse ? ': ' + w.reason : ''}`);
  }
});

test('table p2: kill targets, pkill patterns, compose, heredoc', () => {
  const T = (n, o) => ({ n, o });
  const table = [
    T('kill $PID', 'pass'), T('kill "$PID"', 'pass'), T('kill $!', 'pass'), T('kill "$!"', 'pass'),
    T('kill %1', 'pass'), T('kill -TERM $PID', 'pass'), T('kill -9 $SERVER_PID 2>/dev/null', 'pass'),
    T('kill $(cat /tmp/x.pid)', 'pass'), T('kill $(jobs -p)', 'pass'),
    T('kill $$', 'refuse'), T('kill -0 $PID', 'pass'), T('kill -s 0 $PID', 'pass'), T('kill ${PID}', 'pass'),
    T('kill 12345', 'pass'), T('kill -9 12345', 'pass'),
    T('sleep 100 & kill $!', 'pass'), T('node srv.mjs & PID=$!; sleep 1; kill $PID; wait $PID', 'pass'),
    T('pkill -f "node test/server.mjs"', 'pass'), T('pkill -f "node test/server.mjs" || true', 'pass'), T('pkill -f test-server', 'pass'),
    T('pkill -f "python3 -m http.server 8123"', 'pass'), T('pkill -f "http.server"', 'pass'),
    T('pkill -f "node /tmp/x/server.mjs"', 'pass'),
    T('pkill -P $$', 'pass'), T('pkill -P 1234', 'pass'),
    T('pkill -f node', 'refuse'), T('pkill node', 'refuse'), T('pkill -f "node --test"', 'pass'), T('pkill python', 'refuse'),
    T('pkill -f "npm test"', 'pass'), T('pkill -f vitest', 'pass'), T('pkill -f "tsx watch"', 'pass'),
    T('pkill -f "sleep 100"', 'pass'), T('pkill -f "sleep"', 'pass'), T('pkill -f test', 'pass'),
    T('pkill -f "example-kill-test"', 'pass'),
    T('pkill -f e', 'pass'), T('pkill -f "my-server"', 'pass'),
    T('pkill -f "caddy-test"', 'pass'), T('pkill -f "ssh-agent"', 'pass'), T('pkill ssh-agent', 'pass'),
    T('pkill -f "docker-proxy"', 'pass'), T('pkill -f "cron-sim"', 'pass'), T('pkill -f "dockerd-test"', 'pass'),
    T("pkill -f 'example-scratch/x'", 'pass'), T('pkill -f /tmp/x/server.mjs', 'pass'), T('pkill -f "$TMPDIR/server"', 'pass'),
    T('pkill -f "^node test"', 'pass'), T('pkill -f "node (a|b)"', 'pass'),
    T("pkill -f '\\.mjs'", 'pass'),
    T('pkill -f "port=8123"', 'pass'), T('pkill -f "--port 8123"', 'pass'), T('pkill -f "--port=8123"', 'pass'),
    T('pkill -f "x.py"', 'pass'),
    T('killall node', 'refuse'), T('killall sleep', 'pass'), T('killall -9 mojproces', 'pass'),
    T('docker compose down', 'refuse'), T('docker compose -f docker-compose.test.yml down', 'refuse'),
    T('docker compose up -d', 'pass'), T('docker compose ps', 'pass'), T('docker compose logs', 'pass'),
    T('docker logs example-db-prod', 'pass'), T('docker ps', 'pass'),
    T('docker stop mojtest', 'pass'), T('docker rm mojtest', 'pass'), T('docker rm -f mojtest', 'pass'),
    T('docker run --rm x', 'pass'), T('docker stop mojtest-1', 'pass'), T('docker kill testowy', 'pass'),
    T('systemctl status caddy', 'pass'), T('systemctl is-active caddy', 'pass'), T('systemctl restart mojtest', 'pass'),
    T('systemctl --user restart mojtest', 'pass'), T('systemctl stop cron-test', 'pass'), T('systemctl stop docker-test', 'pass'),
    T('systemctl list-units', 'pass'), T('journalctl -u caddy', 'pass'),
    T('cat > x.sh <<\'EOF2\'\nkill $PID\nEOF2', 'pass'), T('cat > x.sh <<\'EOF2\'\ndocker compose down\nEOF2', 'pass'),
    T("cat <<EOF2\nit's\nEOF2\nkill 1", 'refuse'),
    T('git commit -m "fix: kill 1 pid guard"', 'pass'),
    T('git commit -m "$(cat <<\'EOF2\'\nfix\n\nkill 1 przez docker compose down\ndocker stop example-db-prod\nEOF2\n)"', 'pass'),
    T('echo "kill 1"', 'pass'), T('echo kill 1', 'pass'),
    T('grep -rn "pkill" .', 'pass'), T('grep -n "systemctl stop caddy" file', 'pass'),
    T("echo 'docker stop example-db-prod' > x.sh", 'pass'), T("printf 'kill 1\n' > x.sh", 'pass'),
    T('node -e "process.kill(1)"', 'pass'), T('nohup node srv.mjs > /dev/null 2>&1 &', 'pass'),
  ];
  for (const { n, o } of table) {
    const expected = typeof o === 'function' ? o() : o;
    const w = RT(n);
    const decision = w?.refuse ? 'refuse' : 'pass';
    assert.equal(decision, expected, `p2: ${JSON.stringify(n)} → ${decision} (expected ${expected})${w?.refuse ? ': ' + w.reason : ''}`);
  }
});

test('table p3: quoting, comments, substitutions, systemctl gaps, uncertain docker targets', () => {
  const T = (n, o) => ({ n, o });
  const table = [
    T('echo "it\'s"; kill 1', 'refuse'), T("cat <<EOF2\nit's\nEOF2\nkill 1", 'refuse'), T("cat <<'EOF2'\ndon't\nEOF2\nsystemctl stop caddy", 'refuse'),
    T('echo a#b; kill 1', 'refuse'), T("echo '#'; kill 1", 'refuse'), T('kill 1 # komentarz', 'refuse'),
    T('kill\t1', 'refuse'), T('kill 1&', 'refuse'), T(';kill 1', 'refuse'),
    T('x=$(kill 1)', 'refuse'), T('echo "$(kill 1)"', 'refuse'), T('echo `kill 1`', 'refuse'),
    T('sudo -u root kill 1', 'refuse'), T('env -i kill 1', 'refuse'), T('env FOO=1 kill 1', 'refuse'), T('sudo env kill 1', 'refuse'),
    T('nice -n 5 kill 1', 'refuse'), T('timeout -s KILL 5 kill 1', 'refuse'), T('timeout 5s kill 1', 'refuse'),
    T('xargs -n1 kill', 'refuse'), T('xargs -I{} kill {}', 'refuse'), T('pgrep -f x | xargs kill', 'refuse'), T('pgrep -f x | xargs -r kill -9', 'refuse'),
    T("bash -c 'kill 1' extra", 'refuse'), T('bash -c "echo hi; kill 1"', 'refuse'), T("bash -c 'bash -c \"kill 1\"'", 'refuse'),
    T("sudo bash -c 'systemctl stop caddy'", 'refuse'), T('sh -c "docker stop example-db-prod"', 'refuse'),
    T('busybox kill 1', 'refuse'),
    T('kill -TERM 1', 'refuse'), T('kill -KILL 1', 'refuse'), T('kill -s KILL 1', 'refuse'), T('kill -s9 1', 'refuse'), T('kill -n 9 1', 'refuse'),
    T('kill --signal=KILL 1', 'refuse'), T('kill --signal KILL 1', 'refuse'),
    T('kill -9 -- 1', 'refuse'), T('kill 01', 'refuse'), T('kill +1', 'refuse'),
    T('kill 1 2', 'refuse'), T('kill 2 1', 'refuse'), T('kill 100 1', 'refuse'), T('kill -- 1', 'refuse'), T('kill -HUP 1', 'refuse'),
    T('kill -9 $PPID', 'refuse'), T('kill -TERM "$PPID"', 'refuse'),
    T('systemctl restart caddy.service', 'refuse'), T('systemctl stop --now caddy', 'refuse'), T('systemctl stop -- caddy', 'refuse'),
    T('systemctl restart "caddy"', 'refuse'), T("systemctl stop 'example-*'", 'refuse'), T('systemctl restart caddy docker', 'refuse'),
    T('systemctl stop caddy@x', 'pass'), T('systemctl mask --now caddy', 'refuse'), T('systemctl disable caddy', 'pass'),
    T('systemctl kill -s KILL caddy', 'refuse'), T('systemctl set-property caddy.service MemoryMax=1M', 'pass'),
    T('systemctl stop example-slice.slice', 'refuse'), T('systemctl stop example-user@0.service', 'refuse'),
    T('systemctl stop systemd-logind', 'refuse'), T('systemctl stop networking', 'refuse'), T('systemctl stop systemd-networkd', 'refuse'),
    T('systemctl stop systemd-logind.service', 'refuse'), T('systemctl stop networking.service', 'refuse'), T('systemctl stop systemd-networkd.service', 'refuse'), T('systemctl stop systemd-journald', 'pass'),
    T('loginctl terminate-session 1', 'refuse'), T('loginctl kill-user root', 'refuse'), T('machinectl poweroff x', 'refuse'),
    T('docker container stop example-db-prod', 'refuse'), T('docker container rm -f example-db-prod', 'refuse'),
    T('docker stop -t 0 example-db-prod', 'refuse'), T('docker stop --time 5 example-db-prod', 'refuse'), T('docker stop mojtest example-db-prod', 'refuse'),
    T('docker rm -f $(docker ps -aq)', 'refuse'), T('docker ps -q | xargs docker stop', 'refuse'), T('docker ps -q | xargs -r docker kill', 'refuse'),
    T('docker stop $(docker ps -q --filter name=pp)', 'refuse'),
    T('docker compose stop', 'refuse'), T('docker compose stop web', 'refuse'), T('docker compose restart', 'refuse'), T('docker compose kill', 'refuse'),
    T('docker compose -f x.yml stop', 'refuse'), T('docker compose rm -sf', 'refuse'),
    T('docker stack rm x', 'refuse'),
    T('docker volume rm x', 'pass'),
    T('docker run --rm -v /var/run/docker.sock:/var/run/docker.sock docker stop example-db-prod', 'pass'),
    T('docker exec example-db-prod kill 1', 'pass'), T('docker exec example-db-prod sh -c "kill 1"', 'pass'),
    T('docker restart example-cache', 'refuse'), T('docker  stop  example-cache', 'refuse'), T('/usr/bin/docker stop example-cache', 'refuse'), T('sudo docker stop example-cache', 'refuse'), T('sudo -E docker stop example-cache', 'refuse'),
  ];
  for (const { n, o } of table) {
    const expected = typeof o === 'function' ? o() : o;
    const w = RT(n);
    const decision = w?.refuse ? 'refuse' : 'pass';
    assert.equal(decision, expected, `p3: ${JSON.stringify(n)} → ${decision} (expected ${expected})${w?.refuse ? ': ' + w.reason : ''}`);
  }
});

test('table p4-p7: per-wrapper flags, nesting depth, broadcast, stop-everything commands, service', () => {
  const T = (n, o) => ({ n, o });
  const table = [
    T('sudo -n kill 1', 'refuse'), T('sudo -n systemctl restart caddy', 'refuse'), T('sudo -E systemctl restart caddy', 'refuse'),
    T('sudo -i kill 1', 'refuse'), T('sudo -H kill 1', 'refuse'), T('sudo -S kill 1', 'refuse'), T('sudo -u root -H kill 1', 'refuse'), T('sudo -- kill 1', 'refuse'),
    T('env -i kill 1', 'refuse'), T('env -u X kill 1', 'refuse'), T("env -S 'kill 1'", 'refuse'),
    T('timeout --signal=KILL 5 kill 1', 'refuse'), T('timeout -k 1 5 kill 1', 'refuse'),
    T('nohup sudo kill 1', 'refuse'), T('sudo nohup kill 1', 'refuse'), T('sudo timeout 5 docker stop example-db-prod', 'refuse'),
    T('xargs -a f kill', 'refuse'), T('xargs -0 kill', 'refuse'), T('xargs --no-run-if-empty kill', 'refuse'),
    T("bash -ec 'kill 1'", 'refuse'), T("bash -xc 'kill 1'", 'refuse'), T('sh -lc "systemctl stop caddy"', 'refuse'),
    T("zsh -c 'kill 1'", 'refuse'), T("dash -c 'kill 1'", 'refuse'), T("bash -c 'kill 1'", 'refuse'), T('bash -c "kill 1"', 'refuse'), T("/bin/bash -c 'kill 1'", 'refuse'),
    T("sudo -u flota bash -lc 'docker stop example-db-prod'", 'refuse'),
    T('echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(kill 1))))))))))', 'refuse'),
    T('echo $(echo $(echo $(kill 1)))', 'refuse'),
    T('kill -- -1', 'refuse'), T('kill -9 -1', 'refuse'), T('kill -TERM -1', 'refuse'), T('kill -s KILL -1', 'refuse'), T('kill -9 -- -1', 'refuse'),
    T('kill -l', 'pass'), T('kill -L', 'pass'),
    T('tmux kill-server', 'refuse'), T('fuser -k 443/tcp', 'refuse'), T('fuser -k 8080/tcp', 'refuse'), T('lsof -t -i:3000 | xargs kill -9', 'refuse'),
    T('pkill -f "^/usr/bin/caddy"', 'refuse'), T('pkill -f "/usr/sbin/cron"', 'refuse'), T('pkill -f "caddy run"', 'refuse'),
    T('pkill -f uvicorn', 'pass'), T('pkill -f gunicorn', 'pass'),
    T('command systemctl restart caddy', 'refuse'), T('time docker stop example-db-prod', 'refuse'), T('exec systemctl stop caddy', 'refuse'),
    T('if systemctl is-active caddy; then systemctl restart caddy; fi', 'refuse'), T('for c in a; do docker stop example-db-prod; done', 'refuse'), T('while true; do docker restart example-cache; done', 'refuse'),
    T("cat <<EOF2\nit's\nEOF2\nsystemctl restart caddy", 'refuse'), T('cat <<EOF2\nnormalny tekst\nEOF2\nsystemctl restart caddy', 'refuse'),
    T('pkill -P 1', 'refuse'), T('pkill -F /run/x.pid', 'pass'),
    T('docker compose -f x.yml stop', 'refuse'), T('docker compose rm -sf', 'refuse'), T('docker compose -f x.yml rm -sf', 'refuse'),
    T('OMC_JEV_KILL_GUARD=0 kill 1', 'refuse'), T('DISABLE_OMC=1 kill 1', 'refuse'), T('export OMC_JEV_KILL_GUARD=0; kill 1', 'refuse'),
    T('systemctl try-reload-or-restart caddy', 'refuse'), T('systemctl start reboot.target', 'refuse'), T('systemctl kexec', 'refuse'), T('systemctl halt', 'refuse'),
    T("bash -lc 'systemctl restart caddy'", 'refuse'), T('sh -lc "docker stop example-db-prod"', 'refuse'),
    T('service caddy restart', 'refuse'), T('/etc/init.d/cron stop', 'refuse'),
  ];
  for (const { n, o } of table) {
    const expected = typeof o === 'function' ? o() : o;
    const w = RT(n);
    const decision = w?.refuse ? 'refuse' : 'pass';
    assert.equal(decision, expected, `p4-p7: ${JSON.stringify(n)} → ${decision} (expected ${expected})${w?.refuse ? ': ' + w.reason : ''}`);
  }
});


test('refuses the twelve commands of the acceptance set with the refusal form', () => {
  const ancestors = KG.protectedAncestors();
  assert.ok(ancestors.hasProc, 'no /proc in the test environment (Linux expected)');
  const refusals = [
    'kill -1',
    'kill 1',
    'kill -9 1',
    `kill ${process.ppid}`,
    `kill -- -${[...ancestors.pgids][0]}`,
    'pkill -f example-terminal',
    'killall caddy',
    'sudo systemctl restart caddy',
    'systemctl stop example-app-prod.service',
    'docker stop example-db-prod',
    "bash -c 'kill 1'",
    'echo x && killall -9 sshd',
  ];
  for (const command of refusals) {
    const verdict = R(command);
    assert.ok(verdict?.refuse, `command that must be refused was not: ${command} -> ${JSON.stringify(verdict)}`);
    assert.match(verdict.reason, REFUSAL_SHAPE);
  }
});

test('passes five commands without a false refusal; the test sends no signal except kill -0 and its own child', async () => {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  try {
    assert.ok(Number.isFinite(child.pid), 'child sleep has no pid');
    const passing = [
      `kill ${child.pid}`,
      'pkill -f example-unrelated-process',
      'systemctl status caddy',
      'docker ps',
      `kill -0 ${child.pid}`,
    ];
    for (const command of passing) assert.equal(R(command), null, `false refusal: ${command} -> ${JSON.stringify(R(command))}`);
  } finally {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

test('the default lists are empty: a name is protected only when it is configured', () => {
  const on = { OMC_JEV_KILL_GUARD: '1' };
  assert.equal(KG.judgeKill('systemctl stop example-web', on), null, 'no default service list');
  assert.equal(KG.judgeKill('docker stop example-db-prod', on), null, 'no default container list');
  assert.ok(KG.judgeKill('kill 1', on)?.refuse, 'pid 1 is protected without any configuration');
  assert.ok(KG.judgeKill('systemctl stop example-unit-x', { OMC_JEV_KILL_GUARD: '1', OMC_JEV_KILL_GUARD_SERVICES: 'example-unit-x' })?.refuse, 'a configured service is protected');
  assert.ok(KG.judgeKill('docker stop example-db-prod', { OMC_JEV_KILL_GUARD: '1', OMC_JEV_KILL_GUARD_CONTAINERS: 'example-db-prod' })?.refuse, 'a configured container is protected');
  assert.ok(KG.judgeKill('systemctl stop example-unit-x', { OMC_JEV_KILL_GUARD: '1', OMC_JEV_KILL_GUARD_CONTAINERS: 'example-unit-x' })?.refuse, 'the container list feeds the same name list');
});

describe('switch OMC_JEV_KILL_GUARD', () => {
  it('is on only for the exact value 1; without it the judge returns null for every command', () => {
    for (const value of [undefined, '', '0', 'on', 'true']) {
      const env = value === undefined ? {} : { OMC_JEV_KILL_GUARD: value };
      assert.equal(KG.judgeKill('kill 1', env), null, `switch value ${JSON.stringify(value)} must keep the guard off`);
      assert.equal(KG.judgeKill('docker stop example-db-prod', { ...env, OMC_JEV_KILL_GUARD_CONTAINERS: 'example-db-prod' }), null);
    }
    assert.ok(KG.judgeKill('kill 1', { OMC_JEV_KILL_GUARD: '1' })?.refuse, 'value 1 turns the guard on');
    assert.ok(KG.judgeKill('kill 1', { OMC_JEV_KILL_GUARD: ' 1 ' })?.refuse, 'value 1 with blanks turns the guard on');
  });
});

describe('OMC_JEV_KILL_GUARD_ALLOW', () => {
  const allow = (names) => ({ ...FIXTURE_ENV, OMC_JEV_KILL_GUARD_ALLOW: names });

  it('lifts the name-based rules of the listed names only', () => {
    assert.equal(KG.judgeKill('systemctl stop example-web', allow('example-web'), '/opt/example', { ancestors: TABLE_ANCESTORS }), null, 'listed service passes');
    assert.ok(KG.judgeKill('systemctl stop example-worker', allow('example-web'), '/opt/example', { ancestors: TABLE_ANCESTORS })?.refuse, 'unlisted service stays protected');
    assert.equal(KG.judgeKill('pkill claude', allow('claude'), '/opt/example', { ancestors: TABLE_ANCESTORS }), null, 'listed generic name passes');
    assert.ok(KG.judgeKill('pkill claude', { OMC_JEV_KILL_GUARD: '1' }, '/opt/example', { ancestors: TABLE_ANCESTORS })?.refuse, 'generic name is protected without the list');
  });

  it('never lifts pid, ancestor, system unit or whole-system rules', () => {
    const everything = allow('example-web,init,systemd,caddy,systemd-logind,example-wrapper');
    for (const command of ['kill 1', 'kill 4242', 'kill -- -4242', 'systemctl reboot', 'systemctl stop systemd-logind', 'pkill -f example-wrapper', 'kill $$']) {
      assert.ok(KG.judgeKill(command, everything, '/opt/example', { ancestors: TABLE_ANCESTORS })?.refuse, `must stay refused: ${command}`);
    }
  });

  it('an empty list gives the same decision as no list, on the table inputs', () => {
    const sample = ['kill 1', 'systemctl stop example-web', 'pkill -f example-terminal', 'docker stop example-db-prod', 'kill $PID', 'pkill -f example-unrelated-process'];
    for (const command of sample) {
      const withEmpty = KG.judgeKill(command, { ...FIXTURE_ENV, OMC_JEV_KILL_GUARD_ALLOW: '' }, '/opt/example', { ancestors: TABLE_ANCESTORS });
      const without = KG.judgeKill(command, FIXTURE_ENV, '/opt/example', { ancestors: TABLE_ANCESTORS });
      assert.deepEqual(withEmpty, without, command);
    }
  });
});

test('the compose test-project exception is configured by OMC_JEV_KILL_GUARD_TEST_DIRS (default empty)', () => {
  const env = { ...FIXTURE_ENV };
  assert.ok(KG.judgeKill('docker compose down', env, '/tmp/example-project')?.refuse, 'no test directory by default');
  assert.equal(KG.judgeKill('docker compose down', { ...env, OMC_JEV_KILL_GUARD_TEST_DIRS: '/tmp' }, '/tmp/example-project'), null, 'working directory under a configured test directory');
  assert.ok(KG.judgeKill('docker compose down', env, '/opt/example')?.refuse, 'working directory outside the test directories');
  assert.ok(KG.judgeKill('docker compose -f /var/example-tests/x/compose.yml down', env, '/opt/example')?.refuse, '/var/example-tests is not a default test directory');
  const configured = { ...env, OMC_JEV_KILL_GUARD_TEST_DIRS: '/var/example-tests' };
  assert.equal(KG.judgeKill('docker compose -f /var/example-tests/x/compose.yml down', configured, '/opt/example'), null, 'configured test directory');
});

describe('hook wiring', () => {
  const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|DISABLE_OMC|CODEX)/i.test(name)));

  /** One PreToolUse run of the hook. A fresh transcript per run gives each run its own model response. */
  function runHook(root, env, sid, i, command = 'kill 1', hookRoot = ROOT) {
    const home = join(root, 'home');
    const project = join(root, 'project');
    const transcript = join(root, `transcript-${sid}-${i}.jsonl`);
    mkdirSync(project, { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: `msg-${sid}-${i}` } })}\n`);
    const hookEnv = {
      ...baseEnv(),
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      OMC_JEV_QUIET: '1',
      OMC_STATE_DIR: join(root, 'state'),
      OMC_JEV_LOG_DIR: join(root, 'jev'),
      ...env,
    };
    const result = spawnSync(process.execPath, [join(hookRoot, 'scripts', 'pre-tool-enforcer.mjs')], {
      cwd: project,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        session_id: sid,
        tool_use_id: `tool-${sid}-${i}`,
        transcript_path: transcript,
        cwd: project,
      }),
      env: hookEnv,
      encoding: 'utf8',
      timeout: 60000,
    });
    const output = result.stdout ? JSON.parse(result.stdout) : {};
    return { status: result.status, stderr: String(result.stderr || ''), output, reason: String(output.hookSpecificOutput?.permissionDecisionReason ?? '') };
  }

  function journal(root) {
    const path = join(root, 'jev', 'denials.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  }

  it('refuses kill 1 with the guard marker, the common sentences and the counter marker; escalates at the third repeat', () => {
    const root = tempDir();
    const env = { ...FIXTURE_ENV, OMC_JEV_DENIAL_COUNTER: '1' };
    const sid = 'kg-hook-escalate';
    const runs = [0, 1, 2].map((i) => runHook(root, env, sid, i));
    for (const run of runs) {
      assert.equal(run.status, 0, run.stderr.slice(0, 300));
      assert.equal(run.output.hookSpecificOutput?.permissionDecision, 'deny', run.reason.slice(0, 200));
      assert.ok(run.reason.includes('[KILL-GUARD]'), run.reason.slice(0, 200));
      assert.ok(run.reason.includes('requires an explicit operator instruction.'), run.reason.slice(0, 200));
      assert.match(run.reason, /\[denial [0-9a-f]{16} #\d+\]/);
      assert.ok(run.reason.includes('Action NOT performed: do not write that it succeeded.'));
      assert.ok(run.reason.includes('Do not repeat the same call: do independent work or change the plan.'));
    }
    assert.ok(!runs[0].reason.includes('[DENIAL COUNTER]'), 'no escalation at the first repeat');
    assert.ok(runs[2].reason.includes('[DENIAL COUNTER] The same denial of guard kill-guard has come 3 times'), runs[2].reason.slice(0, 400));
    const rows = journal(root).filter((row) => row.guard === 'kill-guard' && row.action === 'escalation-1');
    assert.equal(rows.length, 1, JSON.stringify(journal(root)).slice(0, 400));
    assert.equal(rows[0].n, 3);
    assert.equal(rows[0].tool_name, 'Bash');
  });

  it('lets a command that the judge does not refuse pass and writes no kill-guard row', () => {
    const root = tempDir();
    const run = runHook(root, { ...FIXTURE_ENV, OMC_JEV_DENIAL_COUNTER: '1' }, 'kg-hook-pass', 0, 'docker ps');
    assert.equal(run.status, 0, run.stderr.slice(0, 300));
    assert.notEqual(run.output.hookSpecificOutput?.permissionDecision, 'deny', run.reason.slice(0, 300));
    assert.equal(journal(root).filter((row) => row.guard === 'kill-guard').length, 0);
  });

  it('switch off: kill 1 passes, nothing is judged, no kill-guard row', () => {
    for (const value of [undefined, '0']) {
      const root = tempDir();
      const env = value === undefined ? { OMC_JEV_DENIAL_COUNTER: '1' } : { OMC_JEV_KILL_GUARD: value, OMC_JEV_DENIAL_COUNTER: '1' };
      const run = runHook(root, env, `kg-hook-off-${value ?? 'unset'}`, 0);
      assert.equal(run.status, 0, run.stderr.slice(0, 300));
      assert.notEqual(run.output.hookSpecificOutput?.permissionDecision, 'deny', `kill 1 refused with the switch ${value ?? 'unset'}: ${run.reason.slice(0, 300)}`);
      assert.equal(journal(root).filter((row) => row.guard === 'kill-guard').length, 0);
    }
  });

  it('judge error: the command passes and one state row kill-guard-error is written', () => {
    const root = tempDir();
    const copy = join(root, 'plugin');
    cpSync(join(ROOT, 'scripts'), join(copy, 'scripts'), { recursive: true });
    writeFileSync(join(copy, 'scripts', 'lib', 'jev-kill-guard.mjs'), 'const broken = {;\n', 'utf8');
    const run = runHook(root, { ...FIXTURE_ENV, OMC_JEV_DENIAL_COUNTER: '1' }, 'kg-hook-error', 0, 'kill 1', copy);
    assert.equal(run.status, 0, run.stderr.slice(0, 300));
    assert.notEqual(run.output.hookSpecificOutput?.permissionDecision, 'deny', run.reason.slice(0, 300));
    const rows = journal(root).filter((row) => row.guard === 'kill-guard');
    assert.equal(rows.length, 1, JSON.stringify(journal(root)).slice(0, 400));
    assert.equal(rows[0].action, 'kill-guard-error');
    assert.equal(rows[0].result, 'passed');
    assert.equal(rows[0].kind, 'state');
    assert.equal(rows[0].key, keyHash(denialKey('kill-guard', 'judge-error')));
  });
});

describe('ancestors injected for the tables', () => {
  it('pkill -f matches the command line of an ancestor only while that ancestor is present', () => {
    const ancestors = {
      pids: new Set([4242]),
      pgids: new Set([4242]),
      hasProc: true,
      comms: ['example-wrapper'],
      cmdline: ['/opt/example/bin/example-wrapper --settings /tmp/x/settings-example.json'],
    };
    const withAncestor = (command) => KG.judgeKill(command, FIXTURE_ENV, '/opt/example', { ancestors });
    const noAncestor = (command) => KG.judgeKill(command, FIXTURE_ENV, '/opt/example', {
      ancestors: { pids: new Set(), pgids: new Set(), hasProc: true, comms: [], cmdline: [] },
    });
    assert.ok(withAncestor('pkill -f "example-wrapper --settings"')?.refuse, 'fragment of the ancestor command line: refused');
    assert.equal(noAncestor('pkill -f "example-wrapper --settings"'), null, 'the same text without that ancestor: passes');
    assert.ok(withAncestor('pkill -f settings-example.json')?.refuse, 'settings file in the ancestor command line: refused');
    assert.equal(noAncestor('pkill -f settings-example.json'), null, 'the same pattern without that ancestor: passes');
    assert.ok(withAncestor('kill 4242')?.refuse, 'ancestor pid: refused');
    assert.equal(noAncestor('kill 4242'), null, 'the same pid without that ancestor: passes');
    assert.equal(withAncestor('pkill -f "node test/server.mjs"'), null, 'test server run by node passes');
  });
});
