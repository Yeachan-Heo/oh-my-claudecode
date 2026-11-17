// Secret-looking path check for the pointer expansion of the PreToolUse hook (scripts/pre-tool-enforcer.mjs).
//
// pointerSecretPath(path) is true for a canonical path (the realpath of the file a prompt names) that points
// at something secret: SSH keys, credential and token files, env files, key stores. The pointer expansion
// sends the head of the file to the Jev endpoint, so the check refuses a path that looks secret even when the
// file would be harmless. Two lists are combined, so the check is never narrower than either:
//   - the patterns of the original expansion (every file in a .ssh directory, .env and .env.* files, and so on);
//   - the broader secret path patterns below, tested on the path as it is and on the path without quotes
//     and backslashes (so "/home/u/.s"sh" or a doubled backslash cannot hide a name).
// Entries specific to one machine (a vault directory, a key file of a tool) are not built in: they are the
// OMC_JEV_POINTER_EXPAND_SECRET_DIRS list read by the hook.

// Character classes shared by the patterns. A token ends at whitespace, a quote or a shell delimiter;
// a name additionally ends at a slash; a boundary is the start of the text or a separator before a name.
const SECRET_TOKEN_CHAR = String.raw`[^\s"'\x60;|&<>(),:\]}]`
const SECRET_NAME_CHAR = String.raw`[^\s"'\x60\\/;|&<>(),:\]}]`
const SECRET_BOUNDARY = String.raw`(?:^|[\\/\s"'\x60=:(;|&,<>])`
const SECRET_END = `(?!${SECRET_TOKEN_CHAR})`
// A file in a .ssh directory is secret unless it is known_hosts*, authorized_keys*, config, config.d/,
// environment, rc or a *.pub file (the .pub test reads at most 255 characters ahead, a longer token
// counts as a key: fail closed).
const SECRET_SSH_FILE = `(?!known_hosts|authorized_keys|(?:config|environment|rc)${SECRET_END}|config\\.d[\\\\/])(?!${SECRET_TOKEN_CHAR}{0,255}\\.pub${SECRET_END})${SECRET_TOKEN_CHAR}+`
// Every repetition below is bounded, so a long path cannot cause quadratic backtracking.
const SECRET_PATH = new RegExp([
  // The .ssh directory and the files in it (also as the tail of a name: backup.ssh/, not self.ssh).
  `${SECRET_BOUNDARY}\\.ssh${SECRET_END}|\\.ssh[\\\\/]+(?:${SECRET_SSH_FILE})?${SECRET_END}`,
  // Host keys of sshd (never the .pub file).
  String.raw`ssh_host_[^\s"'\\/]{0,64}_key(?![a-z0-9_.-])`,
  // A private key outside .ssh with any ending (id_rsa.bak, id_rsa2) and a prefix set off by a non-alphanumeric
  // character (old_id_rsa, *id_rsa); not valid_rsa_signature, not *.pub.
  `(?:^|[^a-z0-9])id_(?:rsa|dsa|ecdsa|ed25519)(?![a-z])(?!${SECRET_TOKEN_CHAR}{0,255}\\.pub${SECRET_END})`,
  // Credential stores of git, the GitHub CLI (also its Windows folder name) and Claude Code.
  String.raw`\.git-credentials(?![a-z0-9_-])`,
  `${SECRET_BOUNDARY}gh[\\\\/]+hosts\\.ya?ml\\b|github cli[\\\\/]+hosts\\.ya?ml\\b`,
  String.raw`\.credentials\.json\b`,
  // .env, .env.local, .env.production (not .env.example, .sample, .template, .dist, .default(s), .tpl),
  // .envrc, a named env file (prod.env, secrets.env, backup.env.bak) and any *.env after a path separator;
  // a bare identifier such as ctx.env or python3.env is code, not a file.
  `${SECRET_BOUNDARY}\\.env(?:\\.(?!(?:example|sample|template|dist|defaults?|tpl)(?!${SECRET_NAME_CHAR}))${SECRET_NAME_CHAR}{1,255})?${SECRET_END}`,
  `${SECRET_BOUNDARY}\\.envrc${SECRET_END}`,
  `(?:(?:prod|production|dev|development|staging|stage|test|local|secrets?|private|credentials?|app|docker|db|database|api|backup|bak|copy|old|orig|save)\\d{0,9}|[-_]\\d{0,9}|(?:^|[^a-z0-9])\\d{1,9})\\.env(?:\\.(?!(?:example|sample|template|dist|defaults?|tpl)(?!${SECRET_NAME_CHAR}))${SECRET_NAME_CHAR}{1,255})?${SECRET_END}`,
  `[\\\\/]${SECRET_NAME_CHAR}{1,120}\\.env${SECRET_END}`,
  // Tool credential files: rclone, .netrc (_netrc on Windows), .pgpass, .npmrc, AWS, Docker, GnuPG,
  // /etc/shadow, .pypirc and kubeconfig; a copy keeps the name with a prefix or an ending (.netrc.bak, x.pgpass).
  String.raw`rclone\.conf\b`,
  String.raw`[._]netrc(?![a-z])`,
  String.raw`\.pgpass(?![a-z])|pgpass\.conf\b`,
  String.raw`\.npmrc(?![a-z])`,
  String.raw`\.aws[\\/]+credentials\b`,
  String.raw`\.docker[\\/]+config\.json\b`,
  `\\.gnupg(?![a-z0-9_-])|(?:[\\\\/]|${SECRET_BOUNDARY})gnupg[\\\\/]`,
  String.raw`[\\/]etc[\\/]+g?shadow\b`,
  String.raw`\.pypirc(?![a-z])|\.kube[\\/]+config\b`,
  // OAuth token files (token.json, google_token_x.json; not tokenizer.json), service account and client
  // secret files, and key stores (*.pem, *.p12, *.pfx, *.jks, *.keystore, *.kdbx, *.ppk); a *.key file only
  // after a path separator or with a key-like name, because obj.key is code.
  `token(?!iz)${SECRET_NAME_CHAR}{0,80}\\.json\\b`,
  `${SECRET_BOUNDARY}(?:sa-key|service[-_]?account${SECRET_NAME_CHAR}{0,80}|client_secret${SECRET_NAME_CHAR}{0,80}|credentials)\\.json\\b`,
  `\\.(?:pem|p12|pfx|jks|keystore|kdbx|ppk)${SECRET_END}`,
  `(?:[\\\\/]${SECRET_NAME_CHAR}{1,120}|${SECRET_BOUNDARY}(?:priv|private|server|client|tls|ssl|signing|id)${SECRET_NAME_CHAR}{0,80})\\.key${SECRET_END}`,
].join('|'), 'i')

// The pattern of the original pointer expansion, kept so this check is never narrower than it was.
const POINTER_EXPAND_SECRET_PATH_RE = /(?:^|[\\/])\.ssh[\\/]|(?:^|[\\/])\.env(?:\.[^\\/]*)?$|(?:^|[\\/])\.git-credentials$|(?:^|[\\/])\.aws[\\/]credentials$|(?:^|[\\/])\.config[\\/]gh[\\/]hosts\.ya?ml$|(?:^|[\\/])\.credentials\.json$|(?:^|[\\/])id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub$)/i;

export function pointerSecretPath(path) {
  const text = String(path ?? '');
  if (POINTER_EXPAND_SECRET_PATH_RE.test(text) || SECRET_PATH.test(text)) return true;
  return /["'\\]/.test(text) && SECRET_PATH.test(text.replace(/["'\\]/g, ''));
}
