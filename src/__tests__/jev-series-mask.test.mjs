/**
 * One case or more for each rule of scripts/lib/jev-series-mask.mjs, the mask of a series of traces: the text of the question (cleanForJevLong) and the text of the file
 * (archiveMaskedLong, then maskResidualLines). All values are made up; token shapes are written in two parts.
 */

import { describe, expect, it } from 'vitest';

import { RESIDUAL_SECRET, archiveMaskedLong, cleanForJevLong, maskResidualLines } from '../../scripts/lib/jev-series-mask.mjs';

const fileText = (text) => {
  const masked = archiveMaskedLong(text);
  return masked === undefined ? undefined : maskResidualLines(masked);
};

describe('series mask: a line that names a secret path is replaced whole', () => {
  it.each([
    ['the .ssh directory', 'ls /home/u/.ssh\nnext line', '[line omitted: secret path]\nnext line', undefined],
    ['a file under .ssh', 'cat /home/u/.ssh/config', 'cat /home/u/.ssh/config', undefined],
    ['an ssh host key', 'cat /etc/ssh/ssh_host_ed25519_key', '[line omitted: secret path]', undefined],
    ['a private key file name, not its public half', 'cp id_ed25519 /tmp\ncat id_ed25519.pub', '[line omitted: secret path]\ncat id_ed25519.pub', undefined],
    ['the git credential store', 'cat ~/.git-credentials', '[line omitted: secret path]', undefined],
    ['the gh hosts file', 'cat /home/u/.config/gh/hosts.yml', '[line omitted: secret path]', undefined],
    ['a .credentials.json file', 'cat app/.credentials.json', '[line omitted: secret path]', undefined],
    ['.env and its variants, not the example', 'cat .env\ncat .env.local\ncat .env.example', '[line omitted: secret path]\n[line omitted: secret path]\ncat .env.example', undefined],
    ['.envrc', 'source .envrc', '[line omitted: secret path]', undefined],
    ['an env file named by its stage', 'cat prod.env', '[line omitted: secret path]', undefined],
    ['an env file under a directory', 'cat deploy/service.env', '[line omitted: secret path]', undefined],
    ['rclone.conf', 'cat rclone.conf', '[line omitted: secret path]', undefined],
    ['netrc', 'cat ~/.netrc', '[line omitted: secret path]', undefined],
    ['the postgres password file', 'cat ~/.pgpass\ncat pgpass.conf', '[line omitted: secret path]\n[line omitted: secret path]', undefined],
    ['npmrc', 'cat ~/.npmrc', '[line omitted: secret path]', undefined],
    ['aws credentials', 'cat ~/.aws/credentials', '[line omitted: secret path]', undefined],
    ['docker config', 'cat ~/.docker/config.json', '[line omitted: secret path]', undefined],
    ['the directory of the scorer key', 'ls ~/.config/typesafe', '[line omitted: secret path]', undefined],
    ['the env file of the scorer', 'cat conf/typesafe/env', '[line omitted: secret path]', undefined],
    ['gnupg', 'ls ~/.gnupg\nls /srv/gnupg/keys', '[line omitted: secret path]\n[line omitted: secret path]', undefined],
    ['the shadow file', 'cat /etc/shadow', '[line omitted: secret path]', undefined],
    ['pypirc and kube config', 'cat ~/.pypirc\ncat ~/.kube/config', '[line omitted: secret path]\n[line omitted: secret path]', undefined],
    ['a token file, not a tokenizer', 'cat token.json\ncat tokenizer.json', '[line omitted: secret path]\ncat tokenizer.json', undefined],
    ['service account and client secret files', 'cat sa-key.json\ncat service-account-x.json\ncat client_secret_1.json\ncat credentials.json', '[line omitted: secret path]\n[line omitted: secret path]\n[line omitted: secret path]\n[line omitted: secret path]', undefined],
    ['certificate and key stores', 'cat a.pem\ncat b.p12\ncat c.kdbx', '[line omitted: secret path]\n[line omitted: secret path]\n[line omitted: secret path]', undefined],
    ['a .key file', 'cat certs/server.key\ncat private.key', '[line omitted: secret path]\n[line omitted: secret path]', undefined],
    ['a path split by quotes', 'cat ~/.ss""h/id_x', '[line omitted: secret path]', undefined],
  ])('%s', (_, text, asked, written) => {
    expect(cleanForJevLong(text)).toBe(asked);
    expect(fileText(text)).toBe(written ?? asked);
  });
});

