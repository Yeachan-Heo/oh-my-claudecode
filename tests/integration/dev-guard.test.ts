/**
 * /dev guard of the shell checks (scripts/lib/dev-guard.mjs, wired into scripts/lib/shell-checks.mjs and the
 * pre-tool-enforcer hook, active only with OMC_SHELL_CHECKS=1). A command that deletes, moves, overwrites,
 * truncates, re-owns or recreates a path under /dev is refused; redirects to /dev/null and friends and reads from
 * /dev stay allowed. No case is ever executed: every command is a string handed to checkBashCommand or to the hook
 * as tool input, and the state of /dev/null is always a stub or a fake lstat, so no test changes the real /dev.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHELL_URL = pathToFileURL(join(ROOT, 'scripts', 'lib', 'shell-checks.mjs')).href;
const GUARD_URL = pathToFileURL(join(ROOT, 'scripts', 'lib', 'dev-guard.mjs')).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const shell: any = await import(SHELL_URL);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const guard: any = await import(GUARD_URL);

// Verdict of the checks for one Bash command (no bash -n: the /dev guard needs only the tokenizer).
// The probe of /dev/null is replaced everywhere: no test reads or changes the real /dev.
const probeOf = (state: unknown) => () => state;
const verdict = (command: string, platform = 'linux', devNullProbe: () => unknown = probeOf('healthy')) =>
  shell.checkBashCommand(command, { platform, syntax: false, env: {}, devNullProbe });

// Commands the guard must refuse. Text only, never executed.
const BLOCKED: string[] = [
  // rm, unlink, rmdir
  'rm /dev/null', 'rm -f /dev/null', 'rm -rf /dev/null', '/bin/rm -f /dev/null', '\\rm /dev/null', '"rm" /dev/null',
  "rm -f '/dev/null'", 'rm -f "/dev/null"', 'rm /dev/nul*', 'rm /dev/null.test-nonexistent', 'rm //dev/null', 'rm -f -- /dev/null',
  'rm a b /dev/null', 'unlink /dev/null', 'rmdir /dev/foo', 'rm -f /dev/null 2>/dev/null',
  // mv (source or target)
  'mv /dev/null /tmp/x', 'mv /tmp/x /dev/null', 'mv -f x /dev/null', 'mv -t /dev x', 'mv --target-directory=/dev x',
  // cp, install, ln (target only)
  'cp -f a /dev/sda', 'cp -t /dev a', 'cp x /dev/sda', 'cp -a x /dev/null', 'cp -p x /dev/null', 'cp -ap x /dev/null', 'cp --preserve=all x /dev/null', 'cp --remove-destination x /dev/null',
  'cp -l x /dev/null', 'cp -s x /dev/null', 'cp -b x /dev/null', 'cp --link x /dev/null', 'cp x /dev/null.bak', 'cp --archive x /dev/null', 'cp --backup x /dev/null', 'cp --attributes-only x /dev/null', 'install -m 644 x /dev/null', 'install -d /dev/foo',
  'ln -sf x /dev/null', 'ln -s a /dev/b', 'ln -sfT x /dev/null',
  // the target directory as the last letter of a cluster of short options, or as an abbreviated long option
  'ln -sft /dev /tmp/null', 'install -Dt /dev /tmp/null', 'cp -at /dev /tmp/null', 'cp -rt /dev x', 'cp -vt /dev/ x y', 'install -Dt /dev x', 'mv -vt /dev x', 'mv --target=/dev x', 'mv --target-directory /dev x',
  'cp --target=/dev /tmp/null', 'cp --target-d=/dev x', 'ln -sf --target=/dev /tmp/null', 'install --target /dev /tmp/null', 'install -t /dev /tmp/null', 'ln -sf --target-directory=/dev /tmp/null', 'rsync -avt x /dev/foo',
  // sed -i and perl -i in every spelling
  'sed -i s/a/b/ /dev/null', 'sed -i.bak s/a/b/ /dev/null', 'sed --in-place s/a/b/ /dev/null', 'sed -ni p /dev/null',
  "sed -i -e 's/a/b/' /dev/null", "sed --in-place=.bak -e 's/a/b/' /dev/null", "sed -i 's/a/b/' x /dev/null",
  "perl -i -pe 's/a/b/' /dev/null", "perl -pi -e 's/a/b/' /dev/null", "perl -i.bak -pe 'x' /dev/null", "perl -0777pi -e 'x' /dev/null",
  // truncate, chmod, chown, chgrp, mknod, mkfifo, touch, dd
  'truncate -s 0 /dev/null', 'truncate -s0 /dev/null', 'chmod 644 /dev/null', 'chmod 000 /dev/null', 'chown nobody /dev/null',
  'chown -R root:root /dev/foo', 'chgrp x /dev/null', 'mknod /dev/null c 1 3', 'mknod -m 666 /dev/null c 1 3', 'mkfifo /dev/foo',
  'touch /dev/foo', 'touch /dev/null', 'dd if=x of=/dev/sda', 'dd of=/dev/sda bs=1M',
  // find
  'find /dev -delete', 'find /dev -name x -delete', 'find /dev -exec rm {} +', 'find /dev -type f -exec rm -f {} \\;',
  "find /dev/ -name 'x' -exec mv {} /tmp \\;", 'find . -exec rm /dev/null \\;',
  // tee and redirects to a /dev path outside the allowed list
  'tee /dev/sda', 'echo x | tee /dev/sda', 'echo x | tee -a /dev/sda', 'echo x > /dev/sda', 'echo x >> /dev/sda',
  'echo x > /dev/nul', 'echo x >| /dev/sda', 'echo x &> /dev/sda', 'echo x 2> /dev/sda', 'echo x 3> /dev/sda', ': > /dev/disk0',
  // chains: &&, ||, ;, |, &, newline
  'ls && rm -f /dev/null', 'echo a; rm /dev/null', 'false || rm /dev/null', 'cat x | rm /dev/null', 'sleep 1 & rm /dev/null',
  'echo a\nrm /dev/null', 'cmd 2>/dev/null || rm /dev/null', 'echo ok > /dev/null && rm -f /dev/null',
  // subshells, groups, substitutions, control flow
  '(rm /dev/null)', '{ rm /dev/null; }', 'echo $(rm /dev/null)', 'echo `rm /dev/null`', 'echo "$(rm /dev/null)"', 'x=$(rm -f /dev/null)',
  'if true; then rm /dev/null; fi', 'for i in 1; do rm /dev/null; done', 'cat <(rm /dev/null)', 'echo ${x:-$(rm /dev/null)}',
  // bash -c, sh -c, eval, here-documents and here-strings to a shell, ssh
  "bash -c 'rm /dev/null'", 'sh -c "rm -f /dev/null"', "bash -lc 'rm /dev/null'", 'bash -c "echo hi; sed -i x /dev/null"',
  "sh -c 'echo a && rm /dev/null'", "eval 'rm /dev/null'", "bash <<'EOF'\nrm /dev/null\nEOF", "bash <<< 'rm /dev/null'",
  'cat <<EOF\n$(rm /dev/null)\nEOF', "ssh host 'rm /dev/null'", 'ssh -p 22 host rm -f /dev/null',
  // prefixes
  'sudo rm /dev/null', 'sudo -u root rm /dev/null', 'sudo bash -c "rm /dev/null"', 'env rm /dev/null', 'env FOO=1 rm /dev/null',
  'FOO=1 rm /dev/null', 'command rm /dev/null', 'nice -n 10 rm /dev/null', 'nohup rm /dev/null', 'timeout 5 rm /dev/null',
  'timeout -s KILL 5 rm /dev/null', 'sudo nice -n 5 timeout 9 rm /dev/null', 'echo /dev/null | xargs rm', 'xargs rm /dev/null',
  'ls /dev | xargs rm -rf', 'find /dev -name x | xargs sed -i s/a/b/',
  // long options of the wrappers with their value in the next argument, env -S, more than ten wrappers, coproc
  'sudo --user root rm /dev/null', 'sudo --chdir /tmp rm /dev/null', 'env --unset X rm /dev/null', 'env --chdir /tmp rm /dev/null', "env -S 'rm -f /dev/null'", 'env --split-string="rm /dev/null"', "env -S'rm /dev/null'",
  "env -S 'rm -f' /dev/null", "env -i -S 'sh -c \"rm /dev/null\"'", 'stdbuf --output L rm /dev/null', 'ionice --class 3 rm /dev/null', 'echo /dev/null | xargs --max-args 1 rm', `${'sudo '.repeat(11)}rm /dev/null`,
  'sudo --group wheel --user root env --unset X nice --adjustment 3 rm /dev/null', 'coproc rm /dev/null',
  // a backslash and a newline inside or outside double quotes are removed by the shell, in the middle of the path as well
  'rm "/de\\\nv/null"', 'rm /de\\\nv/null', 'rm /de"\\\n"v/null', 'rm "/dev/nu\\\nll"', 'echo x > "/de\\\nv/sda"',
  // devices that may carry a write to something real: the input of a terminal session, terminals and serial ports
  'echo x > /dev/stdin', 'echo x > /dev/pts/3', 'echo x > /dev/ttyUSB0', 'echo x > /dev/tty1', 'echo x | tee /dev/stdin', 'dd if=x of=/dev/pts/0', 'rm /dev/zero', 'mv x /dev/zero',
  // the options of time that take a value, in both spellings, and the ones that do not
  "/usr/bin/time -f '%e' rm /dev/null", 'time -f%e rm /dev/null', "time --format '%e' rm /dev/null", 'time --format=%e rm /dev/null', 'time -o /tmp/t rm /dev/null', 'time -o/tmp/t rm /dev/null',
  'time --output /tmp/t rm /dev/null', 'time --output=/tmp/t rm /dev/null', 'time -p -a -v rm /dev/null', 'time --portability --append --verbose rm /dev/null',
  // a cluster of short options that ends in an option with a value
  'sudo -nu root rm /dev/null', 'sudo -Eu root rm /dev/null', 'sudo -nH -g wheel rm /dev/null', 'doas -nu root rm /dev/null', 'env -iu NAME rm /dev/null', 'timeout -vk 5 3 rm /dev/null',
  'ionice -tc 3 rm /dev/null', 'stdbuf -oL rm /dev/null', 'nice -n5 rm /dev/null', 'sudo -nuroot rm /dev/null', 'echo /dev/null | xargs -rn 1 rm',
  // a here-document handed to a shell inside backticks, whose offsets are those of the text between the backticks
  'echo `bash <<B\nrm /dev/null\nB\n`', 'x=`bash <<B\nrm -f /dev/sda\nB\n`', 'echo `echo \\`rm /dev/null\\``',
  // a path from the pipe lands in the place of the replace string of xargs -I
  'echo /dev/sda | xargs -I{} rm {}', 'echo /dev/sda | xargs -i rm {}', 'echo /dev/sda | xargs --replace=@ rm @', 'echo /dev/sda | xargs -I @ rm @', 'echo /dev/sda | xargs -I{} cp x {}', 'echo -newer /dev/sda | xargs rm', 'find . -newer /dev/null -o -name /dev/sda | xargs rm',
  // more wrappers, keywords and spellings
  'shred /dev/sda', 'doas rm /dev/null', 'ionice -c3 rm /dev/null', 'stdbuf -oL rm /dev/null', 'setsid rm /dev/null', 'time rm /dev/null',
  'exec rm /dev/null', 'builtin rm /dev/null', 'mv -t /dev/null x', '! rm /dev/null', 'while rm /dev/null; do :; done', 'until rm /dev/null; do :; done', 'if rm /dev/null; then :; else rm /dev/null; fi',
  'function f { rm /dev/null; }; f', 'f() { rm /dev/null; }', 'cmd <> /dev/sda', 'cmd >& /dev/sda', "bash <<-EOF\n\trm /dev/null\n\tEOF",
  'find /dev -execdir rm {} \\;', 'find /dev -ok rm {} \\;', 'find /dev -okdir rm {} \\;', 'find . -fprint /dev/sda', "find /dev -exec sh -c 'rm {}' \\;",
  'find /dev -exec sed -i s/a/b/ {} +', "rm $'/dev/null'", 'rm /dev/null/', 'sed -l 5 -i s/a/b/ /dev/null', 'sed -sni p /dev/null', "perl -pie 's/a/b/' /dev/null",
  'rm -rf /dev*', 'rm /dev*', 'rm /dev$X', 'rm /dev/$X', "su -c 'rm /dev/null' root", "runuser -c 'rm /dev/null' x", "flock /tmp/lock -c 'rm /dev/null'",
  'ssh user@host -p 22 "rm /dev/null"', "ssh host <<'EOF'\nrm /dev/null\nEOF", 'rsync x /dev/null', 'rsync -a --delete x/ /dev/foo/', 'link x /dev/null',
  'chattr +i /dev/null', 'setfacl -m u:x:rw /dev/null', 'setfattr -n user.x -v y /dev/null', 'sponge /dev/sda', 'echo x | sponge /dev/sda',
  'rm /dev/shm', 'mv /dev/shm /tmp/x', 'chmod 000 /dev/shm', 'cp x /dev/shmx', 'ln -s a /dev/shm/../null',
  // nesting: five levels are followed, beyond the limit a visible /dev path is refused
  'echo $(echo $(echo $(echo $(echo $(rm /dev/null)))))', `${'echo $('.repeat(9)}rm /dev/null${')'.repeat(9)}`,
  // mkfs, mke2fs
  'mkfs /dev/sda1', 'mkfs -t ext4 /dev/sda1', 'mkfs.ext4 /dev/sda1', 'mkfs.ext4 -F /dev/sda1', 'mke2fs /dev/sda1', 'mke2fs -t ext4 /dev/sdb', 'sudo mkfs.xfs -f /dev/nvme0n1p2',
  '/sbin/mkfs.vfat /dev/sdc1', 'mkfs.btrfs -L x /dev/sda1', 'echo /dev/sda1 | xargs mkfs.ext4', "bash -c 'mkfs.ext4 /dev/sda1'", 'mkfs.ext4 -n /dev/sda1',
  // wipefs: only the erasing forms (-a, --all, -o, --offset, also in a cluster or abbreviated)
  'wipefs -a /dev/sda', 'wipefs --all /dev/sda', 'wipefs -o 0x438 /dev/sda', 'wipefs --offset 0x438 /dev/sda', 'wipefs --offset=0x438 /dev/sda', 'wipefs -af /dev/sda',
  'wipefs -fa /dev/sda', 'wipefs --all --force /dev/sda', 'wipefs -ao 0x1 /dev/sda', 'wipefs -t ext4 -a /dev/sda', 'wipefs --al /dev/sda', 'sudo wipefs -a /dev/sda1',
  // partitioners without a read-only option
  'fdisk /dev/sda', 'sudo fdisk /dev/nvme0n1', 'fdisk -u /dev/sda', 'fdisk -w always /dev/sda', 'sfdisk /dev/sda', 'sfdisk -N 1 /dev/sda', 'sfdisk --activate /dev/sda 1',
  'echo ",,L" | sfdisk /dev/sda', 'gdisk /dev/sda', 'parted /dev/sda', 'parted /dev/sda mklabel gpt', 'parted -s /dev/sda mkpart primary 0% 100%', 'parted -s /dev/sda rm 1',
  'parted /dev/sda unit GB print mklabel gpt', 'parted -a optimal /dev/sda mkpart p 0 1', 'parted /dev/sda resizepart 1 100%', 'parted /dev/sda set 1 boot on', 'parted -s /dev/sda name 1 x',
  // tar -C / --directory while extracting
  'tar -xf a.tar -C /dev', 'tar xf a.tar -C /dev', 'tar -C /dev -xf a.tar', 'tar -xf a.tar --directory=/dev', 'tar -xf a.tar --directory /dev', 'tar -C/dev -xf a.tar',
  'tar --extract -f a.tar -C /dev', 'tar --get -f a.tar -C /dev', 'tar xzf a.tgz -C /dev/disk', 'tar -xvzf a.tgz -C /dev', 'tar xCf /dev a.tar', 'sudo tar -xf a.tar -C /dev',
  'tar -C /tmp -C /dev -xf a.tar', 'tar -C / -C dev -xf a.tar', 'gtar -xf a.tar -C /dev', 'bsdtar -xf a.tar -C /dev', 'tar -xf a.tar -C /dev/null', 'tar -x -f a.tar --directory=/dev/',
  // unzip -d
  'unzip a.zip -d /dev', 'unzip -d /dev a.zip', 'unzip -d/dev a.zip', 'unzip -o a.zip -d /dev/disk', 'unzip -qod /dev a.zip', 'sudo unzip a.zip -d /dev',
  // awk -i inplace (gawk), --include=inplace
  "awk -i inplace '{print}' /dev/null", 'gawk -i inplace 1 /dev/null', 'awk --include=inplace 1 /dev/null', 'awk --include inplace 1 /dev/null', 'awk -iinplace 1 /dev/null',
  'awk -i inplace -f prog.awk /dev/null', "awk -i inplace -v x=1 '{print}' a /dev/null", 'awk -i inplace 1 x=1 /dev/null', 'gawk -i /usr/share/awk/inplace.awk 1 /dev/null',
  // optional arguments of fdisk options are attached (-Lalways is -L with the argument always), bsdtar --cd, abbreviated and repeated directories
  'fdisk -Lalways /dev/sda', 'sfdisk -Lalways /dev/sda', 'fdisk -L /dev/sda', 'fdisk -cl /dev/sda', 'bsdtar -xf a --cd /dev', 'bsdtar -xf a --cd=/dev', 'tar xfC a /dev', 'tar -x --dir=/dev -f a',
  'tar -C /dev -C /tmp -xf a.tar', 'tar -C /tmp -C /dev -C /tmp -xf a.tar',
  // ed, ex
  'ed /dev/null', 'ed -s /dev/null', "printf 'w\n' | ed /dev/null", 'ex /dev/null', 'ex -s /dev/sda', "ed -p '*' /dev/null", "ed -s /dev/null <<< 'w'", 'red /dev/null',
  // the repair recipe is refused when it is not the whole command (probe: broken, see the tests below)
];

// Commands the guard must let through. Text only, never executed.
const ALLOWED: string[] = [
  // redirects to the allowed sinks
  'echo x > /dev/null', 'echo x >> /dev/null', 'cmd 2> /dev/null', 'cmd 2>/dev/null', 'cmd &> /dev/null', 'cmd >| /dev/null',
  'cmd 3>/dev/null', 'cmd > /dev/stdout', 'cmd 2>/dev/stderr', 'cmd > /dev/tty', 'cmd > /dev/fd/3', 'cmd 2>&1', 'cmd >&2',
  'cmd > /dev/null 2>&1', 'echo x > "/dev/null"', 'exec 3<>/dev/tcp/host/80', 'echo x > /dev/tcp/localhost/80', 'echo x > /dev/shm/y',
  // reads from /dev
  'cat /dev/urandom | head -c 8', 'head -c 8 /dev/urandom', 'cat /dev/zero | head -c 4', 'diff a /dev/null', 'git diff --no-index /dev/null file',
  'grep x /dev/null', 'ls /dev', 'ls -la /dev/null', 'stat -c %F /dev/null', 'test -c /dev/null', '[ -e /dev/null ]',
  'read x < /dev/urandom', 'dd if=/dev/urandom of=/tmp/x bs=1 count=4', 'dd if=x of=/dev/null', 'sed s/a/b/ /dev/null', 'ls /dev | wc -l',
  // target directories outside /dev, in the same spellings
  'cp -a x y', 'ln -sf a b', 'mv --target=/tmp/x /tmp/y', 'cp -rt /tmp/d x', 'mv -t /dev/shm x', 'cp -t /dev/shm x', 'rsync -avt x /tmp/y', 'install -Dt /tmp/z x',
  // /dev as a source, not a target
  'cp x /dev/null', 'cp -n a /dev/null', 'cp -r a /dev/null', 'cp -fv a /dev/null', 'cp x /dev/null 2>&1', 'cp /dev/null /dev/null', 'cp x /dev/stdout', 'cp /dev/null f', 'install -m 644 /dev/null f', 'ln -sf /dev/null link', 'touch -r /dev/null f', 'truncate -r /dev/null f',
  // tee to /dev/null
  'tee /dev/null', 'tee -a /dev/null', 'echo x | tee -a /dev/null', 'echo x | tee /dev/null',
  // the target of the command is not under /dev (only a redirect is)
  'rm -f file 2>/dev/null', 'rm -f file > /dev/null 2>&1', 'sed -i s/a/b/ file 2>/dev/null', 'chmod +x f 2>/dev/null', 'touch f 2>/dev/null',
  'rm file 2>/dev/null; echo done', 'mv a b 2>/dev/null', 'cp a b >/dev/null 2>&1',
  // look-alike paths and scripts that only mention /dev
  "sed -i '/dev/d' notes.txt", "sed -i 's#/dev/null#x#' file", "sed -n '/dev/p' file", "perl -i -pe 's/\\/dev\\/x//' f",
  'rm "$HOME/dev/x"', 'rm -rf $ROOT/dev/build', 'rm -rf ./dev/null', 'rm dev/null', 'rm /tmp/dev/null', 'rm /devices/x', 'rm /dev-notes/x',
  'rm /developer/x', 'rm /dev/../tmp/x', 'find . -name dev -delete', 'find /tmp -exec rm {} +', 'find /tmp/dev -delete', 'xargs rm',
  'echo x | xargs rm', "ls -d x 2>/dev/null | xargs rm -rf", 'sort x | tee /dev/stderr | xargs -r rm -rf', 'cat /dev/null | xargs rm', 'ssh host ls /dev', "ssh host 'cat /dev/null'",
  'echo "rm /dev/null"', "echo 'rm -f /dev/null'", 'git commit -m "rm /dev/null"', "grep -r 'rm /dev/null' .", "cat <<'EOF'\nrm /dev/null\nEOF",
  'bash script.sh', "bash -c 'echo hi > /dev/null'", 'sudo ls /dev', 'sudo -u root ls /dev', "bash <<'EOF'\necho hi > /dev/null\nEOF",
  // xargs -I puts the path in the place of the replace string, and the file after a find test such as -newer is only compared with
  'echo /dev/null | xargs -I{} cp {} ./empty', 'ls /dev/disk/by-id/* | xargs -I{} ln -s {} ./links/', "find . -newer /dev/null -name '*.tmp' | xargs rm -f", 'find . -samefile /dev/null | xargs rm', 'find . -newerBt /dev/null | xargs rm',
  'echo /dev/null | xargs -i cp {} ./e', 'echo /dev/null | xargs --replace=@ cp @ ./e', 'echo /dev/null | xargs -I @ cp @ ./e',
  // a here-document of cat inside backticks, and a top-level one whose offset happens to match the one inside the backticks
  'echo `cat <<B\nrm /dev/null\nB\n`', "cats <<'A'\nrm -f /dev/null\nA\necho `bash <<B`", 'echo `ls /tmp`',
  // the same pair stays text in single quotes and in $'...', and an escaped backslash before the newline is not a continuation
  "rm '/de\\\nv/null'", "rm $'/de\\\nv/null'", 'rm "/tmp/x\\\\\nv/null"',
  // writes to pseudo devices that discard or ignore them
  'echo x > /dev/zero', 'echo x > /dev/full', 'echo x > /dev/urandom', 'echo x > /dev/random', 'echo x > /dev/stderr', 'echo x | tee /dev/zero', 'dd if=x of=/dev/zero', 'echo x >> /dev/full',
  "time -f '%e' ls /tmp", 'time --output /tmp/t ls /tmp', 'time -p ls /tmp',
  "sudo -n ls /tmp", 'sudo -nu root ls /tmp', 'sudo -nH -g wheel ls /tmp', 'env -iu NAME ls /tmp', 'timeout -vk 5 3 ls /tmp', 'ionice -tc 3 ls /tmp', 'echo /dev/null | xargs -rn 1 ls',
  // the same wrappers in front of a harmless command
  'sudo --user root ls', "env -S 'ls -l' x", `${'sudo '.repeat(11)}ls`, "env --split-string='echo hi'", 'coproc ls', 'stdbuf --output L cat /dev/urandom', "env -S 'echo x > /dev/null'",
  // tmpfs scratch under /dev/shm, also as the target directory of a copy or move
  'rm -f /dev/shm/x', 'mv /tmp/a /dev/shm/b', 'rm -rf /dev/shm/*', 'cp x /dev/shm', 'cp x /dev/shm/', 'cp -r a /dev/shm/', 'mv x /dev/shm/', 'cp -t /dev/shm x', 'mv -t /dev/shm x', 'mv -t /dev/shm/ x', 'sed -i p -l /dev/null',
  'find /dev/shm -type f -delete', 'find /dev/shm -mindepth 1 -delete', 'ls /dev/shm | xargs rm -rf',
  // options that only read /dev/null as a reference, command -v, comments, remote paths, a source that is not under /dev
  'chmod --reference /dev/null f', 'chown --reference /dev/null f', 'touch --reference /dev/null f', 'truncate --reference /dev/null f',
  // nested texts that only read or write the harmless devices stay allowed at every level up to the limit
  `bash -c "ssh host 'ls 2>/dev/null'"`, `bash -c "bash -c 'echo x > /dev/null'"`, 'echo $(echo $(cat /dev/urandom | head -c 8))', `${'echo $('.repeat(5)}echo x > /dev/null${')'.repeat(5)}`,
  'command -v rm /dev/null', 'echo x # rm /dev/null', 'sed -l 5 -i s/a/b/ file 2>/dev/null', 'ssh user@host -p 22 ls /dev', "su -c 'ls /dev' root",
  'function f { ls /dev; }; f', 'rsync -a x/ host:/dev/foo/', 'rsync x y', 'link /dev/null x', 'echo x | sponge /dev/null', 'sponge /dev/shm/x',
  // mkfs and mke2fs on something that is not a device node, or without a target
  'mkfs -V', 'mkfs --version', 'mkfs.ext4 --help', 'mkfs.ext4 /tmp/img', 'mkfs.ext4 /dev/shm/img', 'mke2fs -t ext4 disk.img', 'cat /dev/null | mkfs.ext4 x', 'echo mkfs /dev/sda', 'man mkfs.ext4', 'ls /sbin/mkfs*',
  // wipefs without an erasing option, and an erasing one on an image
  'wipefs /dev/sda', 'wipefs -p /dev/sda', 'wipefs --json /dev/sda', 'wipefs -n /dev/sda', 'wipefs -f /dev/sda', 'wipefs -O type,uuid /dev/sda', 'wipefs -t ext4 /dev/sda', 'wipefs --types ext4 /dev/sda',
  'wipefs --help', 'wipefs -a /tmp/img', 'wipefs --all disk.img', 'wipefs --offset 0x1 /tmp/img',
  // partitioners: only the listing and dumping forms, and images
  'fdisk -l', 'fdisk -l /dev/sda', 'fdisk --list /dev/sda', 'sudo fdisk -l /dev/sda', 'fdisk -lu /dev/sda', 'fdisk -V', 'fdisk --help', 'fdisk /tmp/disk.img',
  'sfdisk -l /dev/sda', 'sfdisk -d /dev/sda', 'sfdisk --dump /dev/sda', 'sfdisk --list /dev/sda', 'sfdisk -s /dev/sda', 'sfdisk --show-size /dev/sda', 'sfdisk --list-free /dev/sda',
  'sfdisk -F /dev/sda', 'sfdisk -g /dev/sda', 'sfdisk -d /dev/sda > layout', 'sfdisk --json -d /dev/sda', 'sfdisk --list-types', 'gdisk -l /dev/sda',
  'parted -l', 'parted --list', 'parted /dev/sda print', 'parted /dev/sda p', 'parted -s /dev/sda print', 'parted -s /dev/sda print free', 'parted -m /dev/sda unit B print',
  'parted /dev/sda unit GB print', 'parted -s /dev/sda unit s print free', 'parted /dev/sda align-check optimal 1', 'parted /dev/sda help', 'parted -a optimal /dev/sda print',
  'parted disk.img mklabel gpt', 'parted /dev/shm/img mklabel gpt', 'parted -l /dev/sda', 'parted --list /dev/sda mklabel gpt',
  // tar: not extracting, extracting elsewhere (also into /dev/shm), -C that is not under /dev
  'tar -C /dev -cf x.tar .', 'tar -cf x.tar -C /dev null', 'tar -tf a.tar -C /dev', 'tar -xf a.tar -C /tmp', 'tar -xf a.tar', 'tar xf a.tar -C /dev/shm', 'tar -xf a.tar -C /dev/shm/x',
  'tar -cvzf x.tgz -C /dev .', 'tar --list --directory=/dev -f a.tar', 'tar -xf a.tar -C /tmp/dev', 'tar -xf /dev/null -C /tmp', 'tar -rf a.tar -C /dev x', 'tar -C / -C tmp -xf a.tar',
  // unzip: no -d under /dev, or only listing, testing and writing to stdout
  'unzip a.zip', 'unzip a.zip -d /tmp/x', 'unzip -l a.zip', 'unzip -t a.zip', 'unzip -p a.zip file | head', 'unzip -d /dev/shm/x a.zip', 'unzip -d /dev/shm a.zip', 'unzip -d /dev/shm/ a.zip', 'unzip -Z a.zip', 'unzip -v a.zip', 'unzip -l -d /dev a.zip', 'unzip -tq -d /dev a.zip', 'unzip -p -d /dev a.zip f',
  // awk without inplace, and inplace on an ordinary file
  "awk '{print}' /dev/null", 'awk -i inplace 1 file', 'gawk -i inplace 1 file 2>/dev/null', "awk -F: '{print $1}' /dev/null", 'awk -v x=1 1 /dev/null', 'awk -f prog.awk /dev/null',
  'gawk -i /usr/share/awk/ordchr.awk 1 /dev/null', 'awk --version', 'awk -i inplace 1 /dev/shm/x', "awk -i inplace '/dev/ {print}' file", "awk -i inplace -v p=/dev/x '{print p}' file",
  // listing forms that look like edits to a parser that reads clusters wrongly, and values that are /dev paths but no operands
  'fdisk -lL /dev/sda', 'fdisk -x /dev/sda', 'fdisk --list-details /dev/sda', 'sfdisk -T /dev/sda', 'gdisk -? /dev/sda', 'sfdisk -N 1 -d /dev/sda', 'parted -v', 'parted /dev/sda print 1',
  'parted /dev/sda quit', 'parted -a optimal -s /dev/sda print', 'parted --align=optimal /dev/sda print', 'unzip -Z -1 a.zip', 'unzip -P secret -l a.zip', 'bsdtar -xf a --cd /tmp', 'tar -xf a.tar -X /dev/null',
  'awk -i inplace -F /dev/ 1 file', 'fdisk -V /dev/sda', 'sfdisk --list-types /dev/sda', 'parted /dev/sda q', 'awk -i inplace --exec p.awk file', 'gawk -i inplace -l ordchr 1 file', 'awk -i inplace 1 x=/dev/null file',
  // ed and ex on an ordinary file, /dev only as a value
  'ed file', 'ed -s file', 'ed /dev/shm/x', 'echo x | ed', 'ed --version', 'ex file', 'ed -p "/dev/x" file',
];

describe('/dev guard: Bash commands', () => {
  it.each(BLOCKED)('refuses %j', (command) => {
    const v = verdict(command);
    expect(v.decision, `not refused: ${JSON.stringify(command)}`).toBe('deny');
    expect(v.checks).toContain('dev-path');
    expect(v.reason).toMatch(/^\[SHELL CHECK\] Blocked: /);
    expect(v.reason).toMatch(/outside this session/);
  });

  it.each(ALLOWED)('allows %j', (command) => {
    const v = verdict(command);
    expect(v.checks, `false refusal: ${JSON.stringify(command)} -> ${v.reason}`).not.toContain('dev-path');
    expect(v.decision, `false refusal: ${JSON.stringify(command)} -> ${v.reason}`).toBe('allow');
  });

  it('gives the same verdicts on win32 (Git Bash)', () => {
    for (const command of ['rm -f /dev/null', 'sed -i s/a/b/ /dev/null', 'echo x > /dev/sda', "bash -c 'rm /dev/null'"]) {
      expect(verdict(command, 'win32').decision, `win32: not refused: ${command}`).toBe('deny');
      expect(verdict(command, 'win32').checks).toContain('dev-path');
    }
    for (const command of ['echo x > /dev/null', 'rm -f file 2>/dev/null', 'cat /dev/urandom | head -c 8']) {
      expect(verdict(command, 'win32').decision, `win32: false refusal: ${command}`).toBe('allow');
    }
  });

  it('names the command and the path and says that a human repairs /dev', () => {
    const v = verdict('ls && rm -f /dev/null');
    expect(v.reason).toMatch(/`rm`/);
    expect(v.reason).toMatch(/\/dev\/null/);
    expect(v.reason).toMatch(/tell the owner/);
    expect(v.reason).toMatch(/stay allowed/);
    const redirect = verdict('echo x > /dev/sda').reason;
    expect(redirect).toMatch(/redirect `>`/);
    expect(redirect).toMatch(/\/dev\/sda/);
  });

  it('skips bash -n on a refusal and reports no class other than dev-path', () => {
    const v = shell.checkBashCommand("rm /dev/null 'x", { platform: 'linux', syntax: true, env: {} });
    expect(v.decision).toBe('deny');
    expect(v.checks).toEqual(['dev-path']);
    expect(v.syntax.ran).toBe(false);
  });

  it('stays fast on long runs of blanks, assignments, wrappers and here-documents', () => {
    const recipe = 'mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null';
    // 12 000 here-documents (about 230 000 characters) took several seconds when each redirection searched the list of here-documents
    const manyHeredocs = Array.from({ length: 12000 }, (_, i) => `cat <<E${i}\nx\nE${i}`).join('\n');
    const table: Array<[string, 'allow' | 'deny']> = [
      ['echo' + ' '.repeat(200000) + 'x', 'allow'],
      ['echo' + '\t'.repeat(200000) + 'x', 'allow'],
      [`${' '.repeat(200000)}rm /dev/null`, 'deny'],
      [`${recipe}${' '.repeat(200000)}x`, 'deny'],
      [`${'x=1 '.repeat(100000)}rm a`, 'allow'],
      [`${'x=1 '.repeat(100000)}rm /dev/null`, 'deny'],
      [`${'nice '.repeat(10000)}rm /dev/null`, 'deny'],
      [manyHeredocs, 'allow'],
      [`${manyHeredocs}\nbash <<'Z'\nrm /dev/null\nZ`, 'deny'],
      [`${'nice '.repeat(10000)}ls /tmp`, 'allow'],
    ];
    for (const [command, expected] of table) {
      const started = Date.now();
      const v = verdict(command);
      expect(Date.now() - started, `slow on ${command.slice(0, 24)}`).toBeLessThan(3000);
      expect(v.decision, command.slice(0, 24)).toBe(expected);
    }
  });

  it('beyond the nesting limit refuses a path to change and passes the plain redirect of a harmless device', () => {
    const nest = (inner: string, levels: number): string => (levels === 0 ? inner : nest(`bash -c '${inner.replace(/'/g, `'"'"'`)}'`, levels - 1));
    for (const levels of [6, 7]) {
      for (const command of ['rm /dev/null', 'echo x > /dev/sda', 'echo x > /dev/stdin']) {
        expect(verdict(nest(command, levels)).decision, `${levels} levels: ${command}`).toBe('deny');
      }
    }
    for (const command of ['ls /tmp 2>/dev/null', 'echo x > /dev/zero', 'ls /tmp < /dev/null']) {
      expect(verdict(nest(command, 7)).decision, command).toBe('allow');
    }
  });

  it('gives each here-document to its own command', () => {
    expect(verdict("cat <<A\nx\nA\nbash <<B\nrm /dev/null\nB").decision).toBe('deny');
    expect(verdict("bash <<A\necho hi\nA\ncat <<B\nrm /dev/null\nB").decision).toBe('allow');
    expect(verdict("cat <<A\nrm /dev/null\nA\nbash <<'B'\necho hi\nB").decision).toBe('allow');
  });

  it('scans the substitutions in the target of a redirect', () => {
    for (const command of ['echo x > >(rm /dev/null)', 'echo x > $(rm /dev/null)', 'echo x > "$(rm /dev/null)"', 'cat < <(rm /dev/null)']) {
      expect(verdict(command).decision, command).toBe('deny');
    }
    expect(verdict('echo x > >(cat > /dev/null)').decision).toBe('allow');
  });

  it('makes a failure of the guard on the Bash side visible and lets the other checks run', () => {
    const found = guard.checkBashDevPath('echo x', { tokens: null, heredocs: [] }, { platform: 'linux', devNullProbe: probeOf('healthy') });
    expect(found).toEqual({ checks: ['dev-path-error'], denial: '' });
  });

  it('shows one refusal at a time on Windows: a /dev refusal hides the CR parser check', () => {
    const cr = `echo "$(echo $'\\r' | wc -c) $(echo $'\\r' | wc -c)"`;
    expect(verdict(cr, 'win32').checks).toEqual(['cr-parser']);
    const both = verdict(`${cr}\nrm /dev/null`, 'win32');
    expect(both.decision).toBe('deny');
    expect(both.checks).toEqual(['dev-path']);
  });

  it('never throws on a malformed or huge command', () => {
    for (const command of ['', '(((((', '$(', '`rm', 'rm /dev/null "', 'x=$(($(($(1', `${'$('.repeat(200)}rm /dev/null`, 'a'.repeat(50000)]) {
      expect(() => verdict(command), `threw on ${command.slice(0, 20)}`).not.toThrow();
    }
  });
});

// The repair recipe for /dev/null: allowed only as the whole command and only while the probe says /dev/null is not the device 1:3.
const RECIPE = 'mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null';
const recipeVerdict = (command: string, state: unknown, platform = 'linux') => verdict(command, platform, probeOf(state));

const NOT_THE_RECIPE = [
  `${RECIPE}\r`, `${RECIPE}\u00a0`, `\u00a0${RECIPE}`, `${RECIPE}\ufeff`, `${RECIPE}\u2028`, `${RECIPE}\v`, `${RECIPE}\f`, `${RECIPE}; ls`, `ls; ${RECIPE}`, `${RECIPE} && ls`, `ls && ${RECIPE}`, `${RECIPE} | cat`, `${RECIPE} &`, `sudo ${RECIPE}`, `bash -c '${RECIPE}'`, `sh -c "${RECIPE}"`,
  `(${RECIPE})`, `{ ${RECIPE}; }`, `echo $(${RECIPE})`, `${RECIPE} # x`, `${RECIPE} > /dev/sda`, `${RECIPE}\nrm /dev/null`, `ls\n${RECIPE}`, `${RECIPE} || true`, `time ${RECIPE}`,
  'mknod -m 0666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null', 'mknod -m 666 /dev/null.new c 1 3 && mv /dev/null.new /dev/null', 'mknod -m 666 /dev/null.new c 1 3; mv -f /dev/null.new /dev/null',
  'mknod  -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null', 'mknod -m 666 /dev/null.new c 1 5 && mv -f /dev/null.new /dev/null', 'mknod -m 666 /dev/zero.new c 1 5 && mv -f /dev/zero.new /dev/zero',
  'mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/zero', 'mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null.old', 'rm -f /dev/null && mknod -m 666 /dev/null c 1 3',
  'rm -f /dev/null && mknod -m 666 /dev/null c 1 3 && chown root:root /dev/null', 'mknod -m 666 /dev/null c 1 3', 'mv -f /dev/null.new /dev/null', 'mknod -m 666 /dev/null.new c 1 3',
  'mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null && rm /dev/null', 'mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null.new',
];

describe('/dev guard: the repair recipe for /dev/null', () => {
  it('passes while /dev/null is broken or missing, also with white space around it', () => {
    for (const command of [RECIPE, `  ${RECIPE}`, `${RECIPE}\n`, `\t${RECIPE}  \n\n`]) {
      const v = recipeVerdict(command, 'broken');
      expect(v.decision, `refused: ${JSON.stringify(command)}: ${v.reason}`).toBe('allow');
      expect(v.checks, 'the use of the exception is visible in the class list').toEqual(['dev-path-repair']);
    }
  });

  it('is refused for a healthy /dev/null or a failed probe, and the reason says why', () => {
    for (const state of ['healthy', 'error']) {
      const v = recipeVerdict(RECIPE, state);
      expect(v.decision, state).toBe('deny');
      expect(v.checks).toContain('dev-path');
      expect(v.reason).toMatch(/repair recipe/);
      expect(v.reason).toMatch(/character device 1:3/);
      expect(v.reason).toMatch(/outside this session/);
    }
    expect(recipeVerdict(RECIPE, 'healthy').reason).toMatch(/is a healthy character device/);
    expect(recipeVerdict(RECIPE, 'error').reason).toMatch(/could not be checked/);
  });

  it('is refused for a probe that throws or returns nonsense', () => {
    const throwing = () => { throw new Error('boom'); };
    expect(shell.checkBashCommand(RECIPE, { platform: 'linux', syntax: false, env: {}, devNullProbe: throwing }).decision).toBe('deny');
    for (const state of [undefined, null, '', 'ok', true, 'BROKEN']) {
      expect(recipeVerdict(RECIPE, state).decision, String(state)).toBe('deny');
    }
  });

  it('is refused off Linux (the probe cannot judge /dev of Git Bash or of macOS)', () => {
    for (const platform of ['win32', 'darwin']) expect(recipeVerdict(RECIPE, 'broken', platform).decision, platform).toBe('deny');
  });

  it.each(NOT_THE_RECIPE)('is refused even with a broken /dev/null when the command is %j', (command) => {
    const v = recipeVerdict(command, 'broken');
    expect(v.decision, `not refused: ${JSON.stringify(command)}`).toBe('deny');
    expect(v.checks).toContain('dev-path');
  });

  it('is named in the reason of every refusal', () => {
    expect(verdict('rm /dev/null').reason).toMatch(/only while \/dev\/null is not the character device 1:3/);
  });
});

describe('/dev guard: the /dev/null probe', () => {
  // A fake lstat: a character device 1:3 is healthy, any other node or none is broken, anything else is an error.
  const fakeStat = (isChar: boolean, rdev: unknown) => () => ({ isCharacterDevice: () => isChar, rdev });
  const failing = (code?: string) => () => { const e: NodeJS.ErrnoException = new Error(String(code)); e.code = code; throw e; };

  it('reports the device 1:3 as healthy', () => {
    expect(guard.probeDevNull(fakeStat(true, 0x103))).toBe('healthy');
    expect(guard.probeDevNull(fakeStat(true, 259n))).toBe('healthy');
  });

  it('reports a regular file, another device and a missing /dev/null as broken', () => {
    expect(guard.probeDevNull(fakeStat(false, 0))).toBe('broken');
    expect(guard.probeDevNull(fakeStat(false, 0x103))).toBe('broken'); // a block device 1:3 is not /dev/null
    expect(guard.probeDevNull(fakeStat(true, 0x105))).toBe('broken'); // 1:5 is /dev/zero
    expect(guard.probeDevNull(fakeStat(true, 0x203))).toBe('broken'); // 2:3
    expect(guard.probeDevNull(fakeStat(true, 0x10003))).toBe('broken'); // major 256, minor 3
    expect(guard.probeDevNull(fakeStat(true, 0x10103))).toBe('broken'); // major 257 (the major mask is 12 bits wide)
    expect(guard.probeDevNull(fakeStat(true, 0x100103))).toBe('broken'); // 1:259: the high bits of the minor sit at bit 12 and up
    expect(guard.probeDevNull(fakeStat(true, (0x1000n << 32n) | 0x103n))).toBe('broken'); // 4097:3: the high bits of the major sit at bit 32 and up
    expect(guard.probeDevNull(failing('ENOENT'))).toBe('broken');
  });

  it('reports other failures and odd stat results as errors', () => {
    for (const code of ['EACCES', 'EIO', 'ELOOP', 'ENOTDIR', undefined]) expect(guard.probeDevNull(failing(code)), String(code)).toBe('error');
    expect(guard.probeDevNull(() => null)).toBe('error');
    expect(guard.probeDevNull(() => ({}))).toBe('error');
    expect(guard.probeDevNull(fakeStat(true, 'x'))).toBe('error');
  });
});

describe('/dev guard: file tools', () => {
  const fileCall = (tool: string, field: string, path: string) =>
    shell.runShellChecks(tool, { session_id: 's', tool_name: tool, tool_input: { [field]: path } }, { platform: 'linux', env: {}, logDir });
  const TOOLS: Array<[string, string]> = [['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']];
  let logDir: string;
  beforeEach(() => { logDir = mkdtempSync(join(tmpdir(), 'dev-guard-log-')); });
  afterEach(() => { rmSync(logDir, { recursive: true, force: true }); });
  const logRows = () => (existsSync(join(logDir, 'checks.jsonl')) ? readFileSync(join(logDir, 'checks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

  it.each(TOOLS)('%s to a path under /dev is refused', (tool, field) => {
    for (const path of ['/dev/null', '/dev/sda', '//dev/null', '/dev/../dev/null']) {
      const v = shell.runShellChecks(tool, { session_id: 's', tool_name: tool, tool_input: { [field]: path } }, { platform: 'linux', env: {}, logDir });
      expect(v.decision, `${tool} ${path}`).toBe('deny');
      expect(v.checks).toEqual(['dev-path']);
      expect(v.reason).toMatch(/^\[SHELL CHECK\] Blocked: /);
    }
  });

  it.each(TOOLS)('%s to an ordinary path is allowed', (tool, field) => {
    for (const path of ['/tmp/x', '/opt/app/dev/null', '/devices/x', '/dev-notes/x', '/dev/shm/x', 'dev/null', '']) {
      expect(fileCall(tool, field, path).decision, `${tool} ${path}`).toBe('allow');
    }
  });

  it('refuses a NotebookEdit or Edit call when either path field is under /dev', () => {
    const notebook = shell.runShellChecks('NotebookEdit', { tool_name: 'NotebookEdit', tool_input: { file_path: '/tmp/a.ipynb', notebook_path: '/dev/null' } }, { platform: 'linux', env: {}, logDir });
    expect(notebook.decision).toBe('deny');
    expect(shell.runShellChecks('Edit', { tool_input: { notebook_path: '/dev/null', file_path: '/tmp/x' } }, { env: {}, logDir }).decision).toBe('deny');
  });

  it('logs one checks.jsonl row for a refusal and none for an allowed write', () => {
    shell.runShellChecks('Write', { session_id: 's', tool_input: { file_path: '/tmp/x' } }, { platform: 'linux', env: {}, logDir });
    expect(logRows()).toEqual([]);
    shell.runShellChecks('Write', { session_id: 's', tool_input: { file_path: '/dev/null' } }, { platform: 'linux', env: {}, logDir });
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_name: 'Write', decision: 'deny', checks: ['dev-path'], command: '/dev/null' });
  });

  it('makes a failure of the guard visible: allow, class dev-path-error and a checks.jsonl row', () => {
    const data = { get tool_input(): never { throw new Error('boom'); } };
    const v = shell.runShellChecks('Write', data, { platform: 'linux', env: {}, logDir });
    expect(v.decision).toBe('allow');
    expect(v.checks).toEqual(['dev-path-error']);
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checks: ['dev-path-error'], decision: 'allow' });
  });

  it('does not treat Read and Grep as file writers: /dev/null stays readable', () => {
    expect(shell.runShellChecks('Read', { tool_input: { file_path: '/dev/null' } }, { env: {}, logDir }).decision).toBe('allow');
  });
});

describe('/dev guard: module loading', () => {
  // dev-guard.mjs and shell-checks.mjs import each other; the shared binding is only used when a check runs, so either order loads.
  it.each([
    ['dev-guard first', `const g = await import(${JSON.stringify(GUARD_URL)}); const s = await import(${JSON.stringify(SHELL_URL)});`],
    ['shell-checks first', `const s = await import(${JSON.stringify(SHELL_URL)}); const g = await import(${JSON.stringify(GUARD_URL)});`],
  ])('works when %s', (_name, imports) => {
    const script = `${imports} const t = s.tokenizeBash("bash -c 'rm /dev/null'"); console.log(JSON.stringify(g.findDevPathChange(t)));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ what: 'rm', path: '/dev/null' });
  });
});

describe('/dev guard in the pre-tool-enforcer hook', () => {
  let cwd: string;
  let logDir: string;
  let counter = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'dev-guard-hook-'));
    logDir = join(cwd, 'logs');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function hook(toolName: string, toolInput: Record<string, unknown>, extraEnv: Record<string, string> = { OMC_SHELL_CHECKS: '1' }) {
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: join(cwd, 'config'),
      CLAUDE_CONFIG_DIR: join(cwd, 'claude'),
      NODE_NO_WARNINGS: '1',
      OMC_DISABLE_MULTIREPO: '1',
      OMC_STATE_DIR: join(cwd, '.omc'),
      OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS: '0',
      OMC_SHELL_CHECKS_LOG_DIR: logDir,
      ...extraEnv,
    };
    const sid = `dev-guard-${process.pid}-${++counter}`;
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pre-tool-enforcer.mjs')], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: `toolu_${sid}`, cwd, session_id: sid, permission_mode: 'bypassPermissions' }),
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    let json: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null = null;
    try { json = JSON.parse(String(result.stdout).trim().split('\n').filter(Boolean).pop() ?? ''); } catch { /* plain pass */ }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, denied: json?.hookSpecificOutput?.permissionDecision === 'deny', reason: String(json?.hookSpecificOutput?.permissionDecisionReason ?? '') };
  }
  const logRows = () => (existsSync(join(logDir, 'checks.jsonl')) ? readFileSync(join(logDir, 'checks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

  it('denies Bash rm /dev/null with the reason and a checks.jsonl row of class dev-path', () => {
    const h = hook('Bash', { command: 'ls && rm -f /dev/null' });
    expect(h.code, h.stderr).toBe(0);
    expect(h.denied, h.stdout).toBe(true);
    expect(h.reason).toMatch(/Blocked: `rm` would change \/dev\/null/);
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'deny', checks: ['dev-path'], tool_name: 'Bash' });
  });

  it('denies sed -i, perl -i, bash -c, sudo and a pipeline into xargs', () => {
    for (const command of ['sed -i s/a/b/ /dev/null', 'perl -pi -e x /dev/null', "bash -c 'rm /dev/null'", 'sudo rm /dev/null', 'echo /dev/null | xargs rm', 'echo $(rm /dev/null)']) {
      expect(hook('Bash', { command }).denied, `hook let through: ${command}`).toBe(true);
    }
  });

  it('allows redirects to /dev/null, reads from /dev and rm on another path', () => {
    for (const command of ['echo x > /dev/null', 'rm -f file 2>/dev/null', 'sed -i s/a/b/ file 2>/dev/null', 'head -c 8 /dev/urandom', 'tee -a /dev/null']) {
      const h = hook('Bash', { command });
      expect(h.denied, `hook refused: ${command}: ${h.stdout}`).toBe(false);
    }
  });

  it('denies Write, Edit, MultiEdit and NotebookEdit to /dev/null, and not a write to an ordinary path', () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: '/dev/null', content: 'x' }],
      ['Edit', { file_path: '/dev/null', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: '/dev/null', edits: [] }],
      ['NotebookEdit', { notebook_path: '/dev/null', new_source: 'x' }],
      ['NotebookEdit', { file_path: join(cwd, 'a.ipynb'), notebook_path: '/dev/null', new_source: 'x' }],
      ['Write', { file_path: '/dev', content: 'x' }],
    ];
    for (const [tool, input] of calls) {
      const h = hook(tool, input);
      expect(h.denied, `hook let through ${tool}: ${h.stdout}${h.stderr}`).toBe(true);
      expect(h.reason).toMatch(/Blocked: /);
    }
    expect(logRows()).toHaveLength(calls.length);
    expect(logRows().every((row) => row.decision === 'deny' && row.checks[0] === 'dev-path')).toBe(true);
    const ok = hook('Write', { file_path: join(cwd, 'x.txt'), content: 'x' });
    expect(ok.denied, ok.stdout).toBe(false);
    expect(logRows(), 'an allowed Write writes no checks.jsonl row').toHaveLength(calls.length);
  });

  it('denies nothing without OMC_SHELL_CHECKS=1 (the guard has no switch of its own)', () => {
    for (const value of [undefined, '', '0', 'true']) {
      const extra: Record<string, string> = value === undefined ? {} : { OMC_SHELL_CHECKS: value };
      expect(hook('Bash', { command: 'rm -f /dev/null' }, extra).denied, `OMC_SHELL_CHECKS=${value}`).toBe(false);
      expect(hook('Write', { file_path: '/dev/null', content: 'x' }, extra).denied, `OMC_SHELL_CHECKS=${value}`).toBe(false);
    }
    expect(existsSync(logDir)).toBe(false);
  });

  it('refuses the repair recipe while /dev/null cannot be shown broken, and says why', () => {
    // The real /dev/null is only read (lstat). On a sane machine it is the device 1:3, off Linux the probe does not judge: refused either way.
    const h = hook('Bash', { command: 'mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null' });
    expect(h.denied, h.stdout).toBe(true);
    expect(h.reason).toMatch(/repair recipe/);
  });

  it('finishes its work, as without the guard, when a path field is not text', () => {
    // A path field that cannot be turned into text (an object whose toString is not a function) must not end the hook early,
    // with or without OMC_SHELL_CHECKS=1: the output is that of the same call with an ordinary path.
    const odd = { toString: 1 };
    const ordinary = join(cwd, 'x.txt');
    const calls: Array<[string, string, Record<string, unknown>]> = [
      ['Write', 'file_path', { content: 'x' }],
      ['Edit', 'file_path', { old_string: 'a', new_string: 'b' }],
      ['MultiEdit', 'file_path', { edits: [] }],
      ['NotebookEdit', 'notebook_path', { new_source: 'x' }],
    ];
    for (const [tool, field, rest] of calls) {
      for (const extra of [{}, { OMC_SHELL_CHECKS: '1' }]) {
        const expected = hook(tool, { [field]: ordinary, ...rest }, extra);
        expect(expected.code, expected.stderr).toBe(0);
        for (const value of [odd, [odd], 5, null]) {
          const h = hook(tool, { [field]: value, ...rest }, extra);
          expect(h.code, h.stderr).toBe(0);
          expect(h.denied).toBe(false);
          expect(h.stdout, `${tool} ${field}=${JSON.stringify(value)} ${JSON.stringify(extra)}`).toBe(expected.stdout);
        }
      }
    }
    expect(existsSync(logDir)).toBe(false);
  });

  it('does not cover PowerShell', () => {
    expect(hook('PowerShell', { command: 'rm /dev/null' }).denied).toBe(false);
  });
});
