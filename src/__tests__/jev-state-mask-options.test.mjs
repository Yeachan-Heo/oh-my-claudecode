/**
 * scripts/lib/jev-state-mask.mjs: the options of a command line that carry a credential (CREDENTIAL_OPTIONS), in every way they can
 * be written, as text, as an array of arguments and as an array of arguments with a window. One grid, built from the table: a row
 * that is added to the table is tested in all its forms, and the expected result of each cell is written out.
 */
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_OPTIONS, PROGRAMS, WINDOW_MARGIN, maskJevState } from '../../scripts/lib/jev-state-mask.mjs';

const SECRET = 'hunter2zzQ';
const MAX = 200;
const asText = (value, options) => maskJevState({ t: value }, options).t;
const asArgv = (value, options) => maskJevState({ argv: value }, options).argv;

// One row for every name and every letter of the table: [the option as written, its row]
const rows = CREDENTIAL_OPTIONS.flatMap((option) => (option.names ?? [option.letter]).map((name) => ({
  opt: option.names ? `--${name}` : `-${name}`,
  long: Boolean(option.names),
  kind: option.value,
  flags: option.flags ?? '',
  letter: option.letter,
  program: option.program,
  // the commands the option counts after: every program of its kind, or a command that is no program at all
  commands: option.program ? PROGRAMS[option.program] : ['tool'],
})));

// what a value becomes: `name:password` keeps its name, any other value goes whole
const valueOf = (row, spaced) => (row.kind === 'user' ? `u:${spaced ? 'a ' : ''}${SECRET}` : `${spaced ? 'a ' : ''}${SECRET}`);
const maskedOf = (row) => (row.kind === 'user' ? 'u:***' : '***');

/**
 * The forms of one option: [name, text, text after the mask, array of arguments, array after the mask]. The words of the text and
 * the elements of the array say the same thing, as a shell would split it, and the text ends with a word that no rule touches.
 */
