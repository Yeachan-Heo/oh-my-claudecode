/**
 * The user's own private paths (OMC_JEV_COMPACT_PRIVATE_PATHS, comma separated) in what the Jev points send and
 * log; the compaction module (hooks/jev-compaction.mjs) reads the same key for its own text. A listed path and
 * what is under it becomes PRIVATE_PATH_MARKER; without a usable entry nothing changes.
 *
 * A path is read in any letter case, a run of slashes and backslashes of any length is one separator, and a leading
 * ~/ also stands for the home directory. A separator may also be percent-encoded (%2F, %5C, encoded once, twice or
 * three times) or written as a JSON or JavaScript escape (a \u or \x escape of / or \, after up to eight
 * backslashes). A listed path counts only up to the end of a name (not as the start of a longer one, nor before a
 * dot and more of the name); what stands before it is not checked, so a relative entry also counts after a
 * separator ("./name/a"). An entry shorter than three characters without its trailing separators ("/", "C:", "~/")
 * is skipped: it would hide too much. The first 200 entries are read. Only the name of a path is hidden, not what
 * was read from a file under it. Not recognized: any other percent-encoded character, HTML entities, base64,
 * environment variables ($HOME, %USERPROFILE%), the MSYS and WSL forms of a Windows path, "." and ".." segments
 * inside a path and a path written relative to a directory above the listed one.
 */

import { homedir } from 'node:os';

/** What a private path becomes. */
export const PRIVATE_PATH_MARKER = '[private path]';

// How many entries of the list are read: the time of the mask grows with their number.
const MAX_ENTRIES = 200;

// The home directories a leading ~ stands for; a system that cannot tell one adds none.
const homeDirectories = (env) => {
  let own;
  try { own = homedir(); } catch { own = undefined; }
  return [own, env.USERPROFILE || env.HOME].filter(Boolean);
};

// A separator written another way than "/": a JSON or JavaScript escape, a run of backslashes or a percent encoding.
// The escape comes first, as it starts with backslashes, and they are bounded, so the scan is linear. There is no
// repetition over the alternatives: a long run of separators cannot exhaust the stack of the expression.
const WRITTEN_SEPARATOR = /\\{1,8}(?:u00|x)(?:2f|5c)|\\+|%(?:25){0,2}(?:2f|5c)/gi;
// The text with each of them as slashes of the same length: a match has the same place in both.
const flatten = (text) => text.replace(WRITTEN_SEPARATOR, (separator) => '/'.repeat(separator.length));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A path as the mask compares it: every separator a single "/", none at the end.
const normalize = (path) => flatten(path).replace(/\/+/g, '/').replace(/\/$/, '');

/**
 * A function that returns its text with the private paths of this environment replaced, or undefined when the
 * environment lists none. A marker that is already in the text stays as it is.
 */
export function privatePathMask(env) {
  const forms = String(env.OMC_JEV_COMPACT_PRIVATE_PATHS ?? '')
    .split(',')
    .slice(0, MAX_ENTRIES)
    .map((entry) => normalize(entry.trim()))
    // Only an entry with a name after "~/" stands for a home directory: "~" and "~/" are short entries, skipped below.
    .flatMap((entry) => (entry.startsWith('~/') ? [entry, ...homeDirectories(env).map((home) => normalize(home + entry.slice(1)))] : [entry]))
    .filter((form) => form.length >= 3);
  if (forms.length === 0) return undefined;
  const sources = [...new Set(forms)].map((form) => {
    const body = form.split('/').map(escapeRegExp).join('/+');
    // "/..." starts at the first separator of a run only, so the scan of a long run is linear; any other entry may
    // follow one ("./name", "file:///C:/...").
    return form.startsWith('/') ? `(?<!/)${body}` : body;
  });
  // The path, what is under it to the end of the token, and never a part of a longer name.
  const listed = new RegExp(
    `(?:${sources.join('|')})(?:/[^\\s"'\\x60;|&<>(),]*)?(?![\\p{L}\\p{N}_-]|\\.{1,8}[\\p{L}\\p{N}_-])`,
    'giu',
  );
  const hide = (text) => {
    let out = '';
    let done = 0;
    for (const match of flatten(text).matchAll(listed)) {
      out += text.slice(done, match.index) + PRIVATE_PATH_MARKER;
      done = match.index + match[0].length;
    }
    return out + text.slice(done);
  };
  return (text) => text.split(PRIVATE_PATH_MARKER).map(hide).join(PRIVATE_PATH_MARKER);
}
