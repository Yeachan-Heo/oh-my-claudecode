/**
 * The secret-looking path check of the pointer expansion (scripts/lib/jev-pointer-secret-path.mjs).
 * Every rule has a path that must be refused and a harmless near miss that must pass.
 */
import { describe, expect, it } from 'vitest';

import { pointerSecretPath } from '../../scripts/lib/jev-pointer-secret-path.mjs';

// [rule, a path that must be refused, a harmless path that must pass]
const RULES = [
  ['a file in a .ssh directory', '/home/u/.ssh/notes.md', '/home/u/.sshuttle/notes.md'],
  ['an sshd host key', '/etc/ssh/ssh_host_ed25519_key', '/etc/ssh/ssh_host_ed25519_key.pub'],
  ['a copy of a private key', '/home/u/keys/id_rsa.bak', '/home/u/keys/id_rsa.pub'],
  ['a private key with a prefix', '/home/u/keys/old_id_rsa', '/home/u/valid_rsa_signature.md'],
  ['a git credentials file copy', '/home/u/.git-credentials.bak', '/home/u/git-credentials.md'],
  ['the GitHub CLI hosts file', '/home/u/.config/gh/hosts.yml', '/home/u/.config/gh/README.md'],
  ['the GitHub CLI hosts file on Windows', 'C:\\Users\\u\\AppData\\Roaming\\GitHub CLI\\hosts.yml', 'C:\\Users\\u\\GitHub CLI\\notes.md'],
  ['a credentials.json file', '/home/u/proj/credentials.json', '/home/u/proj/credentials.md'],
  ['a Claude Code credentials file', '/home/u/.claude/.credentials.json', '/home/u/.claude/credentials-notes.md'],
  ['an env file with a suffix', '/p/.env.md', '/p/environment.md'],
  ['an envrc file', '/p/.envrc', '/p/envrc.md'],
  ['a named env file', '/p/prod.env', '/p/ctx.env.md'],
  ['an env file with a prefix', '/p/backup.env.bak', '/p/environment-notes.md'],
  ['an rclone config', '/home/u/.config/rclone/rclone.conf', '/home/u/.config/rclone/README.md'],
  ['a netrc file', '/home/u/.netrc', '/home/u/netrc-notes.md'],
  ['a netrc file on Windows', 'C:\\Users\\u\\_netrc', 'C:\\Users\\u\\netrc-notes.md'],
  ['a pgpass file', '/home/u/.pgpass', '/home/u/pgpass-notes.md'],
  ['a pgpass file on Windows', 'C:\\Users\\u\\AppData\\postgresql\\pgpass.conf', 'C:\\Users\\u\\AppData\\postgresql\\notes.md'],
  ['an npmrc file', '/home/u/.npmrc', '/home/u/npmrc.md'],
  ['the AWS credentials file', '/home/u/.aws/credentials', '/home/u/.aws/notes.md'],
  ['the Docker config file', '/home/u/.docker/config.json', '/home/u/.docker/notes.md'],
  ['a GnuPG directory', '/home/u/.gnupg/notes.md', '/home/u/gnupg-notes.md'],
  ['a GnuPG directory without a dot', '/home/u/gnupg/notes.md', '/home/u/gnupgx/notes.md'],
  ['/etc/shadow', '/etc/shadow', '/etc/shadowed.md'],
  ['/etc/gshadow', '/etc/gshadow', '/etc/gshadowed.md'],
  ['a pypirc file', '/home/u/.pypirc', '/home/u/pypirc.md'],
  ['a kubeconfig', '/home/u/.kube/config', '/home/u/.kube/notes.md'],
  ['an OAuth token file', '/p/token.json', '/p/tokenizer.json'],
  ['an OAuth token file with a name', '/p/google_token_gmail.json', '/p/google_notes.json'],
  ['a client secret file', '/p/client_secret_123.json', '/p/client.json'],
  ['a service account file', '/p/service-account-prod.json', '/p/service.json'],
  ['a service account key file', '/p/sa-key.json', '/p/sa-notes.json'],
  ['a PEM key store', '/p/server.pem', '/p/pemfile.md'],
  ['a PKCS#12 key store', '/p/cert.p12', '/p/p12-notes.md'],
  ['a Java key store', '/p/app.jks', '/p/jks-notes.md'],
  ['a KeePass database', '/p/passwords.kdbx', '/p/kdbx-notes.md'],
  ['a *.key file after a separator', '/p/signing.key', '/p/keyboard.md'],
  ['a file name that hides a secret name behind quotes', '/home/u/.s"sh/notes.md', '/home/u/it"s notes.md'],
  ['a backslash that hides a secret name', '/home/u/.ss\\h/notes.md', '/home/u/ss\\h/notes.md'],
];

describe('pointerSecretPath', () => {
  for (const [rule, refused, harmless] of RULES) {
    it(`${rule}: the secret path is refused and the harmless path passes`, () => {
      expect(pointerSecretPath(refused), refused).toBe(true);
      expect(pointerSecretPath(harmless), harmless).toBe(false);
    });
  }

  it('keeps the original refusals that are stricter than the broader patterns', () => {
    expect(pointerSecretPath('/home/u/.ssh/known_hosts')).toBe(true);
    expect(pointerSecretPath('/home/u/.ssh/config')).toBe(true);
    expect(pointerSecretPath('/p/.env.example')).toBe(true);
  });

  it('passes an ordinary Markdown path', () => {
    for (const path of ['/home/u/proj/docs/brief.md', '/tmp/briefs/plan.md', 'C:\\Users\\u\\proj\\brief.md']) {
      expect(pointerSecretPath(path), path).toBe(false);
    }
  });

  it('treats a missing value as no secret path', () => {
    expect(pointerSecretPath(undefined)).toBe(false);
    expect(pointerSecretPath('')).toBe(false);
  });
});