function formsOf(row) {
  const { opt, kind, flags, letter } = row;
  const plain = valueOf(row, false);
  const spaced = valueOf(row, true);
  const masked = maskedOf(row);
  const forms = [];
  const add = (name, text, textMasked, args, argsMasked) => forms.push({ name, text, textMasked, args, argsMasked });
  // a quoted value keeps its quotes when its password is only part of it (a name stays), and goes whole when it is all of it
  const quoted = (quote) => (kind === 'user' ? `${quote}${masked}${quote}` : '***');
  if (row.long) {
    add('apart', `${opt} ${plain}`, `${opt} ${masked}`, [opt, plain], [opt, masked]);
    add('with =', `${opt}=${plain}`, `${opt}=${masked}`, [`${opt}=${plain}`], [`${opt}=${masked}`]);
    add('in capitals, apart', `${opt.toUpperCase()} ${plain}`, `${opt.toUpperCase()} ${masked}`, [opt.toUpperCase(), plain], [opt.toUpperCase(), masked]);
    add('in capitals, with =', `${opt.toUpperCase()}=${plain}`, `${opt.toUpperCase()}=${masked}`, [`${opt.toUpperCase()}=${plain}`], [`${opt.toUpperCase()}=${masked}`]);
    add('value in single quotes', `${opt} '${spaced}'`, `${opt} ${quoted("'")}`, [opt, spaced], [opt, masked]);
    add('value in double quotes after =', `${opt}="${spaced}"`, `${opt}=${quoted('"')}`, [`${opt}=${spaced}`], [`${opt}=${masked}`]);
    add('the whole option in quotes', `"${opt}=${spaced}"`, `"${opt}=${masked}"`, [`${opt}=${spaced}`], [`${opt}=${masked}`]);
    add('every word in quotes', `'${opt}' '${plain}'`, `'${opt}' ${quoted("'")}`, [opt, plain], [opt, masked]);
    add('after --', `-- ${opt} ${plain}`, `-- ${opt} ${masked}`, ['--', opt, plain], ['--', opt, masked]);
    add('a backslash before a space', `${opt} ${spaced.replace(' ', '\\ ')}`, `${opt} ${masked}`, [opt, spaced], [opt, masked]);
  } else {
    // a short option that is stuck to its value or has an = in front of it has the credential from the letter on
    const stuck = kind === 'user' ? (value) => `${opt}${value}` : () => `${opt}***`;
    add('apart', `${opt} ${plain}`, `${opt} ${masked}`, [opt, plain], [opt, masked]);
    add('stuck', `${opt}${plain}`, `${opt}${masked}`, [`${opt}${plain}`], [`${opt}${masked}`]);
    add('with =', `${opt}=${plain}`, stuck(`=${masked}`), [`${opt}=${plain}`], [stuck(`=${masked}`)]);
    if (flags) {
      const cluster = `-${flags.slice(0, 3)}${letter}`;
      add('last in a cluster of flags, apart', `${cluster} ${plain}`, `${cluster} ${masked}`, [cluster, plain], [cluster, masked]);
      add('last in a cluster of flags, stuck', `${cluster}${plain}`, `${cluster}${masked}`, [`${cluster}${plain}`], [`${cluster}${masked}`]);
    }
    add('value in single quotes, apart', `${opt} '${spaced}'`, `${opt} ${quoted("'")}`, [opt, spaced], [opt, masked]);
    add('value in single quotes, stuck', `${opt}'${spaced}'`, kind === 'user' ? `${opt}${quoted("'")}` : `${opt}***`, [`${opt}${spaced}`], [`${opt}${masked}`]);
    add('value in double quotes, stuck', `${opt}"${spaced}"`, kind === 'user' ? `${opt}${quoted('"')}` : `${opt}***`, [`${opt}${spaced}`], [`${opt}${masked}`]);
    add('the whole option in quotes', `"${opt}${spaced}"`, `"${opt}${masked}"`, [`${opt}${spaced}`], [`${opt}${masked}`]);
    add('every word in quotes', `'${opt}' '${plain}'`, `'${opt}' ${quoted("'")}`, [opt, plain], [opt, masked]);
    add('after --', `-- ${opt} ${plain}`, `-- ${opt} ${masked}`, ['--', opt, plain], ['--', opt, masked]);
    add('a backslash before a space', `${opt} ${spaced.replace(' ', '\\ ')}`, `${opt} ${masked}`, [opt, spaced], [opt, masked]);
  }
  return forms;
}

// the text and the array of one command with the option: `prefix` words, the form, a last word
const textOf = (command, form) => `${command} ${form.text} tail`;
const textMaskedOf = (command, form) => `${command} ${form.textMasked} tail`;
const argvOf = (command, form, args) => [command, ...args, 'tail'];