describe('series mask: a value under a secret name', () => {
  it.each([
    ['a JSON key', '{"password":"plainwordvalue","user":"a"}', '{"password":"***","user":"a"}', undefined],
    ['a JSON name and value pair', '[{"name":"API_TOKEN","value":"plainwordvalue"}]', '[{"name":"API_TOKEN","value":"***"}]', undefined],
    ['a SecureString', '{"Type":"SecureString","Value":"plainwordvalue"}', '{"Type":"SecureString","Value":"***"}', undefined],
    ['a one-time code, not a sentence under the same key', '{"code":"AB12-CD34"}\n{"code":"a sentence about the code"}', '{"code":"***"}\n{"code":"a sentence about the code"}', undefined],
    ['a flag and its value in a JSON list', '{"args":["--password","plainwordvalue"]}', '{"args":["--password","***"]}', undefined],
    ['mysql -p in a JSON list', '{"argv":["mysql","-p","plainwordvalue","-pplainwordvalue"]}', '{"argv":["mysql","-p","***","-p***"]}', undefined],
    ['a two-item list of a name and a value', '[["password","plainwordvalue"]]', '[["password","***"]]', undefined],
    ['a secret path as a JSON key', '{"/home/u/.env":1,"b":2}', '{"[line omitted: secret path]":"***","b":2}', undefined],
    ['a pair inside a line of text', 'found {"name":"DB_PASSWORD","value":"plainwordvalue"} there', 'found {"name":"DB_PASSWORD","value":"***"} there', undefined],
    ['a pair with the value first', 'found {"value":"plainwordvalue","name":"dbPassword"} there', 'found {"value":"***","name":"dbPassword"} there', undefined],
    ['a pair with another field between', 'found {"key":"db_password","other":1,"value":"plainwordvalue"} there', 'found {"key":"***","other":1,"value":"***"} there', undefined],
    ['a JSON key inside a line of text', 'found "api_token": "plainwordvalue" there', 'found "api_token": "***" there', undefined],
    ['an object under a secret key inside a line of text', 'found "secret": {"a":"plainwordvalue"} there', 'found "secret": "***" there', undefined],
    ['a code under a code key inside a line of text', 'found "code": "123456" there', 'found "code": "***" there', undefined],
    ['an assignment to a name with TOKEN', 'export SERVICE_TOKEN=plainwordvalue', 'export SERVICE_TOKEN=***', undefined],
    ['a name and a colon', 'client_secret: "plainwordvalue"', 'client_secret: "***"', undefined],
    ['a Polish name and a colon', 'has\u0142o: plainwordvalue', 'has\u0142o: ***', undefined],
  ])('%s', (_, text, asked, written) => {
    expect(cleanForJevLong(text)).toBe(asked);
    expect(fileText(text)).toBe(written ?? asked);
  });
});

