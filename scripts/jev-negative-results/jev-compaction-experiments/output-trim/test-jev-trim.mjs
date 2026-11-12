// Unit tests of the reference trimmer (jev-trim.mjs). Usage: node test-jev-trim.mjs [path to jev-trim.mjs]
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const target = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./jev-trim.mjs', import.meta.url));
const T = await import(pathToFileURL(target).href);
let ok = 0; let bad = 0;
const t = (name, cond, extra = '') => { if (cond) ok++; else { bad++; console.log('NIE  ' + name + (extra ? '  ' + extra : '')); } };
const eq = (name, got, want) => t(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// 1-2: terminal
eq('ansi kolory', T.stripTerminalNoise('\x1b[31mred\x1b[0m text').text, 'red text');
eq('ansi licznik', T.stripTerminalNoise('\x1b[31mred\x1b[0m').ansi, 9);
eq('cr: pasek postepu do stanu koncowego', T.stripTerminalNoise('10%\r20%\r100% done\nnext').text, '100% done\nnext');
eq('cr: nadpisanie nie usuwa ogona', T.stripTerminalNoise('abcdef\rXY').text, 'XYcdef');
eq('cr: erase line', T.stripTerminalNoise('abcdef\r\x1b[KXY').text, 'XY');
eq('crlf zostaje', T.stripTerminalNoise('a\r\nb\r\n').text, 'a\r\nb\r\n');
eq('crlf z paskiem', T.stripTerminalNoise('a 1\ra 2\ra 3\r\nb\r\n').text, 'a 3\r\nb\r\n');
eq('OSC (hiperlacze)', T.stripTerminalNoise('\x1b]8;;http://x\x07link\x1b]8;;\x07').text, 'link');
eq('niedokonczona sekwencja', T.stripTerminalNoise('ok\x1b[3').text, 'ok');
eq('tab i polskie litery bez zmian', T.stripTerminalNoise('zażółć\tgęślą\n').text, 'zażółć\tgęślą\n');
eq('znaki sterujace', T.stripTerminalNoise('a\x00b\x07c').text, 'abc');
eq('backspace', T.stripTerminalNoise('abc\b\bX').text, 'aXc');
eq('CSI G', T.stripTerminalNoise('abcdef\x1b[1GXY').text, 'XYcdef');
{
  const t0 = Date.now();
  const a = T.stripTerminalNoise('x\x1b[50000000Cy').text;
  const b = T.stripTerminalNoise('x\x1b[300000000Gy').text;
  t('wrogie ESC[...C i ESC[...G: szybko i bez wyjatku', Date.now() - t0 < 500 && a.length <= 210 && b.length <= 210, `${Date.now() - t0} ms ${a.length} ${b.length}`);
  const t1 = Date.now();
  T.looksLikeSecret('-eyJ'.repeat(60000));
  t('looksLikeSecret na -eyJ x60000 szybko', Date.now() - t1 < 1500, `${Date.now() - t1} ms`);
}

// 3: powtorzenia
{
  const X = 'x'.repeat(30);
  const r = T.collapseRepeats(['a', X, X, X, X, X, 'b'].join('\n'));
  eq('powtorzenia', r.text, `a\n${X}\n(powtórzone 5 razy)\nb`);
  eq('dwie takie same nie ruszone', T.collapseRepeats('x\nx\ny').text, 'x\nx\ny');
  eq('puste linie nie ruszone', T.collapseRepeats('\n\n\n\n\nx').text, '\n\n\n\n\nx');
  const long = Array.from({ length: 40 }, () => 'to jest dluga linia powtorzona wiele razy').join('\n');
  t('dluga seria skrocona', T.collapseRepeats(long).text.split('\n').length === 2);
}

// 4: serie sukcesu
{
  const ok = (n) => Array.from({ length: n }, (_, i) => `✓ test numer ${i} (3 ms)`);
  const r = T.collapseSuccessSeries([...ok(20), '12 passed in 3s'].join('\n'));
  const L = r.text.split('\n');
  eq('seria: pierwsza', L[0], '✓ test numer 0 (3 ms)');
  t('seria: znacznik', /^\[… pominięto 18 kolejnych linii sukcesu \(tick\) …\]$/.test(L[1]), L[1]);
  eq('seria: ostatnia', L[2], '✓ test numer 19 (3 ms)');
  eq('seria: wynik zostaje', L[3], '12 passed in 3s');
  const mixed = [...ok(10), '✗ test numer X FAILED: boom', ...ok(10)].join('\n');
  const m = T.collapseSuccessSeries(mixed).text;
  t('blad zostaje', m.includes('✗ test numer X FAILED: boom'));
  const warn = [...ok(10), '✓ test z warning w nazwie', ...ok(10)].join('\n');
  t('linia z warning przerywa serie i zostaje', T.collapseSuccessSeries(warn).text.includes('✓ test z warning w nazwie'));
  const short = ok(7).join('\n');
  eq('7 linii to jeszcze nie seria', T.collapseSuccessSeries(short).text, short);
  const pytest = Array.from({ length: 12 }, (_, i) => `tests/test_x.py::test_${i} PASSED [ ${i}%]`).concat(['tests/test_x.py::test_bad FAILED [ 99%]']).join('\n');
  const pr = T.collapseSuccessSeries(pytest).text;
  t('pytest: FAILED zostaje', pr.includes('test_bad FAILED'));
  t('pytest: seria zwinieta', /pominięto 10 kolejnych/.test(pr));
  const cargo = Array.from({ length: 30 }, (_, i) => `   Compiling crate${i} v0.1.${i}`).join('\n') + '\n    Finished dev [unoptimized] target(s) in 5s';
  const cr = T.collapseSuccessSeries(cargo).text;
  t('cargo: Finished zostaje', cr.endsWith('Finished dev [unoptimized] target(s) in 5s') && /pominięto 28 kolejnych/.test(cr));
  // CRLF (wyjscie z Windows) tez tworzy serie
  const crlf = ok(12).map((l) => l + '\r').join('\n') + '\n12 passed\r';
  t('CRLF: seria zwinieta', /pominięto 10 kolejnych/.test(T.collapseSuccessSeries(crlf).text));
  const rustCrlf = Array.from({ length: 12 }, (_, i) => `test mod::t${i} ... ok\r`).join('\n');
  t('CRLF: rodzina z koncowka $ (rust)', /pominięto 10 kolejnych/.test(T.collapseSuccessSeries(rustCrlf).text));
  // polskie i angielskie slowa bledu przerywaja serie (takze jako czesc slowa)
  for (const w of ['błąd przejściowy', 'ostrzeżenie', 'HttpError 500', 'nie udało się', 'odmowa dostępu', 'deny rule', 'not found']) {
    const mid = [...ok(10), `✓ test ${w}`, ...ok(10)].join('\n');
    t(`slowo bledu "${w}" zostaje w wyniku`, T.collapseSuccessSeries(mid).text.includes(`✓ test ${w}`));
  }
  // rozne rodziny nie scalaja sie
  const two = [...ok(9), ...Array.from({ length: 9 }, (_, i) => `ok ${i + 1} - tap ${i}`)].join('\n');
  t('dwie rodziny: dwa znaczniki', (T.collapseSuccessSeries(two).text.match(/pominięto/g) || []).length === 2);
}

// 5: dlugie linie
{
  const line = 'A'.repeat(500) + 'M'.repeat(3000) + 'Z'.repeat(500);
  const r = T.shortenLongLines('pre\n' + line + '\npost');
  const L = r.text.split('\n');
  eq('dluga: pre', L[0], 'pre');
  eq('dluga: post', L[2], 'post');
  t('dluga: znacznik z liczba', /\[… 2\d{3} znaków pominięto …\]/.test(L[1]), L[1].slice(690, 740));
  t('dluga: glowa i ogon', L[1].startsWith('A'.repeat(500)) && L[1].endsWith('Z'.repeat(500)));
  eq('2000 znakow bez zmian', T.shortenLongLines('x'.repeat(2000)).text, 'x'.repeat(2000));
}

// klasyfikacja
eq('git diff to tresc', T.contentReason('Bash', 'git diff HEAD~1', 'x'), 'git-content');
eq('cat to tresc', T.contentReason('Bash', 'cd /tmp && cat a.txt', 'x'), 'reader-command');
eq('env + cat', T.contentReason('Bash', 'LC_ALL=C sed -n 1,20p x', 'x'), 'reader-command');
eq('pytest to nie tresc', T.contentReason('Bash', 'python -m pytest -q', 'x'), null);
eq('diff w wyniku', T.contentReason('Bash', 'cmd', 'diff --git a/x b/x\n@@ -1,2 +1,3 @@\n'), 'diff');
eq('json w wyniku', T.contentReason('Bash', 'curl x', '{"a": [1,2,3]}'), 'json');
eq('Get-Content w PS', T.contentReason('PowerShell', 'Get-Content x.txt | Select -First 5', 'x'), 'reader-command');
eq('ps json', T.contentReason('PowerShell', '$x | ConvertTo-Json', 'x'), 'ps-content');
t('sekret: klucz prywatny', T.looksLikeSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'));
t('sekret: token gh', T.looksLikeSecret('x ghp_' + 'a'.repeat(36)));
t('sekret: JWT', T.looksLikeSecret('Authorization: x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'));
t('sekret: zwykly tekst nie', !T.looksLikeSecret('Hello world, tokens are mentioned here'));
t('katalog prywatny', T.mentionsPrivateDir('C:\\work\\private\\case') && T.mentionsPrivateDir('/srv/confidential') && !T.mentionsPrivateDir('/srv/privateer') && !T.mentionsPrivateDir('/srv/projects/x'));

// trimText: polityka
{
  const small = 'a\n'.repeat(1000);
  const r0 = T.trimText('x'.repeat(3999));
  eq('<4000: bez zmian', r0.applied, false);
  const noise = Array.from({ length: 300 }, (_, i) => `\x1b[32mline ${i % 3}\x1b[0m`).join('\n');
  const r1 = T.trimText(noise);
  t('ANSI usuniete, bezstratne, bez stopki', r1.applied && !r1.lossy && !r1.text.includes('odszumiono') && !/\x1b/.test(r1.text), JSON.stringify(r1.kinds));
  const rep = Array.from({ length: 800 }, () => 'Request failed? no, retrying connection to server').join('\n');
  const r2 = T.trimText(rep, { archivePath: '/x/y.txt' });
  t('powtorzenia: zastosowane ze stopka i sciezka', r2.applied && r2.lossy && r2.text.includes('pełny wynik: /x/y.txt') && r2.text.includes('(powtórzone 800 razy)'), r2.text.slice(0, 200));
  const r2b = T.trimText(rep, { archivePath: null });
  t('sekret: stopka bez sciezki', r2b.text.includes('uruchom polecenie ponownie'));
  const r3 = T.trimText(rep, { content: 'diff' });
  eq('tresc: bez zmian', r3.applied, false);
  eq('tresc: tekst bez zmian', r3.text, rep);
  const r4 = T.trimText('abc\n'.repeat(1500) + 'koniec');
  t('zysk ponizej progu: bez zmian', !r4.applied || r4.saved >= 300);
  // brak utraty linii bledu przy powtorzeniach: pierwsza kopia zostaje
  const r5 = T.trimText([...Array.from({ length: 200 }, () => 'ERROR: connection refused to db'), 'koniec'].join('\n'));
  t('blad powtorzony: jedna kopia zostaje z licznikiem', r5.text.includes('ERROR: connection refused to db') && r5.text.includes('(powtórzone 200 razy)'));
  void small;
}
// enable
{
  const text = Array.from({ length: 400 }, () => 'same line again and again').join('\n');
  const r = T.trimText(text, { enable: { repeat: false } });
  eq('wylaczony krok repeat', r.applied, false);
}
console.log(`jev-trim: ${ok} OK, ${bad} NIE`);
process.exit(bad ? 1 : 0);