describe('maskJevState: the options of a command line that carry a credential, by the table', () => {
  it('has the rows it says it has', () => {
    expect(rows.map((row) => row.opt)).toEqual([
      '--password', '--passwd', '--pass', '--token', '--secret', '--api-key', '--apikey', '--access-token', '--auth-token', '--client-secret', '--http-password', '--ftp-password', '--proxy-password', '--oauth2-bearer', '--cookie',
      '--user', '--proxy-user', '-u', '-U', '-b', '-p', '-a',
    ]);
    expect(Object.keys(PROGRAMS)).toEqual(['mysql', 'curl', 'redis-cli']);
    expect(PROGRAMS.mysql).toEqual(['mysql', 'mysqldump', 'mysqladmin', 'mariadb', 'sshpass']);
  });

  describe.each(rows.map((row) => [row.opt, row]))('%s', (_opt, row) => {
    const forms = formsOf(row);

    it('is masked in every form, as text, as an array and as an array with a window, with the result written out', () => {
      let cells = 0;
      for (const command of row.commands) {
        for (const form of forms) {
          const label = `${command} ${form.name}: ${textOf(command, form)}`;
          expect(asText(textOf(command, form)), `${label} (text)`).toBe(textMaskedOf(command, form));
          expect(asText(textOf(command, form), { maxChars: MAX }), `${label} (text, window)`).toBe(textMaskedOf(command, form));
          expect(asArgv(argvOf(command, form, form.args)), `${label} (array)`).toEqual(argvOf(command, form, form.argsMasked));
          expect(asArgv(argvOf(command, form, form.args), { maxChars: MAX }), `${label} (array, window)`).toEqual(argvOf(command, form, form.argsMasked));
          // a second pass changes nothing
          expect(asText(textMaskedOf(command, form)), `${label} (second pass, text)`).toBe(textMaskedOf(command, form));
          expect(asArgv(argvOf(command, form, form.argsMasked)), `${label} (second pass, array)`).toEqual(argvOf(command, form, form.argsMasked));
          cells++;
        }
      }
      expect(cells).toBe(row.commands.length * forms.length);
    });

    it('shows no more with a window than without one: the option at every distance from the edge of the window, and after a long argument', () => {
      const command = row.commands[0];
      for (const form of forms) {
        const reference = asText(textOf(command, form));
        expect(reference, `${form.name}: the reference hides it`).not.toContain(SECRET);
        for (let offset = MAX - 60; offset <= MAX + WINDOW_MARGIN + 60; offset += 12) {
          const input = `${'w '.repeat(Math.ceil(offset / 2)).slice(0, offset)}; ${textOf(command, form)} ${'w '.repeat(300)}`;
          // a command ends at the `;`, so the program is named again in this one
          const inCommand = `${'w '.repeat(Math.ceil(offset / 2)).slice(0, offset)}\n${textOf(command, form)} ${'w '.repeat(300)}`;
          for (const text of [input, inCommand]) {
            const sent = asText(text, { maxChars: MAX }).slice(0, MAX);
            expect(sent, `${form.name} at ${offset}`).not.toContain('hunte');
          }
        }
        // the elements of the array before it are longer than the window; what is sent of each is its first MAX characters
        for (const length of [MAX - 1, MAX + 1, MAX + WINDOW_MARGIN + 1, 100_000]) {
          const array = [command, 'z'.repeat(length), ...form.args, 'tail'];
          const sent = asArgv(array, { maxChars: MAX }).map((item) => item.slice(0, MAX));
          expect(JSON.stringify(sent), `${form.name} after an argument of ${length}`).not.toContain('hunte');
          const withoutWindow = JSON.stringify(asArgv(array));
          expect(withoutWindow, `${form.name} the reference`).not.toContain(SECRET);
        }
      }
    });

    it('leaves alone what is not the option: another case of a short letter, a longer name, a value that has no password', () => {
      const command = row.commands[0];
      const plain = valueOf(row, false);
      const stays = [];
      if (row.long) {
        stays.push([`${row.opt}-file`, plain], [`${row.opt}x`, plain]);
      } else {
        const swapped = row.letter === row.letter.toLowerCase() ? row.letter.toUpperCase() : row.letter.toLowerCase();
        // the other case is no option, unless it is one of the table (-u and -U)
        if (!CREDENTIAL_OPTIONS.some((option) => option.letter === swapped)) stays.push([`-${swapped}`, plain]);
      }
      if (row.kind === 'user') stays.push([row.opt, 'root'], [row.opt, 'u:']);
      for (const [word, value] of stays) {
        const sameText = `${command} ${word} ${value} tail`;
        expect(asText(sameText), `text: ${sameText}`).toBe(sameText);
        expect(asArgv([command, word, value, 'tail']), `array: ${sameText}`).toEqual([command, word, value, 'tail']);
      }
      if (row.kind === 'user') {
        const stuck = row.long ? `${row.opt}=root` : `${row.opt}root`;
        expect(asText(`${command} ${stuck} tail`)).toBe(`${command} ${stuck} tail`);
        expect(asArgv([command, stuck, 'tail'])).toEqual([command, stuck, 'tail']);
      }
    });

    if (row.program) {
      it(`counts only after a program of its kind (${row.commands.join(', ')}): not without one, not before it, not in an earlier command`, () => {
        const plain = valueOf(row, false);
        const program = row.commands[0];
        const word = `${row.opt} ${plain}`;
        const same = (text) => expect(asText(text), text).toBe(text);
        same(`tool ${word} tail`);
        same(`${word} ${program} tail`);
        for (const end of [';', '&&', '|', '\n', ' | tee x;', '&']) same(`${program} -x${end} tool ${word} tail`);
        expect(asArgv(['tool', row.opt, plain, 'tail'])).toEqual(['tool', row.opt, plain, 'tail']);
        expect(asArgv([row.opt, plain, program, 'tail'])).toEqual([row.opt, plain, program, 'tail']);
        // a separator inside quotes does not end the command, and a program inside quotes counts
        expect(asText(`${program} -e "a; b" ${word} tail`)).toBe(`${program} -e "a; b" ${row.opt} ${maskedOf(row)} tail`);
        expect(asText(`sh -c "${program} ${word}"`)).toBe(`sh -c "${program} ${row.opt} ${maskedOf(row)}"`);
      });
    }
  });
});