describe('series mask: flags, headers, addresses and token shapes', () => {
  it.each([
    ['a password in an address', 'git clone https://user:plainwordvalue@host/repo', 'git clone https://user:***@host/repo', undefined],
    ['an authorization header', 'curl -H "Authorization: Basic plainwordvalue"', 'curl -H "Authorization: Basic ***"', undefined],
    ['a cookie header', 'curl -H "Cookie: sid=plainwordvalue"', 'curl -H "Cookie: ***"', undefined],
    ['a bearer value', 'use bearer plainwordvalue here', 'use bearer *** here', undefined],
    ['curl -u', 'curl -u admin:plainwordvalue host', 'curl -u admin:*** host', undefined],
    ['a long password flag', 'tool --client-secret plainwordvalue run', 'tool --client-secret *** run', undefined],
    ['mysql -p', 'mysql -h db -pplainwordvalue app', 'mysql -h db -p*** app', undefined],
    ['sshpass -p', 'sshpass -p \'plainwordvalue\' ssh host', 'sshpass -p \'***\' ssh host', undefined],
    ['an sk key', 'key sk-ant-' + 'abcdEFabcdEFabcdEFabcdEF', 'key sk-ant-***', undefined],
    ['a GitHub token', 'key ghp_' + 'abcdEFabcdEFabcdEFabcdEF', 'key ghp_***', undefined],
    ['a live key', 'key sk_live_' + 'abcdEFabcdEFabcdEFabcdEF', 'key sk_live_***', undefined],
    ['an AWS key id', 'key AKIA' + 'ABCDABCDABCDABCD', 'key AKIA***', undefined],
    ['a temporary AWS key id', 'key ASIA' + 'ABCDABCDABCDABCD', 'key ASIA***', undefined],
    ['a text of the shape of a temporary AWS key id that is too short', 'key ASIA' + 'ABCDABCDABCD', 'key ASIA' + 'ABCDABCDABCD', undefined],
    ['a gsk_ key shorter than a long run', 'key gsk_' + 'abcdEF12', 'key gsk_***', undefined],
    ['an xai- key shorter than a long run', 'key xai-' + 'abcdEF12', 'key xai-***', undefined],
    ['a gsk_ or xai- prefix with fewer than eight characters', 'key gsk_' + 'abcdEF1 xai-' + 'abcdEF1', 'key gsk_' + 'abcdEF1 xai-' + 'abcdEF1', undefined],
    ['a prefix in the middle of a word', 'key task' + 'gsk_abcdEF12', 'key task' + 'gsk_abcdEF12', undefined],
    ['a gsk_ key behind an underscore', 'run mcp__srv__gsk_' + 'abcdEF12', 'run mcp__srv__gsk_***', undefined],
    ['a temporary AWS key id before an underscore', 'cat ASIA' + 'ABCDABCDABCDABCD_old', 'cat ASIA***_old', undefined],
    ['a long term AWS key id between underscores', 'cat x_AKIA' + 'ABCDABCDABCDABCD_old', 'cat x_AKIA***_old', undefined],
    ['an xai- key behind an escaped tab', 'echo a\\txai-' + 'abcdEF12', 'echo a\\txai-***', undefined],
    ['a gsk_ key behind a percent escape', 'q=a%3Dgsk_' + 'abcdEF12', 'q=a%3Dgsk_***', undefined],
    ['a temporary AWS key id with more characters after it', 'id ASIA' + 'ABCDABCDABCDABCDx', 'id ASIA' + 'ABCDABCDABCDABCDx', undefined],
    ['a JWT', 'key eyJ' + 'abcdEF12abcdEF12.eyJ' + 'abcdEF12abcdEF12.sigabcdEF12abcdEF12', 'key eyJ***', undefined],
    ['a JWT-shaped run with no dot stays', 'key eyJ' + 'abcdEF12', 'key eyJ' + 'abcdEF12', undefined],
    ['a long run of letters and digits', 'key a1B2a1B2a1B2a1B2a1B2a1B2a1B2a1B2a1B2a1B2', 'key ***', undefined],
    ['a long base64 run', 'key aB3+/aB3+/aB3+/aB3+/aB3+/aB3+/aB3+/aB3+/aB3+/aB3+/', 'key ***', undefined],
  ])('%s', (_, text, asked, written) => {
    expect(cleanForJevLong(text)).toBe(asked);
    expect(fileText(text)).toBe(written ?? asked);
  });
});

describe('series mask: a private key block', () => {
  it.each([
    ['a whole block', 'x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----\ny', 'x\n-----BEGIN RSA PRIVATE KEY-----***-----END RSA PRIVATE KEY-----\ny', undefined],
    ['a block with no end', 'x\n-----BEGIN PRIVATE KEY-----\nMIIEabc', 'x\n-----BEGIN PRIVATE KEY-----***', undefined],
  ])('%s', (_, text, asked, written) => {
    expect(cleanForJevLong(text)).toBe(asked);
    expect(fileText(text)).toBe(written ?? asked);
  });
});

