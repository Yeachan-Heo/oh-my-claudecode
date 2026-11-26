/**
 * /dev guard of the shell checks (scripts/lib/dev-guard.mjs, wired into scripts/lib/shell-checks.mjs and the
 * pre-tool-enforcer hook, active only with OMC_SHELL_CHECKS=1). A command that deletes, moves, overwrites,
 * truncates, re-owns or recreates a path under /dev is refused; redirects to /dev/null and friends and reads from
 * /dev stay allowed. No case is ever executed: every command is a string handed to checkBashCommand or to the hook
 * as tool input, and the state of /dev/null is always a stub or a fake lstat, so no test changes the real /dev.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
  // the options of the external time utility that take a value, in both spellings, and the ones that do not (a bare time is the keyword of the shell, see below)
  "/usr/bin/time -f '%e' rm /dev/null", 'command time -f%e rm /dev/null', "command time --format '%e' rm /dev/null", 'command time --format=%e rm /dev/null', 'command time -o /tmp/t rm /dev/null', 'command time -o/tmp/t rm /dev/null',
  'command time --output /tmp/t rm /dev/null', 'command time --output=/tmp/t rm /dev/null', 'command time -p -a -v rm /dev/null', 'command time --portability --append --verbose rm /dev/null',
  // time is the keyword of the shell only as a plain word at the start of a pipeline, and then it runs the command after -p; anywhere else it is the external utility
  'time -p rm /dev/null', 'time -p -- rm /dev/null', 'time -- rm /dev/null', 'time time -p rm /dev/null', 'command time -f %e rm /dev/null', 'env time -f %e rm /dev/null', 'sudo time -f %e rm /dev/null', 'nice time -f %e rm /dev/null',
  'ZM=1 time -f %e rm /dev/null', "'time' -f %e rm /dev/null", '\\time -f %e rm /dev/null', '"time" -f %e rm /dev/null', 'true | time -f %e rm /dev/null', 'find . -exec time -f %e rm /dev/null ;',
  // a cluster of short options that ends in an option with a value
  'sudo -nu root rm /dev/null', 'sudo -Eu root rm /dev/null', 'sudo -nH -g wheel rm /dev/null', 'doas -nu root rm /dev/null', 'env -iu NAME rm /dev/null', 'timeout -vk 5 3 rm /dev/null',
  'ionice -tc 3 rm /dev/null', 'stdbuf -oL rm /dev/null', 'nice -n5 rm /dev/null', 'sudo -nuroot rm /dev/null', 'echo /dev/null | xargs -rn 1 rm',
  // env -S: an unquoted backslash and underscore separates arguments
  "env -S 'rm\\_/dev/null'", "env -S 'rm\\_/dev/null' x", "env --split-string='rm\\_/dev/null'", "env -S 'echo hi\\_&&\\_rm /dev/null'", "env -S 'rm\\_\"/dev/null\"'",
  // -- ends the options of eval
  "eval -- 'rm /dev/null'", "eval -- rm /dev/null", "eval -- 'echo x; rm /dev/null'",
  // a member of an archive that lands under /dev when the extraction directory is /
  'tar -C / -xf /tmp/a.tar dev/null', 'gtar -C / -xf /tmp/a.tar dev/null', 'bsdtar -C / -xf /tmp/a.tar dev/null', 'tar xf /tmp/a.tar -C / dev/null', 'tar -xf /tmp/a.tar -C / ./dev/null',
  'tar --directory=/ -xf /tmp/a.tar dev/null', 'tar -C / --extract --file=/tmp/a.tar dev/null', 'tar -C / -xf /tmp/a.tar dev', 'tar -C /tmp -xf /tmp/a.tar ../dev/null', 'tar -C / -C tmp -xf /tmp/a.tar ../dev/null',
  'unzip -o /tmp/a.zip dev/null -d /', 'unzip /tmp/a.zip dev/null -d /', 'unzip -d / /tmp/a.zip dev/null', 'unzip -d/ /tmp/a.zip dev/null', 'unzip -o /tmp/a.zip x ../dev/null -d /tmp',
  // the options of xargs whose value is the next word still take it, so the command comes after it
  'echo /dev/null | xargs -L 1 rm', 'echo /dev/null | xargs -rL 1 rm', 'echo /dev/null | xargs -E x rm', 'echo /dev/null | xargs -rE x rm',
  // a letter with an optional attached value ends a cluster of xargs options: the rest of the word is its value and the next word is the command
  'echo x | xargs -iL rm /dev/null', 'echo x | xargs -rilL rm /dev/null', 'echo x | xargs -ilx rm /dev/null', 'echo x | xargs -eL rm /dev/null', 'echo x | xargs -lL rm /dev/null',
  'echo x | xargs -rtiL rm /dev/null', 'echo /dev/null | xargs -iL rm L', 'echo x | xargs -rL 1 rm /dev/null', 'echo x | xargs -rn 1 rm /dev/null', 'echo x | xargs -rnL rm /dev/null',
  // the value of --file, --files-from and --exclude-from is not a member; the members that follow still count
  'tar -C / --extract --file a.tar dev/null', 'tar -C / -x --files-from /dev/fd/3 dev/null', 'tar -C / -x --exclude-from /dev/fd/3 dev/null', 'bsdtar -C / --extract --file a.tar dev/null',
  // an exclusion removes a member only when its pattern has no wildcard and matches the name the way tar does
  'tar -C / -xf a.tar dev/null --exclude=other', 'tar -C / -xf a.tar dev/null --exclude=dev/n*', 'tar -C / -xf a.tar dev/null --exclude=*', 'tar -C / -xf a.tar dev/null dev/zero --exclude=dev/null',
  'tar -C / -xf a.tar dev/null --exclude=ev/null', 'tar -C / -xf a.tar dev/null --exclude=dev/null/', 'tar --anchored -C / -xf a.tar dev/null --exclude=null', 'bsdtar -C / -xf a.tar dev/null --exclude=dev/null',
  'tar -C / -xf a.tar dev/null --exclude-from=x', 'tar -C / -xf a.tar dev/null --exclude-from x',
  "tar -C / -xf a.tar 'dev/n*' --exclude='dev/n*'", "tar -C / -xf a.tar 'dev/n?ll' --exclude='dev/n?ll'", "tar -C / -xf a.tar 'dev/[n]ull' --exclude='dev/[n]ull'",
  // a plain time at the start of a command is the keyword also in a group or a condition after a pipe, and the external utility everywhere else
  'echo x | time -f %e rm /dev/null', 'echo x | sudo { time -f %e rm /dev/null; }', 'echo x | env { time -f %e rm /dev/null; }', 'echo x | { time -p rm /dev/null; }',
  'echo x | { command time -f %e rm /dev/null; }', 'echo x | time -p { time -f %e rm /dev/null; }', 'echo x | { sudo time -f %e rm /dev/null; }', 'echo x | { A=1 time -f %e rm /dev/null; }',
  "echo x | '{' time -f %e rm /dev/null", 'echo x | "if" time -f %e rm /dev/null',
  // the options of xargs whose value is optional and attached: the next word is the command
  'echo /dev/null | xargs -rl rm', 'echo /dev/null | xargs -l rm', 'echo /dev/null | xargs -rl2 rm', 'echo /dev/null | xargs --max-lines rm', 'echo /dev/null | xargs --max-lines=2 rm',
  'echo /dev/null | xargs --eof rm', 'echo /dev/null | xargs -e rm', 'echo /dev/null | xargs -re rm', 'echo /dev/null | xargs -rt -l rm',
  // tar writes a member under its name with the first components stripped
  'tar --strip-components=1 -C / -xf /tmp/a.tar foo/dev/null', 'tar --strip-components 1 -C / -xf /tmp/a.tar foo/dev/null', 'tar --strip=1 -C / -xf /tmp/a.tar foo/dev/null', 'gtar --strip-components=2 -C / -xf /tmp/a.tar a/b/dev/null',
  'bsdtar --strip-components=1 -C / -xf /tmp/a.tar foo/dev/null', 'tar -C / --strip-components=1 -xf /tmp/a.tar ./dev/null', 'tar --strip-components=x -C / -xf /tmp/a.tar dev/null',
  // members before the -x list are still extracted, and so is everything when -x comes before the archive
  'unzip a.zip dev/other -x dev/null -d /', 'unzip a.zip dev/null -x top.txt -d /', 'unzip -d / a.zip dev/other -x dev/null', 'unzip a.zip dev/null -x dev/null top.txt -d /', 'unzip -x a.zip dev/null -d /',
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
  // the words of env -S go back to the option parser of env: its own options, a double dash and assignments come first, the command last
  "env -S '-i rm /dev/null'", "env -S '-- rm /dev/null'", "env -S '-u HOME rm /dev/null'", "env -S 'FOO=1 rm /dev/null'", "env -S '-S rm\\_/dev/null'", "env -S '-i' rm /dev/null", "env -S '-i -u HOME -- rm /dev/null' x",
  "env --split-string='-i rm /dev/null'", "env -S '- rm /dev/null'", "env -S '-i env -i rm /dev/null'", "env -S '-i sudo -n rm /dev/null'", 'env - rm /dev/null', 'env -i - rm /dev/null',
  // with the strip option a name with a leading slash loses the slash first, and then the components (bsdtar counts the slash as the first one)
  'tar --strip-components=1 -C / -xf a.tar /foo/dev/null', 'gtar --strip-components 1 -C / -xf a.tar /foo/dev/null', 'tar --strip-components=1 -C / -xf a.tar //foo/dev/null', 'tar --strip-components=2 -C / -xf a.tar /a/b/dev/null',
  'bsdtar --strip-components=2 -C / -xf a.tar /foo/dev/null', 'bsdtar --strip-components=1 -C / -xf a.tar /dev/null', 'tar -C / -xf a.tar /dev/null', 'tar --strip-components=1 -C /dev -xf a.tar /foo/x',
  // the list of -x of the zip extractor ends at the next option, and the words after that option are members again (the real tool reads none of them, but the whole archive then goes into the directory)
  'unzip a.zip -x etc/x -d / dev/null', 'unzip a.zip -x etc/x -d / -x tmp/out -q dev/null', 'unzip a.zip -x etc/x -o dev/null -d /', 'unzip a.zip top.txt -x etc/x -d / dev/null', 'unzip a.zip dev/null -x etc/x -d /',
  'unzip -d / a.zip -x etc/x -q dev/null', 'unzip a.zip -x etc/x -d / -- dev/null',
  // after a redirection time is no keyword: the shell runs the external utility, whose options take a value
  '>/tmp/log time -f %e rm /dev/null', '>/tmp/log time -p rm /dev/null', '2>/tmp/log time -f %e rm /dev/null', '</tmp/in time -p rm /dev/null', 'FOO=1 >/tmp/log time -p rm /dev/null', '{ >/tmp/log time -f %e rm /dev/null; }',
  'true && >/tmp/log time -f %e rm /dev/null', '>/tmp/log time -- rm /dev/null', 'time -p >/tmp/log rm /dev/null', '! >/tmp/log time -p rm /dev/null', 'if >/tmp/log time -f %e rm /dev/null; then true; fi',
  // only the extraction to the standard output is free; the command pipe of the archive extractor and the other cases keep their members
  'tar --to-command=cat -C / -xf a.tar dev/null', 'tar -C / -xf a.tar dev/null', 'tar -C / -xf a.tar dev/null --totals', 'tar -C / --to-command cat -xf a.tar dev/null',
  // -C applies from its place on: the members after it go into its directory, the ones before the first -C stay where the command runs
  'tar -xf a.tar tmp/out -C / dev/null', 'tar -C / -xf a.tar dev/null tmp/out', 'tar -C /tmp -xf a.tar x -C / dev/null', 'tar -C /tmp -xf a.tar x -C .. dev/null', 'tar xCf / a.tar dev/null', 'tar -xf a.tar -C / dev/null',
  'tar -xf a.tar x -C /dev y', 'tar -xC / -f a.tar dev/null', 'tar -C /tmp -xf a.tar dev/null -C / x dev/zero', 'tar -x -C / -f a.tar x dev/null', 'bsdtar -C / -xf a.tar tmp/out dev/null',
  // the value of an option that the tool takes with a next word is not a member, and the members that follow still count; the sets differ per tool
  'tar -C / -xf a.tar --label x dev/null', 'tar -C / -xf a.tar --transform s,a,b, dev/null', 'tar -C / -xf a.tar --label=x dev/null', 'tar -C / -xf a.tar --label dev/null dev/null',
  'tar -C / -xf a.tar --uid dev/null tmp/out', 'bsdtar -C / -xf a.tar --label dev/null tmp/out', 'bsdtar -C / -xf a.tar --uid 0 dev/null', 'gtar -C / -xf a.tar --owner root dev/null',
  'tar -C / -xf a.tar --backup dev/null', 'tar -C / -xf a.tar --one-top-level dev/null',
  // env -S inside a cluster of short options reads its text as options of env again, like the separate form
  "env -iS 'rm /dev/null'", "env -iS'rm /dev/null'", "env -vS 'rm /dev/null'", "env -iS '-i rm /dev/null'", "env -iS '-u HOME rm /dev/null'", "env -iuS rm /dev/null",
  // busybox runs the applet named by its first argument
  'busybox rm /dev/null', 'busybox env -i rm /dev/null', 'env busybox rm /dev/null', "busybox sh -c 'rm /dev/null'", 'busybox sed -i s/a/b/ /dev/null', 'sudo busybox rm /dev/null',
  // ... and the external utility again when the redirection belongs to its own command or it follows a pipe
  'true >/tmp/log && >/tmp/log time -f %e rm /dev/null', 'true >/tmp/log | time -f %e rm /dev/null',
  // -P and --absolute-names keep the leading slash: without a named member every member of the archive lands under its own name
  'tar -xPf a.tar', 'tar -xPf a.tar -C /tmp', 'tar -C /tmp -xPf a.tar', 'tar xPf a.tar', 'tar -xf a.tar -P', 'tar --absolute-names -xf a.tar', 'tar -x --absolute-n -f a.tar', 'tar -x --ab -f a.tar',
  'gtar -xf a.tar --absolute-names', 'bsdtar -xPf a.tar', 'bsdtar -xf a.tar --absolute-paths', 'bsdtar -x --ab -f a.tar', 'tar --extract --absolute-names --file a.tar', 'tar -xPf a.tar --exclude=foo',
  'tar -xPf a.tar --strip-components=0', 'sudo tar -xPf a.tar', "bash -c 'tar -xPf a.tar'", 'nice tar --absolute-names -xf a.tar',
  // ... and a named member with a leading slash is judged by its own name, whatever -C and the wrappers say
  'tar -xPf a.tar /dev/zz-x', 'tar -xPf a.tar -C /tmp /dev/zz-x', 'tar -C /tmp -xPf a.tar /dev/null', 'tar --absolute-names -xf a.tar rel/x /dev/zz-x', 'bsdtar -xPf a.tar -C /tmp /dev/zz-x',
  // GNU tar runs the --to-command text for each member
  "tar -xf a.tar --to-command='rm /dev/null'", "tar -xf a.tar --to-command 'rm /dev/null'", "tar -xf a.tar --to-c='rm /dev/null'", "tar -xf a.tar --to-c 'rm /dev/null'", "gtar -C /tmp -xf a.tar --to-command='truncate -s 0 /dev/null'",
  "tar -xf a.tar rel/x --to-command='echo x; rm /dev/null'", "tar -xf a.tar --to-command='sh -c \"rm /dev/null\"'",
  // the other ways in which tar runs a command text: the compress program (-I, --use-compress-program, also abbreviated), the exec action of a checkpoint
  // and the scripts at the end of a volume (-F, --info-script, --new-volume-script, also abbreviated), in every mode and in every form of the value
  "tar -xf a.tar -I 'rm /dev/null'", "tar -xf a.tar -I'rm /dev/null'", "tar -cf a.tar -I 'rm /dev/null' f", "tar -tf a.tar -I 'rm /dev/null'", "gtar -tf a.tar -I 'truncate -s 0 /dev/null'", "tar xIf 'rm /dev/null' a.tar",
  "tar -tf a.tar --use-compress-program='rm /dev/null'", "tar -tf a.tar --use-compress-program 'rm /dev/null'", "tar -tf a.tar --use='rm /dev/null'", "tar -tf a.tar --use 'rm /dev/null'", "tar -tf a.tar --use-c 'rm /dev/null'",
  "bsdtar -tf a.tar --use-compress-program 'rm /dev/null'", "bsdtar -xf a.tar --use-compress-program='rm /dev/null'", "bsdtar -tf a.tar --us 'rm /dev/null'", "bsdtar -cf a.tar --use 'rm /dev/null' f",
  "tar -tf a.tar --checkpoint=1 --checkpoint-action='exec=rm /dev/null'", "tar -tf a.tar --checkpoint=1 --checkpoint-action 'exec=rm /dev/null'", "tar -tf a.tar --checkpoint-a 'exec=rm /dev/null'", "tar -tf a.tar --checkpoint- 'exec=rm /dev/null'",
  "tar -xf a.tar --checkpoint=1 --checkpoint-action=echo --checkpoint-action='exec=echo x; rm /dev/null'",
  "tar -cMf a.tar -F 'rm /dev/null' x", "tar -cMF 'rm /dev/null' -f a.tar x", "tar -cM -F'rm /dev/null' -f a.tar x", "tar -cM --info-script='rm /dev/null' -f a.tar x", "tar -cM --info-script 'rm /dev/null' -f a.tar x",
  "tar -cM --new-volume-script='rm /dev/null' -f a.tar x", "tar -cM --new-volume-script 'rm /dev/null' -f a.tar x", "tar -cM --new-v='rm /dev/null' -f a.tar x", "tar -cM --info 'rm /dev/null' -f a.tar x", "tar -tM -F 'rm /dev/null' -f a.tar",
  "sudo tar -xf a.tar -I 'rm /dev/null'", "nice tar -xf a.tar --checkpoint=1 --checkpoint-action='exec=rm /dev/null'", "bash -c \"tar -cM -F 'rm /dev/null' -f a.tar x\"", "tar -C /tmp -xf a.tar -I 'sh -c \"rm /dev/null\"'",
  // env -S text that starts with time: env runs time as a program (its -f takes a value), not as the keyword of the shell
  "env -S 'time -f %e rm /dev/null'", "env -S 'time -p rm /dev/null'", "env -S'time -f %e rm /dev/null'", "env --split-string='time -f %e rm /dev/null'", "env -S 'time -o out.tmp rm /dev/null'",
  "env -S '\"time\" -f %e rm /dev/null'", "env -i -S 'time -f %e rm /dev/null'", "sudo env -S 'time -f %e rm /dev/null'", "env -S 'time -f %e rm /dev/null' extra", "env -S 'nice time -f %e rm /dev/null'",
  // unzip: after the archive every word is a pattern for a member, even one that looks like an option (only -x with its list and -d with its directory stay options)
  'unzip -o a.zip -P dev/null -d /', 'unzip a.zip -o dev/null -d /', 'unzip a.zip -q dev/null -d /', 'unzip a.zip -j dev/null -d /', 'unzip a.zip -n dev/null -d /', 'unzip a.zip -l dev/null -d /', 'unzip a.zip -v dev/null -d /',
  'unzip a.zip -t dev/null -d /', 'unzip a.zip -p dev/null -d /', 'unzip a.zip -c dev/null -d /', 'unzip a.zip -z dev/null -d /', 'unzip a.zip -Z dev/null -d /', 'unzip a.zip -- dev/null -d /', 'unzip a.zip -P secret dev/null -d /',
  'unzip a.zip -i dev/null -d /', 'unzip a.zip -O cp437 dev/null -d /', 'unzip a.zip -d / -o dev/null', 'unzip a.zip dev/null -d / -o', 'unzip a.zip -d/ dev/null', 'unzip a.zip -x etc/x -o -d / dev/null',
  'unzip a.zip -x etc/x -P dev/null -d /', 'sudo unzip -o a.zip -P dev/null -d /',
  // --to-command runs for the members of an extraction to files, in every spelling of the extraction
  "tar --get -f a.tar --to-command='rm /dev/null'", "tar xf a.tar --to-command='rm /dev/null'", "tar --extract -f a.tar --to-command 'rm /dev/null'", "tar -xf a.tar rel/x --to-command='rm /dev/null'", "tar -xvf a.tar --to-c='rm /dev/null'",
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
  // env -S: a separator after the backslash and underscore, or the pair kept inside quotes (never a command)
  "env -S 'echo\\_hi'", "env -S \"echo 'rm\\_/dev/null'\"", "env -S 'echo \"rm\\_/dev/null\"'", "env -S 'echo \\x\\_y'",
  "eval -- 'echo hi'", 'eval --', "eval -- ''",
  // members that stay outside /dev, a member without an extraction directory, and -j, which drops the directories of the members
  'tar -C /tmp -xf /tmp/a.tar dev/null', 'tar -xf /tmp/a.tar dev/null', 'tar -C / -xf /tmp/a.tar etc/x', 'tar -tf /tmp/a.tar dev/null', 'tar -C / -tf /tmp/a.tar dev/null',
  'unzip -o /tmp/a.zip dev/null -d /tmp', 'unzip /tmp/a.zip dev/null', 'unzip -j /tmp/a.zip dev/null -d /', 'unzip -l /tmp/a.zip dev/null -d /', 'unzip -o /tmp/a.zip etc/x -d /',
  // the value of the file options of tar is the archive or a list, not a member
  'tar -C / --extract --file /dev/fd/3 tmp/out', 'tar -C / --extract --file=/dev/fd/3 tmp/out', 'gtar -C / --extract --file /dev/fd/3 tmp/out', 'bsdtar -C / --extract --file /dev/fd/3 tmp/out',
  'tar -C / -x --files-from /dev/fd/3 tmp/out', 'tar -C / -x --exclude-from /dev/fd/3 tmp/out',
  // a member that a literal exclusion names is not extracted
  'tar -C / -xf a.tar dev/null --exclude=dev/null', 'tar -C / -xf a.tar dev/null --exclude dev/null', 'tar -C / -xf a.tar --exclude=dev/null dev/null', 'tar -C / -xf a.tar dev/null --exclude=null',
  'gtar -C / -xf a.tar dev/null --exclude=dev/null', 'tar -C / -xf a.tar dev/null dev/zero --exclude=dev/null --exclude=dev/zero', 'tar --strip-components=1 -C / -xf a.tar foo/dev/null --exclude=dev/null',
  'tar --anchored -C / -xf a.tar dev/null --exclude=dev/null',
  // the keyword time opens its own context in a group or a condition after a pipe
  'echo x | { time -f %e rm /dev/null; }', 'echo x | { true; time -f %e rm /dev/null; }', 'echo x | if time -f %e rm /dev/null; then true; fi', 'echo x | while time -f %e rm /dev/null; do break; done',
  'echo x | until time -f %e rm /dev/null; do break; done', 'echo x | { ! time -f %e rm /dev/null; }', 'echo x | ( time -f %e rm /dev/null )', 'echo x | for i in 1; do time -f %e rm /dev/null; done',
  'echo x | case x in x) time -f %e rm /dev/null;; esac',
  // the options of xargs whose value is the next word still take it
  'echo /dev/null | xargs -L 1 ls', 'echo /dev/null | xargs -rL 1 ls', 'echo /dev/null | xargs -E rm ls', 'echo /dev/null | xargs -rE rm ls', 'echo /dev/null | xargs --max-args 1 ls',
  // a member that is empty after the strip is skipped, and one that lands outside /dev stays outside
  'tar --strip-components=1 -C / -xf /tmp/a.tar dev/null', 'tar --strip-components 2 -C / -xf /tmp/a.tar dev/null', 'tar --strip-components=1 -C / -xf /tmp/a.tar foo/etc/x', 'tar --strip-components=1 -C /tmp -xf /tmp/a.tar foo/dev/null',
  // a bare time is the keyword of the shell: only -p and -- are its options, so the rest is a command that does not exist
  'time -f %e rm /dev/null', 'if true; then time -f %e rm /dev/null; fi', '! time -f %e rm /dev/null', 'true && time -f %e rm /dev/null', '{ time -o /tmp/t rm /dev/null; }', 'time -p -f %e rm /dev/null',
  'time --format %e rm /dev/null', 'time -pf rm /dev/null', 'time -f%e rm /dev/null', 'time -p time -f %e rm /dev/null',
  // the words after -x are patterns to leave out, before or after -d
  'unzip a.zip -x dev/null -d /', 'unzip a.zip top.txt -x dev/null -d /', 'unzip a.zip -d / -x dev/null', 'unzip -d / a.zip -x dev/null', 'unzip a.zip -x dev/null top.txt -d /', 'unzip -o a.zip -x dev/null dev/other -d /',
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
  // the same words with a command that does not touch /dev
  "env -S '-i true'", "env -S '-i echo /dev/null'", "env -S '-- ls /dev/null'", "env -S '-u HOME true' /dev/null", 'env - ls /dev/null',
  // the same names with a strip that leaves a path outside /dev
  'tar --strip-components=2 -C / -xf a.tar /foo/dev/null', 'tar --strip-components=1 -C / -xf a.tar /dev/null', 'gtar --strip-components=3 -C / -xf a.tar /foo/dev/null', 'bsdtar --strip-components=3 -C / -xf a.tar /foo/dev/null',
  // a list of exclusions that swallows everything up to the option, and members after it that stay outside /dev
  'unzip a.zip -x dev/null -d /', 'unzip a.zip -x dev/null -d /tmp/out', 'unzip a.zip -x etc/x -d / tmp/out', 'unzip a.zip top.txt -x etc/x -d / tmp/out', 'unzip a.zip -x dev/null etc/x tmp/out -d /', 'unzip -x etc/x a.zip -d /',
  // a redirection after the keyword time does not change it
  'time -f %e >/tmp/log rm /dev/null', 'time -f %e 2>/tmp/log rm /dev/null', '{ time -f %e rm /dev/null; } >/tmp/log',
  // extraction to the standard output creates no file
  'tar -O -C / -xf /tmp/a.tar dev/null', 'tar --to-stdout -C / -xf a.tar dev/null', 'tar --to-s -C / -xf a.tar dev/null', 'tar -xOf a.tar dev/null', 'tar -C / -xOf a.tar dev/null', 'tar xOf a.tar dev/null', 'tar -xf a.tar -O',
  'tar -O -C /dev -xf a.tar x', 'tar -C /dev --to-stdout -xf a.tar x', 'bsdtar -O -C / -xf a.tar dev/null', 'bsdtar --to-stdout -C / -xf a.tar dev/null', 'gtar -O -C / -xf a.tar dev/null', 'tar -C / -xf a.tar dev/null -O',
  // members before the -C that leads to /dev stay in the current directory; the directory after the last member is not applied to anything
  'tar -xf a.tar dev/null -C / tmp/out', 'tar -xf a.tar dev/null -C /', 'tar -C / -xf a.tar tmp/out -C /tmp dev/null', 'tar -xf a.tar dev/null dev/zero -C / tmp/out tmp/x', 'tar -C /tmp -xf a.tar x -C / tmp/out',
  'tar -x -f a.tar dev/null -C /', 'tar -xf a.tar dev/null --directory=/ tmp/out',
  // an option of the archive extractor with a value in the next word: the value is no member
  'tar -C / -xf a.tar --label dev/null tmp/out', 'tar -C / -xf a.tar --label=dev/null tmp/out', 'tar -C / -xf a.tar --transform dev/null tmp/out', 'tar -C / -xf a.tar --blocking-factor dev/null tmp/out',
  'tar -C / -xf a.tar --use-compress-program dev/null tmp/out', 'tar -C / -xf a.tar --newer dev/null tmp/out', 'tar -C / -xf a.tar --owner dev/null tmp/out', 'tar -C / -xf a.tar --mode dev/null tmp/out',
  'tar -C / -xf a.tar --format dev/null tmp/out', 'gtar -C / -xf a.tar --to-command dev/null tmp/out', 'bsdtar -C / -xf a.tar --uid dev/null tmp/out', 'bsdtar -C / -xf a.tar --options dev/null tmp/out',
  'bsdtar -C / -xf a.tar --newer-than dev/null tmp/out', 'tar -C / -xf a.tar --suffix dev/null tmp/out',
  // env -S inside a cluster: a letter that takes a value before the S keeps the S as its value; the text still goes through the checks
  "env -iS 'true'", "env -iS 'echo /dev/null'", "env -iu S true", "env -iuS true", "env -uS echo x", "env -iC /tmp true",
  // busybox with an applet that only reads, and without an applet
  'busybox ls /dev', 'busybox cat /dev/null', 'busybox echo /dev/null', 'busybox --list', 'busybox true', 'env busybox ls /dev',
  // time after a redirection of an earlier command is the keyword again after the list operator
  'true >/tmp/log && time -f %e rm /dev/null', 'true >/tmp/log; time -f %e rm /dev/null',
  // the old style first word with O and a directory letter: the members go to the standard output wherever the directory is
  'tar xOCf / a.tar dev/null', 'tar xCOf / a.tar dev/null',
  // a letter that takes a value before the S: the text after the cluster is the program name, not text to split
  "env -uS 'rm /dev/null'",
  // -P and --absolute-names change nothing when the command only creates or lists, or when the strip option makes every name relative again, or a member has a slash and is no device path
  'tar -cPf a.tar /etc/x', 'tar -tPf a.tar', 'tar --absolute-names -cf a.tar /dev/null', 'tar -xPf a.tar --strip-components=1', 'tar -xPf a.tar --strip-components=2', 'tar -xPf a.tar -C /tmp rel/x',
  'tar -xPf a.tar /tmp/x', 'tar -xPf a.tar -C /dev/shm rel/x', 'bsdtar -tf a.tar --absolute-paths', 'tar -xPOf a.tar', 'tar -xPf a.tar -O',
  // a --to-command text that harms nothing, and the other options of the same family
  "tar -xf a.tar --to-command='echo x'", "tar -xf a.tar --to-command 'cat /dev/null'", "tar -xf a.tar --to-command='wc -c >/dev/null'", 'tar -xf a.tar --to-stdout', 'tar -tf a.tar --to-command=cat', 'tar -xf a.tar --totals',
  // the value of --to-command in the next word is a command, not a member (also abbreviated)
  'tar -C / -xf a.tar --to-c dev/null', 'tar -C / -xf a.tar --to-command dev/null', 'tar -C / -xf a.tar --to-co=dev/null',
  // the same options with a program that harms nothing, the checkpoint actions that run no command, and the -I of bsdtar, which names a file
  'tar -xf a.tar -I gzip', "tar -xf a.tar -I 'gzip -9'", 'tar -xf a.tar --use-compress-program=gzip', "tar -xf a.tar --use-compress-program='gzip -9'", 'tar -cf a.tar --use-compress-program zstd f', 'tar -xf a.tar --use gzip',
  'tar -xf a.tar --checkpoint=1 --checkpoint-action=echo=x', 'tar -xf a.tar --checkpoint=1 --checkpoint-action=dot', 'tar -xf a.tar --checkpoint=1 --checkpoint-action=sleep=1', 'tar -xf a.tar --checkpoint=1 --checkpoint-action ttyout=x',
  'tar -xf a.tar --checkpoint=1 --checkpoint-action=totals', 'tar -xf a.tar --checkpoint=1 --checkpoint-action=bell', 'tar -xf a.tar --checkpoint=1 --checkpoint-action=exec=cat', "tar -xf a.tar --checkpoint=1 --checkpoint-action='exec=echo /dev/null'",
  'tar -cM --info-script=true -f a.tar x', 'tar -cM -F true -f a.tar x', 'tar -cM --new-volume-script ./next.sh -f a.tar x', 'tar -cMF ./next.sh -f a.tar x',
  'bsdtar -tf a.tar -I /dev/null', 'bsdtar -tf a.tar -I inc.txt', 'bsdtar -tf a.tar --use-compress-program gzip',
  // the value of these options in the next word is a command text, no member (also abbreviated)
  'tar -C / -xf a.tar --use-compress-program dev/null', 'tar -C / -xf a.tar --use dev/null', 'tar -C / -xf a.tar --info-script dev/null', 'tar -C / -xf a.tar --checkpoint-a dev/null', 'bsdtar -C / -xf a.tar --us dev/null',
  // an echo action prints its text and runs nothing, and bsdtar knows none of the GNU options (it reads their value as a member)
  "tar -xf a.tar --checkpoint=1 --checkpoint-action='echo=rm /dev/null'", "bsdtar -tf a.tar --to-command='rm /dev/null'", "bsdtar -xf a.tar --info-script 'rm /dev/null'",
  // ... and a time program that wraps something harmless
  "env -S 'time -f %e true'", "env -S 'time -f %e echo /dev/null'", "env -S 'time -p true'",
  // ... and the options before the archive still count: -j drops the directories, -l lists, and a password before the archive is no member
  'unzip -j a.zip dev/null -d /', 'unzip -l a.zip dev/null -d /', 'unzip -P dev/null a.zip -d /', 'unzip a.zip -o rel/x -d /tmp/out', 'unzip -o a.zip -P secret -d /tmp/out', 'unzip a.zip -d /tmp/out -o dev/null',
  // ... and never otherwise: not when listing, creating, comparing, appending, deleting, or when the members go to the standard output
  "tar -tf a.tar --to-command='rm /dev/null'", "tar -cf a.tar --to-command='rm /dev/null' f", "tar -xOf a.tar --to-command='rm /dev/null'", "tar -xf a.tar --to-stdout --to-command='rm /dev/null'", "tar -xf a.tar --to-command='rm /dev/null' -O",
  "tar xOf a.tar --to-command='rm /dev/null'", "tar -df a.tar --to-command='rm /dev/null'", "tar -rf a.tar --to-command='rm /dev/null' f", "tar --delete -f a.tar --to-command='rm /dev/null' f", "tar -tf a.tar --to-command 'rm /dev/null'",
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
    // 10 000 extraction directories and 10 000 members, all different, took more than a minute when every member was tried against every directory
    const manyDirs = Array.from({ length: 10000 }, (_, i) => `/tmp/d${i}`);
    const manyMembers = Array.from({ length: 10000 }, (_, i) => `m/x${i}`);
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
      [`tar ${manyDirs.map((d) => `-C ${d}`).join(' ')} -xf a.tar ${manyMembers.join(' ')}`, 'allow'],
      [`unzip ${manyDirs.map((d) => `-d ${d}`).join(' ')} a.zip ${manyMembers.join(' ')}`, 'allow'],
      [`tar ${manyDirs.map((d) => `-C ${d}`).join(' ')} -C / -xf a.tar ${manyMembers.join(' ')} dev/null`, 'deny'],
      [`tar -C / -xf a.tar ${manyMembers.join(' ')} ${manyMembers.map((m) => `--exclude=${m}`).join(' ')}`, 'allow'],
      [`tar -C / -xf a.tar ${manyMembers.join(' ')} dev/null ${manyMembers.map((m) => `--exclude=${m}`).join(' ')}`, 'deny'],
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

  function hook(toolName: string, toolInput: Record<string, unknown>, extraEnv: Record<string, string> = { OMC_SHELL_CHECKS: '1' }, inputCwd?: string) {
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
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: `toolu_${sid}`, cwd: inputCwd ?? cwd, session_id: sid, permission_mode: 'bypassPermissions' }),
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

  it('reads the directory of the session from the cwd field of the hook input', () => {
    const inDev = hook('Bash', { command: 'rm null' }, { OMC_SHELL_CHECKS: '1' }, '/dev');
    expect(inDev.code, inDev.stderr).toBe(0);
    expect(inDev.denied, inDev.stdout).toBe(true);
    expect(inDev.reason).toMatch(/Blocked: `rm` would change \/dev\/null/);
    expect(hook('Bash', { command: 'rm null' }, { OMC_SHELL_CHECKS: '1' }, '/tmp').denied).toBe(false);
    expect(hook('Bash', { command: 'cd /dev && rm null' }).denied).toBe(true);
    expect(hook('Write', { file_path: 'null' }, { OMC_SHELL_CHECKS: '1' }, '/dev').denied).toBe(true);
    expect(hook('Bash', { command: 'rm null' }, {}, '/dev').denied).toBe(false); // without OMC_SHELL_CHECKS=1 nothing is read
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

// The working directory of the session, cd in the command and symbolic links to /dev. Text only: nothing is ever run, the links below are only looked at.
describe('/dev guard: working directory and symbolic links', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dev-guard-links-'));
    mkdirSync(join(dir, 'plain'));
    symlinkSync('/dev', join(dir, 'devlink'));
    symlinkSync('/dev/null', join(dir, 'nulllink'));
    symlinkSync(join(dir, 'plain'), join(dir, 'plainlink'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const DEVICES = ['null', 'zero', 'full', 'random', 'urandom', 'tty'];
  // the operations that replace or change a file, with <P> for the path
  const OPERATIONS = [
    'rm <P>', 'mv <P> /tmp/x', 'mv /tmp/x <P>', 'cp --remove-destination /tmp/x <P>', 'ln -sf /tmp/x <P>', 'install /tmp/x <P>',
    'sed -i s/a/b/ <P>', "perl -i -pe 's/a/b/' <P>", 'truncate -s 0 <P>',
  ];
  const each = (spell: (device: string) => string, wrap: (command: string) => string = (c) => c) =>
    OPERATIONS.flatMap((op) => DEVICES.map((d) => wrap(op.split('<P>').join(spell(d)))));
  const check = (command: string, cwd?: string) => shell.checkBashCommand(command, { platform: 'linux', syntax: false, env: {}, devNullProbe: probeOf('healthy'), cwd });

  it('refuses the operations on a bare name or a ./ name when the session is in /dev', () => {
    for (const command of [...each((d) => d), ...each((d) => `./${d}`)]) expect(check(command, '/dev').decision, command).toBe('deny');
  });

  it('refuses them after cd /dev in the same command, with or without a directory of the session', () => {
    for (const command of [...each((d) => d, (c) => `cd /dev && ${c}`), ...each((d) => `./${d}`, (c) => `cd /dev && ${c}`)]) {
      expect(check(command).decision, command).toBe('deny');
      expect(check(command, '/tmp').decision, command).toBe('deny');
    }
  });

  it('refuses them through a symbolic link to /dev, also after .. behind the link', () => {
    const link = join(dir, 'devlink');
    for (const command of [...each((d) => `${link}/${d}`), ...each((d) => `${link}/..${link}/${d}`)]) expect(check(command, '/tmp').decision, command).toBe('deny');
    expect(check('rm null', link).decision).toBe('deny');
    expect(check(`cd ${link} && rm null`, '/tmp').decision).toBe('deny');
    expect(check('cd devlink && rm null', dir).decision).toBe('deny');
    expect(check('rm devlink/null', dir).decision).toBe('deny');
    expect(check('rm ./devlink/null', dir).decision).toBe('deny');
  });

  it.each([
    ['cd /dev; rm null', '/tmp'], ['cd /dev/ && rm null', '/tmp'], ['cd //dev && rm null', '/tmp'], ['cd -P /dev && rm null', '/tmp'], ['cd -- /dev && rm null', '/tmp'],
    ['cd /tmp && cd /dev && rm null', '/tmp'], ['cd / && cd dev && rm null', '/tmp'], ['cd /dev/.. && rm dev/null', '/tmp'], ['cd /dev && cd .. && rm dev/null', '/tmp'],
    ['cd .. && rm dev/null', '/dev'], ['rm ../dev/null', '/dev'], ['cd /dev/pts && rm 0', '/tmp'], ['cd /dev && find . -delete', '/tmp'],
    ["bash -c 'cd /dev && rm null'", '/tmp'], ['(cd /dev && rm null)', '/tmp'], ['{ cd /dev; rm null; }', '/tmp'], ['cd /dev && bash -c "rm null"', '/tmp'], ['cd /dev || true; rm null', '/tmp'],
    ['cd /dev && echo x | tee sda', '/tmp'], ['cd /dev && echo x > sda', '/tmp'], ['cd /dev && dd of=sda if=x', '/tmp'], ['echo x > sda', '/dev'], ['chmod 600 null', '/dev'], ['touch null', '/dev'],
    ['cd /dev && chmod 600 null', undefined],
    // a subshell leaves its cd behind, a cd after || may not have run, and a path that a feeder hands to xargs is read from the directory in force
    ['cd /dev && (cd /tmp; true); rm null', '/tmp'], ['cd /dev || cd /tmp; rm null', '/tmp'], ['(cd /tmp); rm null', '/dev'], ['cd /dev && echo null | xargs rm', '/tmp'], ['echo null | xargs rm', '/dev'],
    // an extraction without -C or -d goes to the directory of the session, a relative -C or -d is read from it
    ['tar -xf a.tar', '/dev'], ['unzip a.zip', '/dev'], ['tar -xf a.tar -C sub', '/dev'], ['unzip a.zip -d sub', '/dev'], ['tar -C . -xf a.tar', '/dev'], ['tar -xf a.tar dev/null', '/'], ['unzip a.zip dev/null', '/'],
    ['cd /dev && tar -xf a.tar', '/tmp'], ['cd /dev && unzip a.zip', '/tmp'], ['cd /dev && tar -xf a.tar', undefined], ['cd /dev && unzip a.zip dev/null', undefined],
  ])('refuses %j (session in %j)', (command, cwd) => {
    expect(check(command, cwd).decision).toBe('deny');
  });

  it('refuses a replacing operation on a relative path after a cd that it cannot follow, and nothing else', () => {
    for (const command of ['cd "$X"; rm foo', 'cd "$X" && rm ./foo', 'cd; rm foo', 'cd -; rm foo', 'cd ~; rm foo', 'cd ~/x; rm foo', 'pushd "$X"; rm foo', 'pushd; rm foo', 'popd; rm foo', 'cd $(pwd)/x; rm foo',
      'cd "$X"; mv a b', 'cd "$X"; sed -i s/a/b/ f', 'cd /dev && cd "$X" && rm foo', 'cd "$X"; chmod 600 f', 'cd "$X"; truncate -s 0 f', 'cd "$X"; ln -sf a b']) {
      expect(check(command, '/tmp').decision, command).toBe('deny');
      expect(check(command).decision, command).toBe('deny');
    }
    expect(check('cd "$X"; rm foo', '/tmp').reason).toMatch(/a relative path after a cd that the guard cannot follow/);
  });

  it.each([
    'cd "$X"; ls', 'cd "$X"; rm /tmp/foo', 'cd "$X"; echo x > foo', 'cd "$X"; echo x > null', 'cd "$X"; cp a b', 'cd "$X"; cat foo', 'cd "$X"; rm "$f"', 'cd "$X"; rm "a$f"', 'cd "$X"; find . -name x',
    'cd "$X"; tar -xf a.tar -C out', 'cd "$X"; unzip a.zip -d out', 'cd "$X"; git rm foo', 'cd "$X"; ls | xargs echo', 'cd "$X"; echo foo | tee out',
    'cd /tmp && rm null', 'cd /tmp; rm null', 'cd /tmp/x && rm ./null', 'cd /dev/shm && rm x', 'cd /dev/shm/ && rm null', 'cd /dev && cd /tmp && rm null', 'cd /dev && cd .. && rm null',
    'cd /dev && ls null', 'cd /dev && cat null', 'cd /dev && echo x > null', 'cd /dev && echo x >> null', 'cd /dev && cp x null', 'cd /dev && ls | xargs echo', 'cd /dev && echo hello | xargs echo', 'cd /dev && stat null',
    'cd /dev && rm /tmp/x', 'cd /dev && rm ../tmp/x', 'cd /dev && rm shm/x', 'cd /dev && rm ./shm/x',
    '(cd /dev; ls); rm null', '(cd /dev && ls) && rm null', 'cd /dev && echo null | xargs echo', 'cd /tmp && echo null | xargs rm', 'echo null | xargs rm', 'cd /dev && sudo echo null | xargs rm', 'cd /tmp || cd /dev; rm /tmp/x',
    'cd /dev && tar -xf a.tar -C /tmp', 'cd /dev && tar -xf a.tar -C /tmp b', 'cd /dev/shm && tar -xf a.tar', 'cd /dev && tar -tf a.tar', 'cd /dev && tar -xOf a.tar', 'cd /dev && unzip -l a.zip', 'cd /dev && unzip a.zip -d /tmp', 'cd /tmp && tar -xf a.tar', 'tar -xf a.tar', 'unzip a.zip',
  ])('allows %j', (command) => {
    expect(check(command, '/tmp').decision).toBe('allow');
    expect(check(command).decision).toBe('allow');
  });

  it('allows the same operations when the session is outside /dev, in /dev/shm, or the hook gave no directory', () => {
    for (const command of each((d) => d)) {
      expect(check(command, '/tmp').decision, command).toBe('allow');
      expect(check(command, '/dev/shm').decision, command).toBe('allow');
      expect(check(command).decision, command).toBe('allow');
    }
    for (const command of ['rm null', 'rm ./null', 'ls', 'cat null', 'echo x > null', 'mv null /tmp/x']) expect(check(command, '/dev').decision === 'deny', command).toBe(command.startsWith('rm') || command.startsWith('mv'));
    for (const cwd of ['', 'relative/dir', 'C:\\Users\\x', '/dev/\u0000']) expect(check('rm null', cwd).decision, JSON.stringify(cwd)).toBe('allow');
  });

  it('allows the redirects of a harmless device through a link, in a relative name and after cd, and refuses the others', () => {
    const link = join(dir, 'devlink');
    for (const command of [`echo x > ${link}/null`, `echo x >> ${link}/zero`, `echo x | tee ${link}/null`, `dd if=x of=${link}/null`, `cat x > ${join(dir, 'nulllink')}`]) expect(check(command, '/tmp').decision, command).toBe('allow');
    for (const command of [`echo x > ${link}/sda`, `echo x | tee ${link}/sda`, `dd if=x of=${link}/sda`, `echo x > ${link}/../dev/sda`]) expect(check(command, '/tmp').decision, command).toBe('deny');
  });

  it('allows a link to an ordinary directory, and a link to a device that the command removes or replaces as a link', () => {
    const nulllink = join(dir, 'nulllink');
    const plainlink = join(dir, 'plainlink');
    for (const command of [`rm ${plainlink}/f`, `rm ${plainlink}`, `mv /tmp/x ${plainlink}`, `mv /tmp/x ${plainlink}/f`, `cp /tmp/x ${plainlink}/f`, `ln -sf /tmp/x ${plainlink}/f`, `sed -i s/a/b/ ${plainlink}/f`, `find ${plainlink} -name x`,
      `rm ${nulllink}`, `rm -f ${nulllink}`, `unlink ${nulllink}`, `mv ${nulllink} /tmp/x`, `mv /tmp/x ${nulllink}`, `cp --remove-destination /tmp/x ${nulllink}`, `ln -sf /tmp/x ${nulllink}`, `install /tmp/x ${nulllink}`,
      `sed -i s/a/b/ ${nulllink}`, `perl -i -pe 's/a/b/' ${nulllink}`, `cp /tmp/x ${nulllink}`, `rm ${join(dir, 'devlink')}`, `unlink ${join(dir, 'devlink')}`, `find ${join(dir, 'devlink')} -delete`, `find ${join(dir, 'devlink')} -name x`]) {
      expect(check(command, '/tmp').decision, command).toBe('allow');
    }
  });

  it('refuses what the tools do to the device behind a link: they follow it, or enter it when it names a directory', () => {
    const nulllink = join(dir, 'nulllink');
    const devlink = join(dir, 'devlink');
    for (const command of [`truncate -s 0 ${nulllink}`, `chmod 600 ${nulllink}`, `chown nobody ${nulllink}`, `touch ${nulllink}`, `sed -i --follow-symlinks s/a/b/ ${nulllink}`, `rm ${devlink}/`, `rm -r ${devlink}/`,
      `mv /tmp/x ${devlink}`, `cp --remove-destination /tmp/x ${devlink}`, `ln -sf /tmp/x ${devlink}`, `install /tmp/x ${devlink}`, `cp -t ${devlink} /tmp/x`, `mv -t ${devlink} /tmp/x`, `find ${devlink}/ -delete`, `find -L ${devlink} -delete`, `find -H ${devlink} -delete`]) {
      expect(check(command, '/tmp').decision, command).toBe('deny');
    }
  });

  // sed takes any unambiguous prefix of --follow-symlinks (measured with sed 4.9: --fo is the shortest, --f is ambiguous with --file) and then edits the target
  it('reads an abbreviation of --follow-symlinks like the option', () => {
    const nulllink = join(dir, 'nulllink');
    for (const option of ['--follow-symlinks', '--follow-symlink', '--follow', '--foll', '--fol', '--fo']) {
      expect(check(`sed ${option} -i s/a/b/ ${nulllink}`, '/tmp').decision, option).toBe('deny');
      expect(check(`sed -i ${option} s/a/b/ ${nulllink}`, '/tmp').decision, option).toBe('deny');
    }
    for (const option of ['--f', '--follow-symlinkz', '--fx']) expect(check(`sed ${option} -i s/a/b/ ${nulllink}`, '/tmp').decision, option).toBe('allow');
  });

  // the same for the other long options of sed that the guard reads (measured with sed 4.9: --i, --e, --li and --fi are the shortest; --expression=TEXT with
  // the text attached leaves the first operand a file)
  it.each([
    ['sed --i s/a/b/ /dev/null', 'deny'], ['sed --in s/a/b/ /dev/null', 'deny'], ['sed --e=s/a/b/ --in /dev/null', 'deny'], ['sed --exp=s/a/b/ --in-place /dev/null', 'deny'],
    ['sed --fi=/tmp/s.sed -i /dev/null', 'deny'], ['sed --fil /tmp/s.sed -i /dev/null', 'deny'], ['sed --lin=5 -i s/a/b/ /dev/null', 'deny'], ['sed --li 5 -i s/a/b/ /dev/null', 'deny'],
    ['sed --i s/a/b/ /tmp/x', 'allow'], ['sed --e=p --in /tmp/x', 'allow'], ['sed --fi /tmp/s.sed --i /tmp/x', 'allow'], ['sed --li 5 -i s/a/b/ /tmp/x', 'allow'],
  ])('reads the abbreviated long options of sed in place: %s is %s', (command, expected) => {
    expect(check(command, '/tmp').decision).toBe(expected);
  });

  // touch, chown and chgrp change the link itself with -h or --no-dereference (measured with coreutils 9.4: --no-d is the shortest prefix, --d is --dereference
  // for chown and chgrp, the last of them counts)
  it('reads -h and --no-dereference of touch, chown and chgrp as changes of the link itself', () => {
    const nulllink = join(dir, 'nulllink');
    const devlink = join(dir, 'devlink');
    for (const command of [`touch -h ${nulllink}`, `touch --no-dereference ${nulllink}`, `touch --no-d ${nulllink}`, `touch -ch ${nulllink}`, `touch -hd 2001-01-01 ${nulllink}`, `touch -h -d 2001-01-01 ${nulllink}`,
      `chown -h nobody ${nulllink}`, `chown --no-dereference nobody ${nulllink}`, `chown --no-d nobody ${nulllink}`, `chown -hR nobody ${nulllink}`, `chown --dereference -h nobody ${nulllink}`,
      `chgrp -h nogroup ${nulllink}`, `chgrp --no-dereference nogroup ${nulllink}`, `chgrp --no-d nogroup ${nulllink}`, `chgrp --deref -h nogroup ${nulllink}`]) {
      expect(check(command, '/tmp').decision, command).toBe('allow');
    }
    for (const command of [`touch ${nulllink}`, `touch -dh ${nulllink}`, `touch -d 2001-01-01 ${nulllink}`, `touch -r x ${nulllink}`, `chown nobody ${nulllink}`, `chown -h --dereference nobody ${nulllink}`, `chown -h --d nobody ${nulllink}`,
      `chown --no-dereference --dereference nobody ${nulllink}`, `chgrp -h --deref nogroup ${nulllink}`, `chgrp nogroup ${nulllink}`, `touch -h ${devlink}/null`, `chown -h nobody ${devlink}/null`, `touch -h /dev/null`, `chown -h nobody /dev/null`]) {
      expect(check(command, '/tmp').decision, command).toBe('deny');
    }
  });

  // -T and ln -n replace a link to a directory instead of entering it, and chmod -h leaves a link alone (measured with coreutils 9.4: ln -sf x LINK puts x into the
  // directory, ln -sfn, ln -sfT, mv -T, install -T and cp -T --remove-destination replace the link; --no-t and --no-d are the shortest prefixes)
  it('reads -T, ln -n and chmod -h like the tools', () => {
    const nulllink = join(dir, 'nulllink');
    const devlink = join(dir, 'devlink');
    for (const command of [`ln -sfn /tmp/x ${devlink}`, `ln -sfT /tmp/x ${devlink}`, `ln -sf --no-dereference /tmp/x ${devlink}`, `ln -sf --no-d /tmp/x ${devlink}`, `ln -sf --no-target-directory /tmp/x ${devlink}`,
      `ln -sf --no-t /tmp/x ${devlink}`, `mv -T /tmp/x ${devlink}`, `mv --no-target-directory /tmp/x ${devlink}`, `install -T /tmp/x ${devlink}`, `cp -T --remove-destination /tmp/x ${devlink}`,
      `chmod -h 600 ${nulllink}`, `chmod --no-dereference 600 ${nulllink}`]) {
      expect(check(command, '/tmp').decision, command).toBe('allow');
    }
    for (const command of [`ln -sf /tmp/x ${devlink}`, `cp -n --remove-destination /tmp/x ${devlink}`, `mv -n /tmp/x ${devlink}`, `install -c /tmp/x ${devlink}`, `ln -sf -t ${devlink} /tmp/x`,
      `chmod 600 ${nulllink}`, `chmod -h 600 /dev/null`, `chmod -h 600 ${devlink}/null`, `ln -sfn /tmp/x ${devlink}/null`, `mv -T /tmp/x ${devlink}/null`]) {
      expect(check(command, '/tmp').decision, command).toBe('deny');
    }
  });

  it('reads cd like the shell: -P and -- are options, a group does not end the cd and a subshell or a pipeline does, a cd after || is unknown, an empty target stays', () => {
    expect(check('(cd /dev); rm null', '/tmp').decision).toBe('allow');
    expect(check('{ cd /dev; }; rm null', '/tmp').decision).toBe('deny');
    expect(check('cd /dev && cd /tmp || true; rm null', '/tmp').decision).toBe('deny'); // the second cd may have failed
    expect(check('cd /dev | cat; rm null', '/tmp').decision).toBe('allow'); // the cd of a pipeline runs in a subshell
    expect(check('cd ""; rm null', '/dev').decision).toBe('deny');
    expect(check('cd "" && rm null', '/tmp').decision).toBe('allow');
    expect(check('cd -L /tmp && rm null', '/dev').decision).toBe('allow');
    expect(check('cd -- /tmp && rm null', '/dev').decision).toBe('allow');
  });

  it('still reads a path with a variable as unknown, and a relative path without a directory of the session as before', () => {
    expect(check('rm "$X/null"', '/dev').decision).toBe('allow');
    expect(check('rm "null$X"', '/dev').decision).toBe('allow');
    expect(check('cd /dev && rm "$X"').decision).toBe('allow');
    expect(check('rm ~/null', '/dev').decision).toBe('allow');
  });

  it('resolves at most a few hundred paths per command and keeps reading the rest as text', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `f${i}`).join(' ');
    const started = Date.now();
    expect(check(`rm ${many}`, '/tmp').decision).toBe('allow');
    expect(check(`rm ${many} /dev/null`, '/tmp').decision).toBe('deny');
    expect(check(`rm ${many} ${join(dir, 'devlink')}/null`, '/tmp').decision).toBe('allow'); // beyond the budget only the text counts
    expect(check(`rm ${Array.from({ length: 100 }, (_, i) => `f${i}`).join(' ')} ${join(dir, 'devlink')}/null`, '/tmp').decision).toBe('deny');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('refuses a file tool on a relative path when the session is in /dev, or on a path through a link', () => {
    const call = (tool: string, field: string, path: string, cwd?: string) => shell.runShellChecks(tool, { session_id: 's', tool_name: tool, cwd, tool_input: { [field]: path } }, { platform: 'linux', env: {}, logDir: undefined });
    for (const [tool, field] of [['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']]) {
      expect(call(tool, field, 'null', '/dev').decision, tool).toBe('deny');
      expect(call(tool, field, './zero', '/dev').decision, tool).toBe('deny');
      expect(call(tool, field, `${join(dir, 'devlink')}/null`, '/tmp').decision, tool).toBe('deny');
      expect(call(tool, field, 'devlink/null', dir).decision, tool).toBe('deny');
      expect(call(tool, field, 'null', '/tmp').decision, tool).toBe('allow');
      expect(call(tool, field, 'null').decision, tool).toBe('allow');
      expect(call(tool, field, `${join(dir, 'plainlink')}/f`, '/dev').decision, tool).toBe('allow');
    }
  });
});

// Round 6: wrapper directories, cd in pipelines and conditionals, abbreviated options, bsdtar members and options that do not follow a link. Text only, nothing is run.
describe('/dev guard: spellings of round 6', () => {
  const check = (command: string, cwd?: string) => shell.checkBashCommand(command, { platform: 'linux', syntax: false, env: {}, devNullProbe: probeOf('healthy'), cwd });
  // env -C and --chdir (any prefix of the long option, the last one counts alone) put the wrapped command in another directory
  it.each([
    ['env -C /dev rm null', '/tmp'], ['env -C /dev -i rm null', '/tmp'], ['env -iC /dev rm null', '/tmp'], ['env -C/dev rm null', '/tmp'], ['env --chdir=/dev rm null', '/tmp'], ['env --chdir /dev rm null', '/tmp'],
    ['env --chd /dev rm null', '/tmp'], ['env --c=/dev rm null', '/tmp'], ['env --ch=/dev rm ./null', '/tmp'], ['env -C /tmp -C /dev rm null', '/tmp'], ['env -C / env -C dev rm null', '/tmp'],
    ['cd /tmp && env -C /dev rm null', '/tmp'], ['env -C /dev FOO=1 rm null', '/tmp'], ['env -C /dev sudo rm null', '/tmp'], ['env -C /dev mv null /tmp/x', '/tmp'], ['env -C /dev truncate -s 0 null', undefined],
    ['env -C dev rm null', '/'], ['env -C "$X" rm foo', '/tmp'], ['env -C /dev -S "rm null"', '/tmp'], ["env -C /dev -S 'rm null'", '/tmp'], ['env -C /dev env rm null', '/tmp'],
  ])('refuses %j (session in %j)', (command, cwd) => {
    expect(check(command, cwd).decision).toBe('deny');
  });

  it.each([
    ['env -C /dev -C /tmp rm null', '/dev'], ['env -C /tmp rm null', '/dev'], ['env -C /dev rm /tmp/x', '/tmp'], ['env -C dev rm null', '/tmp'], ['env -C /dev ls', '/tmp'], ['env -C /dev echo hi; rm null', '/tmp'],
    ['env -C /tmp -C / env -C tmp rm null', '/dev'], ['env -C / -C dev rm null', '/tmp'], ['cd /dev && env -C /tmp rm null', '/tmp'], ['env -C "$X" rm /tmp/x', '/tmp'], ['env -C /dev cat null', '/tmp'], ['env --chdir=/tmp rm null', '/dev'],
  ])('allows %j (session in %j)', (command, cwd) => {
    expect(check(command, cwd).decision).toBe('allow');
  });
  // a cd in a pipeline or in the background runs in a subshell: the directory stays (bash 5.2, lastpipe off)
  it.each([
    ['cd /dev; cd /tmp | true; rm null', '/tmp'], ['cd /dev; true | cd /tmp; rm null', '/tmp'], ['cd /dev; cd /tmp & rm null', '/tmp'], ['cd /dev; cd /tmp |& cat; rm null', '/tmp'], ['cd /dev; pushd /tmp | true; rm null', '/tmp'],
    ['cd /dev; true | popd; rm null', '/tmp'], ['cd /dev; cd "$X" | true; rm null', '/tmp'], ['cd /dev; cd /tmp & wait; rm null', '/tmp'], ['rm null; cd /tmp | cat', '/dev'], ['cd /tmp | true; rm null', '/dev'], ['echo x | cd /tmp; rm null', '/dev'],
  ])('refuses %j (session in %j)', (command, cwd) => {
    expect(check(command, cwd).decision).toBe('deny');
  });

  it.each([
    ['cd /tmp; cd /dev | true; rm null', '/tmp'], ['cd /tmp; true | cd /dev; rm null', '/tmp'], ['cd /tmp; cd /dev & rm null', '/tmp'], ['cd /tmp; pushd /dev | true; rm null', '/tmp'], ['cd /tmp; cd "$X" | true; rm null', '/tmp'],
    ['cd /dev | true; rm null', '/tmp'], ['true | cd /dev; rm null', '/tmp'], ['cd /dev | true; cd /tmp; rm null', '/dev'], ['cd /dev; cd /tmp; rm null', '/tmp'], ['cd "$X" | true; rm foo', '/tmp'],
  ])('allows %j (session in %j)', (command, cwd) => {
    expect(check(command, cwd).decision).toBe('allow');
  });
  // a cd that may not run leaves the directory unknown once the chain or the body ends (measured with bash 5.2: it is skipped after a failed && and a false if)
  it.each([
    ['cd /dev; false && cd /tmp; rm null', '/tmp'], ['cd /dev; false && cd /tmp && true; rm null', '/tmp'], ['cd /dev; true && cd /tmp; rm null', '/tmp'], ['cd /dev; if false; then cd /tmp; fi; rm null', '/tmp'],
    ['cd /dev; if false; then :; else cd /tmp; fi; rm null', '/tmp'], ['cd /dev; if false; then :; elif true; then cd /tmp; fi; rm null', '/tmp'], ['cd /dev; for i in 1; do cd /tmp; done; rm null', '/tmp'],
    ['cd /dev; while false; do cd /tmp; done; rm null', '/tmp'], ['cd /dev; case x in y) cd /tmp;; esac; rm null', '/tmp'], ['cd /dev; case x in x) cd /tmp;; esac; rm null', '/tmp'], ['cd /dev; false && { cd /tmp; }; rm null', '/tmp'],
    ['cd /tmp; false && cd /dev; rm null', '/tmp'], ['cd /tmp; if false; then cd /dev; fi; rm foo', '/tmp'], ['cd /tmp && cd /dev || cd /tmp; rm null', '/tmp'], ['ls && cd /dev; rm null', '/tmp'],
    ['cd /dev; if true; then cd /tmp; fi; rm null', '/tmp'], ['cd /dev; until false; do cd /tmp; done; rm null', '/tmp'],
  ])('refuses %j (session in %j)', (command, cwd) => {
    expect(check(command, cwd).decision).toBe('deny');
  });

  it.each([
    ['cd /tmp && rm null', '/dev'], ['make && cd /tmp && rm null', '/dev'], ['true && cd /tmp; rm null', '/tmp'], ['cd /dev && cd /tmp && rm null', '/tmp'], ['ls && cd /tmp && ls && rm null', '/tmp'], ['cd /tmp; if false; then cd /tmp; fi; rm null', '/tmp'],
    ['cd /tmp; case x in y) ls;; esac; rm null', '/tmp'], ['false && ls; rm null', '/tmp'], ['if cd /tmp; then rm null; fi', '/dev'], ['cd /tmp; for i in 1; do ls; done; rm null', '/dev'],
    ['cd /dev; if false; then cd /tmp; fi; rm /tmp/x', '/tmp'], ['cd /dev; false && cd /tmp; ls', '/tmp'], ['cd /dev; false && cd /tmp; echo x > null', '/tmp'],
  ])('allows %j (session in %j)', (command, cwd) => {
    expect(check(command, cwd).decision).toBe('allow');
  });

  // a value option of tar written as a prefix takes the next word too (measured with GNU tar 1.35: --la, --listed-i and --index-f are taken, --sparse and
  // --xattrs are flags whose next word is a member); here the word is -C, which is then a value and not a directory step
  it.each([
    ['cd /; tar -xf /tmp/a.tar x --labe -C /tmp dev/null', 'deny'], ['cd /; tar -xf /tmp/a.tar x --la -C /tmp dev/null', 'deny'], ['cd /; tar -xf /tmp/a.tar x --lab -C /tmp dev/null', 'deny'],
    ['cd /; tar -xf /tmp/a.tar x --label -C /tmp dev/null', 'deny'], ['cd /; tar -xf /tmp/a.tar x --listed-i -C /tmp dev/null', 'deny'], ['cd /; tar -xf /tmp/a.tar x --index-f -C /tmp dev/null', 'deny'],
    ['cd /; tar -xf /tmp/a.tar x --volno-f -C /tmp dev/null', 'deny'], ['cd /; tar -xf /tmp/a.tar x --rsh-c -C /tmp dev/null', 'deny'], ['cd /; tar -xf /tmp/a.tar x --exclude-f -C /tmp dev/null', 'deny'],
    ['cd /; tar x --labe -C -f /tmp/a.tar dev/null', 'deny'],
    ['cd /; tar -xf /tmp/a.tar x --sparse -C /tmp dev/null', 'allow'], ['cd /; tar -xf /tmp/a.tar x --xattrs -C /tmp dev/null', 'allow'], ['cd /; tar -xf /tmp/a.tar x --list -C /tmp dev/null', 'allow'],
    ['cd /; tar -xf /tmp/a.tar x --checkpoint -C /tmp dev/null', 'allow'], ['cd /; tar -xf /tmp/a.tar x --labe=L -C /tmp dev/null', 'allow'], ['cd /; tar -xf /tmp/a.tar x --verbose -C /tmp dev/null', 'allow'],
    ['cd /; tar -xf /tmp/a.tar x --labe L -C /tmp dev/null', 'allow'],
  ])('reads the prefixes of the value options of tar: %s is %s', (command, expected) => {
    expect(check(command).decision).toBe(expected);
  });

  // bsdtar reads every word after its first member as a member, an option too (measured with bsdtar 3.7.4: a late -C, --cd or --exclude is a name that is not
  // in the archive); GNU tar applies -C from its place on
  it.each([
    ['cd /; bsdtar -xf /tmp/a.tar x -C /tmp dev/null', 'deny'], ['cd /; bsdtar -xf /tmp/a.tar x --cd /tmp dev/null', 'deny'], ['cd /; bsdtar -xf /tmp/a.tar x --directory /tmp dev/null', 'deny'],
    ['cd /; bsdtar -xf /tmp/a.tar dev/null -C /tmp', 'deny'], ['cd /; bsdtar -xf /tmp/a.tar x -C /tmp -C /tmp2 dev/null', 'deny'], ['cd /; bsdtar -xf /tmp/a.tar x --strip-components=1 dev/null', 'deny'],
    ['cd /; bsdtar -xf /tmp/a.tar -C /tmp x dev/null', 'allow'], ['cd /; bsdtar -C /tmp -xf /tmp/a.tar dev/null', 'allow'], ['cd /; bsdtar -xf /tmp/a.tar x -C /tmp', 'allow'],
    ['cd /; bsdtar -xf /tmp/a.tar -C /tmp x -C /tmp2 y', 'allow'], ['cd /; bsdtar -xf /tmp/a.tar --strip-components=1 dev/null', 'allow'],
    ['cd /; tar -xf /tmp/a.tar x -C /tmp dev/null', 'allow'], ['cd /; tar -xf /tmp/a.tar x --directory /tmp dev/null', 'allow'],
  ])('reads the words after the first member of bsdtar as members: %s is %s', (command, expected) => {
    expect(check(command).decision).toBe(expected);
  });
});