describe('maskJevState: the decisions of the table, one by one', () => {
  it.each([
    // the exact input of the finding
    [`curl -uuser:${SECRET}`, 'curl -uuser:***'],
    [`curl -u user:${SECRET}`, 'curl -u user:***'],
    [`curl -sSu user:${SECRET} https://h/`, 'curl -sSu user:*** https://h/'],
    [`curl -sSuuser:${SECRET} https://h/`, 'curl -sSuuser:*** https://h/'],
    [`curl --proxy-user user:${SECRET} -x http://p`, 'curl --proxy-user user:*** -x http://p'],
    [`curl -U user:${SECRET} -x http://p`, 'curl -U user:*** -x http://p'],
    [`curl --oauth2-bearer ${SECRET} https://h/`, 'curl --oauth2-bearer *** https://h/'],
    // mysql: -p stuck, apart (the database name goes too: fail closed), in a cluster, after a program in capitals
    [`mysql -u root -p${SECRET} db`, 'mysql -u root -p*** db'],
    [`mysql -u root -p ${SECRET} db`, 'mysql -u root -p *** db'],
    ['mysql -u root -p mydb', 'mysql -u root -p ***'],
    [`mysql -sNp${SECRET} -e x`, 'mysql -sNp*** -e x'],
    [`C:\\bin\\MYSQL.EXE -p${SECRET}`, 'C:\\bin\\MYSQL.EXE -p***'],
    [`mariadb-dump -p'a ${SECRET}' db`, 'mariadb-dump -p*** db'],
    // the port and the host of mysql are no flags of a cluster with -p
    ['mysql -hprod-db -P3306 -u root', 'mysql -hprod-db -P3306 -u root'],
    [`mysql -hprod-db -P3306 -p${SECRET}`, 'mysql -hprod-db -P3306 -p***'],
    // sshpass -f names a file, not a password
    ['sshpass -f /etc/pw ssh host', 'sshpass -f /etc/pw ssh host'],
    [`sshpass -p ${SECRET} ssh host`, 'sshpass -p *** ssh host'],
    [`redis-cli -h h -a ${SECRET} ping`, 'redis-cli -h h -a *** ping'],
    [`redis-cli --pass ${SECRET} ping`, 'redis-cli --pass *** ping'],
    // no program, no -p, -a, -U
    ['ssh -p 2222 host', 'ssh -p 2222 host'],
    ['ls -a x', 'ls -a x'],
    ['pip install -U pkg:1', 'pip install -U pkg:1'],
    ['mysql -u root | tee x; ssh -p 22 host', 'mysql -u root | tee x; ssh -p 22 host'],
    // a password that holds a separator in quotes
    [`mysql -p'a;b ${SECRET}' -e x`, 'mysql -p*** -e x'],
    // wget and the others
    [`wget --http-password=${SECRET} --ftp-password ${SECRET} --proxy-password="${SECRET} x" u`, 'wget --http-password=*** --ftp-password *** --proxy-password=*** u'],
    // psql takes no password option: its forms are the assignment and the URL
    [`PGPASSWORD=${SECRET} psql -h h`, 'PGPASSWORD=*** psql -h h'],
    [`psql "host=h user=u password=${SECRET}"`, 'psql "host=h user=u password=***"'],
    [`psql postgresql://u:${SECRET}@h/db`, 'psql postgresql://u:***@h/db'],
    // a quoted word of text keeps its quotes in pairs
    [`curl -u 'user:pa ss ${SECRET}' -H 'A: b' h`, "curl -u 'user:***' -H 'A: b' h"],
    [`curl -u "user:${SECRET}" -H 'A: b' h`, `curl -u "user:***" -H 'A: b' h`],
    [`curl "--user=u:pa ${SECRET}" h`, 'curl "--user=u:***" h'],
    [`curl -u 'user':'${SECRET}' h`, "curl -u 'user':*** h"],
    [`curl -u user:${SECRET}\\ x h`, 'curl -u user:*** h'],
    [`curl -u='user:a ${SECRET}' h`, "curl -u='user:***' h"],
    [`sh -c "mysql -p ${SECRET}"`, 'sh -c "mysql -p ***"'],
    [`sh -c "mysql -p${SECRET}" && echo done`, 'sh -c "mysql -p***" && echo done'],
    // an array written out as text: nothing of the password is left, whatever the quotes and commas do
    [`'-u' 'user:${SECRET}' h`, "'-u' 'user:***' h"],
    [`["curl", "-u", "user:${SECRET}", "h"]`, '["curl", "-u", "user:***", "h"]'],
  ])('%s', (input, expected) => {
    expect(asText(input)).toBe(expected);
  });

  it('hides the password of an array written out as text, and of the arguments of a command inside a quoted string', () => {
    for (const input of [`["mysql","-p","${SECRET}","db"]`, `["curl","-u","user:${SECRET}"]`, `["mysql", "-p${SECRET}"]`, `'bash' '-c' 'mysql -u r -p${SECRET}'`]) {
      expect(asText(input), input).not.toContain(SECRET);
    }
  });

  it.each([
    [`Authorization: Bearer ${SECRET}`, 'Authorization: Bearer ***'],
    [`authorization:bearer ${SECRET}`, 'authorization:bearer ***'],
    [`AUTHORIZATION: Basic ${SECRET}`, 'AUTHORIZATION: Basic ***'],
    [`Proxy-Authorization: Basic ${SECRET}`, 'Proxy-Authorization: Basic ***'],
    [`Authorization: Bearer "${SECRET}"`, 'Authorization: Bearer ***'],
    [`Authorization: Digest username="u", response="${SECRET}"`, 'Authorization: ***'],
    [`Authorization: ApiKey ${SECRET}`, 'Authorization: ***'],
    [`Authorization: Negotiate ${SECRET}`, 'Authorization: ***'],
    [`curl -H "Authorization: Bearer ${SECRET}" -H "Accept: x" h`, 'curl -H "Authorization: Bearer ***" -H "Accept: x" h'],
    [`curl -H 'Authorization: Digest u="a", r="${SECRET}"' -H "Accept: x" h`, `curl -H 'Authorization: ***' -H "Accept: x" h`],
    [`{"Authorization": "Bearer ${SECRET}", "Accept": "x"}`, '{"Authorization": "Bearer ***", "Accept": "x"}'],
    [`{"headers": {"Authorization": "Digest u=\\"a\\", r=\\"${SECRET}\\""}}`, '{"headers": {"Authorization": "***"}}'],
    [`> Authorization: Bearer ${SECRET}\n> Host: h`, '> Authorization: Bearer ***\n> Host: h'],
    ['Authorization:', 'Authorization:'],
    ['the Authorization: header', 'the Authorization: ***'],
  ])('the Authorization header: %s', (input, expected) => {
    expect(asText(input)).toBe(expected);
    expect(asText(expected), 'a second pass').toBe(expected);
  });

  it('keeps a secret out of an array of arguments whatever the element that holds it, and masks the value after a flag that is no string', () => {
    expect(asArgv(['tool', '--password', 5, 'x'])).toEqual(['tool', '--password', '***', 'x']);
    expect(asArgv(['tool', '--user', 5, 'x'])).toEqual(['tool', '--user', 5, 'x']);
    expect(asArgv(['curl', '-u', `a:${SECRET}`, '-u', `b:${SECRET}`])).toEqual(['curl', '-u', 'a:***', '-u', 'b:***']);
    expect(asArgv(['mysql', 'x', 'curl', 'redis-cli', `-p${SECRET}`, '-U', `u:${SECRET}`, '-a', SECRET, 'tail'])).toEqual(['mysql', 'x', 'curl', 'redis-cli', '-p***', '-U', 'u:***', '-a', '***', 'tail']);
    expect(asArgv(['curl', '-U', `u:${SECRET}`, 'redis-cli', '-a', SECRET])).toEqual(['curl', '-U', 'u:***', 'redis-cli', '-a', '***']);
  });

  it('keeps what the table leaves alone: a long name that only starts like an option, and a docker login', () => {
    expect(asText(`run --password-file=/etc/x y --token-count 5`)).toBe('run --password-file=/etc/x y --token-count 5');
    expect(asText(`docker login -u me -p ${SECRET}`)).toContain(SECRET);
    expect(asArgv(['docker', 'login', '--password-stdin', '-u', 'me'])).toEqual(['docker', 'login', '--password-stdin', '-u', 'me']);
  });
});