describe('series mask: a value named in words', () => {
  it.each([
    ['a value with a letter after a link word', 'the password is Zaq12wsx9.', 'the password is ***.', undefined],
    ['digits after pin', 'the PIN of the phone 482913', 'the PIN of the phone ***', undefined],
    ['digits after password', 'password 55667788', 'password ***', undefined],
    ['digits on the next line after a secret word', 'token\n482913', 'token\n***', undefined],
    ['digits after token on the same line stay', 'token 482913', 'token 482913', undefined],
    ['a word far behind the secret word stays', 'password for the old admin account is Zx9kQ2mP', 'password for the old admin account is Zx9kQ2mP', '*** [line with a possible secret replaced]'],
    ['a Polish secret word', 'has\u0142o to Zaq12wsx9', 'has\u0142o to ***', undefined],
    ['a long word with no digit after a link word, the file only', 'the password is correcthorsebattery now', 'the password is correcthorsebattery now', 'the password is *** now'],
    ['a line where a value still follows a secret word, the file only', 'first\necho secret key value Qw7e8R9t0y\nlast', 'first\necho secret key value Qw7e8R9t0y\nlast', 'first\n*** [line with a possible secret replaced]\nlast'],
  ])('%s', (_, text, asked, written) => {
    expect(cleanForJevLong(text)).toBe(asked);
    expect(fileText(text)).toBe(written ?? asked);
  });
});

describe('series mask: the check of what is left and long texts', () => {
  it('finds a value with a letter and a digit that still follows a secret word, not one that is masked', () => {
    expect(RESIDUAL_SECRET.test('secret key value Qw7e8R9t0y')).toBe(true);
    expect(RESIDUAL_SECRET.test('secret key value ***')).toBe(false);
  });

  const lines = (n) => Array.from({ length: n }, (_, k) => `line ${k} of a long text with nothing to hide`).join('\n');

  it('cuts the middle of a long text for the question and says how much, and keeps it whole in the file', () => {
    const text = lines(6000);
    expect(cleanForJevLong(text)).toBe(text);
    expect(fileText(text)).toBe(text);
  });

  it('masks a value in every part of a text longer than one part', () => {
    const text = `password: firstvalue\n${lines(6000)}\npassword: lastvalue`;
    for (const out of [cleanForJevLong(text), fileText(text)]) {
      expect(out).not.toContain('firstvalue');
      expect(out).not.toContain('lastvalue');
      expect(out).toContain('line 5999 of a long text');
    }
  });

  it('masks a private key block that stands across two parts of a long text', () => {
    const body = Array.from({ length: 700 }, () => 'MIIEmadeupbody').join('\n'); // no rule but the one for key blocks reads these lines
    const text = `${lines(3200)}\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n${lines(2000)}`;
    expect(text.indexOf('BEGIN PRIVATE KEY')).toBeLessThan(150000);
    expect(text.indexOf('END PRIVATE KEY')).toBeGreaterThan(151500);
    for (const out of [cleanForJevLong(text), fileText(text)]) {
      expect(out).not.toContain('MIIEmadeupbody');
      expect(out).toContain('line 1999 of a long text');
    }
  });

  it('gives no file text for one line longer than the mask reads at once', () => {
    expect(archiveMaskedLong('z '.repeat(105000))).toBeUndefined();
  });

  it('gives no file text when masking grows a text past the round limit', () => {
    // Thirty secret-path lines grow by 23 characters each when replaced by the marker, so the
    // text passes the bound between the rounds; the single long line without a newline stops
    // the middle cut from firing on the grown text, so only the cap inside the rounds drops it.
    const text = '.env\n'.repeat(30) + 'x'.repeat(199350);
    expect(text.length).toBe(199500);
    expect(archiveMaskedLong(text)).toBeUndefined();
    expect(fileText(text)).toBeUndefined();
  });

  it('gives no file text when masking does not settle within the allowed rounds', () => {
    // The key "pass" repeats behind scattered colons and a brace, so every round still changes
    // the text. After the three allowed rounds the made-up value is visible, and only the final
    // check (one more mask) sees the change and drops the whole text instead of returning it.
    const text = '"pass":} pass":d": pass":d":' + 'madeup' + 'Value77';
    expect(archiveMaskedLong(text)).toBeUndefined();
    expect(fileText(text)).toBeUndefined();
  });

  it('returns the text when one more mask after the allowed rounds changes nothing', () => {
    // The same shape one value shorter: the three allowed rounds settle the text, so the final
    // check compares equal and the masked text is returned.
    expect(archiveMaskedLong('"pass":} pass":h')).toBe('"pass":"***" pass":"***"');
  });

  it('replaces a line that holds two values behind secret words with one line', () => {
    const text = 'first\nsecret key value Qw7e8R9t0y then secret value Ab3cD4eF2\nlast';
    expect(fileText(text)).toBe('first\n*** [line with a possible secret replaced]\nlast');
  });
});