describe('maskJevState: random commands, each with one option, against the table', () => {
  // a small deterministic generator, so a failure names the same input every time
  const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const KEY = 'Zq7xK9mW';
  // [a program as written, its kind]
  const programs = [['mysql', 'mysql'], ['mysqldump', 'mysql'], ['mariadb', 'mysql'], ['sshpass', 'mysql'], ['curl', 'curl'], ['redis-cli', 'redis-cli'], ['MYSQL.EXE', 'mysql'], ['/usr/bin/curl', 'curl'], ['docker exec db mysql', 'mysql'], ['tool', ''], ['sh -c', '']];
  // [the option written out with a value builder, the kind of program it needs]. A builder gets a value maker: (prefix, plain) => text
  const options = [
    [(v) => `-u ${v('u:')}`, ''], [(v) => `-u${v('u:')}`, ''], [(v) => `-u=${v('u:')}`, ''], [(v) => `--user ${v('u:')}`, ''], [(v) => `--user=${v('u:')}`, ''], [(v) => `--USER=${v('u:')}`, ''],
    [(v) => `-sSu ${v('u:')}`, ''], [(v) => `-sSu${v('u:')}`, ''], [(v) => `-U ${v('u:')}`, 'curl'], [(v) => `--proxy-user ${v('u:')}`, ''],
    [(v) => `-p ${v('')}`, 'mysql'], [(v) => `-p${v('')}`, 'mysql'], [(v) => `-sNp${v('')}`, 'mysql'], [(v) => `-a ${v('')}`, 'redis-cli'], [(v) => `-a${v('')}`, 'redis-cli'],
    [(v) => `--password ${v('')}`, ''], [(v) => `--password=${v('')}`, ''], [(v) => `--token ${v('')}`, ''], [(v) => `--api-key=${v('')}`, ''], [(v) => `--ftp-password ${v('')}`, ''],
    [(v) => `-H "Authorization: Bearer ${v('', true)}"`, ''], [(v) => `-H 'Authorization: Basic ${v('', true)}'`, ''], [(v) => `Authorization: Digest a="b", c="${v('', true)}"`, ''],
    [(v) => `'-u' '${v('u:', true)}'`, ''], [(v) => `"-p" "${v('', true)}"`, 'mysql'], [(v) => `"--user=${v('u:', true)}"`, ''],
  ];
  const fill = ['-v', '-e "select 1; select 2"', '-h host', '-P 3306', '--port=22', 'db', 'x', '--', "-H 'A: b'"];
  const values = [(p) => `${p}${KEY}`, (p) => `'${p}a b ${KEY}'`, (p) => `"${p}a ${KEY}"`, (p) => `${p}a\\ ${KEY}`, (p) => `${p}'x'${KEY}`];

  it('hides the key of each one, the same again on a second pass, and in the sent part of a window, for 3000 commands of a fixed seed', () => {
    const next = seeded(20260517);
    const pick = (list) => list[Math.floor(next() * list.length)];
    let masked = 0;
    for (let n = 0; n < 3000; n++) {
      const [program, kind] = pick(programs);
      const [build, needs] = pick(options);
      const value = pick(values);
      const parts = [program];
      for (let i = 0, count = Math.floor(next() * 3); i < count; i++) parts.push(pick(fill));
      parts.push(build((prefix, plain) => (plain ? `${prefix}${KEY}` : value(prefix))));
      if (next() < 0.5) parts.push(pick(fill));
      const text = (next() < 0.3 ? 'w '.repeat(Math.floor(next() * 120)) : '') + parts.join(' ');
      const out = asText(text);
      if (needs === '' || needs === kind) {
        expect(out, text).not.toContain(KEY);
        for (const max of [60, MAX]) {
          expect(asText(text, { maxChars: max }).slice(0, max), `${text}: window ${max}`).not.toContain(KEY.slice(0, 4));
        }
        masked++;
      } else {
        expect(out, `${text}: an option of another program stays`).toContain(KEY);
      }
      expect(asText(out), `${text}: a second pass`).toBe(out);
    }
    expect(masked).toBeGreaterThan(2000);
  });
});

describe('maskJevState: the cost of the options is the window, not the input', () => {
  // CPU time of this process in ms. Time spent waiting for a free core, which grows with the load of the machine, does
  // not count. The default pool of the test runner gives each test file its own process.
  const cpuMs = () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  };
  const repeatTo = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  // text shapes that a rule that backtracks or reads on from every start would take quadratic time on
  const shapes = {
    'a dash and a run of the letter': (n) => `-${'u'.repeat(n)}`,
    'one cluster': (n) => `-${repeatTo('sS', n)}`,
    'many clusters with no option at their end': (n) => repeatTo('-sS ', n),
    'many clusters that end in an option with no value': (n) => repeatTo('-sSu ', n),
    'quotes': (n) => "'".repeat(n),
    'an option and quotes': (n) => `-u ${"'".repeat(n)}`,
    'many options': (n) => repeatTo('-u ', n),
    'many quoted options': (n) => repeatTo('"-u" ', n),
    'a program and many commands': (n) => `${repeatTo('mysql ;', n)} -p x`,
    'a program and many -p': (n) => `mysql ${repeatTo('-p ', n)}`,
    'long names': (n) => repeatTo('--password ', n),
    'long names with =': (n) => repeatTo('--user=', n),
    'headers': (n) => repeatTo('Authorization:', n),
    'headers and quotes': (n) => repeatTo('Authorization: "', n),
    'backslashes after an option': (n) => `-u ${'\\'.repeat(n)}`,
    'a program with no option at the end of each line': (n) => repeatTo('redis-cli x\n', n),
    'apostrophes and commands': (n) => `${repeatTo("' ;", n)}mysql -p x`,
  };
  it.each(Object.keys(shapes))('reads %s of 8 MiB to its window and no further', (name) => {
    const text = shapes[name](8 * 1024 * 1024);
    const times = [];
    for (let i = 0; i < 3; i++) {
      const started = cpuMs();
      maskJevState({ t: text }, { maxChars: MAX });
      times.push(cpuMs() - started);
    }
    expect(Math.min(...times)).toBeLessThan(300);
  });

  it.each(Object.keys(shapes))('takes time in proportion to the text without a window: %s', (name) => {
    // 1 MiB then 4 MiB: four times the text takes well under sixteen times as long (a quadratic rule would take sixteen)
    const time = (n) => {
      const text = shapes[name](n);
      const best = [];
      for (let i = 0; i < 3; i++) {
        const started = cpuMs();
        maskJevState({ t: text });
        best.push(cpuMs() - started);
      }
      return Math.min(...best);
    };
    const small = time(1024 * 1024);
    const large = time(4 * 1024 * 1024);
    expect(large, `${small.toFixed(0)} ms, then ${large.toFixed(0)} ms`).toBeLessThan(Math.max(small, 25) * 12);
  });
});
