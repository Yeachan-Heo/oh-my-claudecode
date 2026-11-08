import { decodeAnsiCQuote, findNestedSubstitutions } from "./substitution-parser.js";
import { parseXargsOption } from "./wrapper-parser.js";
const PROTECTED_BRANCH_NAME = /^(?:main|master|develop|release(?:\/[\w./-]+)?|production(?:\/[\w./-]+)?)$/;
const PROTECTED_BRANCH_SAMPLES = ["main", "master", "develop", "release/example", "production/example"];
const COMMAND_WORD = /^[A-Za-z0-9_./+:@~^=${}\-*$]+$/;
const GIT_GLOBAL_VALUE_OPTION = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env)$/;
const PUSH_OPTION_VALUE = /^(?:-o|--push-option|--receive-pack|--exec|--recurse-submodules)$/;
const PUSH_REPO_OPTION = /^--repo$/;
const PUSH_INLINE_OPTION_VALUE = /^(?:-o.+|--push-option=.+|--receive-pack=.+|--exec=.+|--recurse-submodules=.+)$/;
const PUSH_INLINE_REPO_OPTION = /^--repo=(.+)$/;
const PUSH_DRY_RUN_FLAG = /^(?:-n|--dry-run)$/;
const PUSH_FORCE_FLAG = /^(?:-f|--force|--force-with-lease|--mirror)$/;
const BUNDLED_SHORT_FLAGS = /^-[a-z0-9]+$/;
const CLEAN_BUNDLED_SHORT_FLAGS = /^-[a-zA-Z0-9]+$/;
const CLEAN_VALUE_OPTION = /^(?:-e|--exclude)$/;
const CLEAN_INLINE_VALUE_OPTION = /^(?:-e.+|--exclude=.+)$/;
const MAX_NESTED_SCAN_DEPTH = 64;
function isValidPushBundle(value: string): boolean {
  return !BUNDLED_SHORT_FLAGS.test(value) || [...value.slice(1)].every((character) => character === "o" || /[46dnfquv]/.test(character));
}
function wildcardCanMatchProtectedBranch(pattern: string): boolean {
  if (!pattern.includes("*")) return false;
  const matcher = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return PROTECTED_BRANCH_SAMPLES.some((branch) => matcher.test(branch));
}
function isValidRmBundle(value: string): boolean {
  return /^-[^-][A-Za-z]*$/.test(value) && [...value.slice(1)].every((character) => /[fFiIrRdv]/.test(character));
}
function isValidCleanBundle(value: string): boolean {
  return !CLEAN_BUNDLED_SHORT_FLAGS.test(value) || [...value.slice(1)].every((character) => character === "e" || /[dfinqxX]/.test(character));
}
function bundledCleanHasFlag(value: string, wanted: string): boolean {
  return [...value.slice(1)].find((character) => character === "e" || character === wanted) === wanted;
}
function isPushForceFlag(flag: string): boolean {
  if (PUSH_FORCE_FLAG.test(flag)) return true;
  if (/^--force(?:-with-lease)?=/.test(flag)) return true;
  return BUNDLED_SHORT_FLAGS.test(flag) && bundledPushHasFlag(flag, "f");
}
function isPushDryRunFlag(flag: string): boolean {
  if (PUSH_DRY_RUN_FLAG.test(flag)) return true;
  return BUNDLED_SHORT_FLAGS.test(flag) && bundledPushHasFlag(flag, "n");
}
function bundledPushHasFlag(flag: string, wanted: string): boolean {
  return [...flag.slice(1)].find((character) => character === "o" || character === wanted) === wanted;
}
const CLAUSE_CONNECTOR = /^(?:then|and|but|also|after|before|while|because|so|which|plus)$/i;
interface ParsedPush {
  flags: CollectedMatch[];
  repo: string | null;
  refspecs: CollectedMatch[];
}
export interface CollectedMatch {
  snippet: string;
  index: number;
}
export interface CommandToken {
  value: string;
  index: number;
  quoted: boolean;
  raw: string;
}
function isEscapedByOddBackslashes(text: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}
function normalizeCommandToken(token: string): string {
  let value = token.replace(/\r/g, "");
  if (value === "!") return value;
  if (value.startsWith("$'") && value.endsWith("'")) value = decodeAnsiCQuote(value.slice(2, -1));
  value = value.replace(/[.,!?;]+$/, "");
  while (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("`") && value.endsWith("`")))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\([\s'"\\])/g, "$1");
  value = value.replace(/[.,!?;]+$/, "");
  return value;
}
export function tokenizeCommand(segment: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let index = 0;
  while (index < segment.length) {
    while (index < segment.length && /\s/.test(segment[index] ?? "")) index += 1;
    if (index >= segment.length) break;

    const start = index;
    let quote: "'" | '"' | null = null;
    let raw = "";
    while (index < segment.length) {
      const character = segment[index] ?? "";
      if (quote !== null) {
        raw += character;
      if (quote === "'") {
        if (character === "'") quote = null;
      } else if (character === '"' && !isEscapedByOddBackslashes(segment, index)) {
        quote = null;
      }
        index += 1;
        continue;
      }
      if (
        (character === '"' || raw.length === 0 || segment.indexOf(character, index + 1) >= 0) &&
        (character === "'" || character === '"')
      ) {
        quote = character;
        raw += character;
        index += 1;
        continue;
      }
      if (character === "`") {
        index += 1;
        continue;
      }
      if (character === "\\" && index + 1 < segment.length) {
        raw += character + (segment[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (/\s/.test(character)) break;
      raw += character;
      index += 1;
    }
    tokens.push({ value: normalizeCommandToken(raw), index: start, quoted: /['"]/.test(raw), raw });
  }
  return tokens;
}
export function splitCommandClauses(line: string): Array<{ text: string; index: number }> {
  const clauses: Array<{ text: string; index: number }> = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let index = 0;
  while (index < line.length) {
    const character = line[index] ?? "";
    if (quote !== null) {
      if (quote === "'") {
        if (character === "'") quote = null;
      } else if (character === '"' && !isEscapedByOddBackslashes(line, index)) {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (character === "\\" && index + 1 < line.length) {
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "#" && (index === start || /\s/.test(line[index - 1] ?? ""))) {
      if (line.slice(start, index).trim()) clauses.push({ text: line.slice(start, index), index: start });
      return clauses;
    }
    let separatorLength = 0;
    if (character === ";") separatorLength = 1;
    else if (line.startsWith("&&", index) || line.startsWith("||", index)) separatorLength = 2;
    else if (character === "&" || character === "|") separatorLength = 1;
    else if (/\s/.test(character)) {
      const connector = /^\s+(?:then|and|but|however|except|instead)\b/i.exec(line.slice(index));
      if (connector) {
        separatorLength = connector[0].length;
        const after = line[index + separatorLength] ?? "";
        if (after !== "" && !/\s/.test(after)) separatorLength = 0;
      }
    }
    if (separatorLength > 0) {
      clauses.push({ text: line.slice(start, index), index: start });
      index += separatorLength;
      start = index;
      continue;
    }
    index += 1;
  }
  clauses.push({ text: line.slice(start), index: start });
  return clauses;
}

export function findExecutableIndex(tokens: CommandToken[], executable: string): number {
  if (/^(?:echo|printf|print|cat)$/i.test(tokens[0]?.value ?? "")) return -1;
  const caseBodyCommand = tokens.findIndex(
    (token, index) =>
      index > 0 &&
      token.value.endsWith(")") &&
      (tokens[index + 1]?.value === executable || tokens[index + 1]?.value.endsWith(`/${executable}`)),
  );
  if (caseBodyCommand >= 0) return caseBodyCommand + 1;
  const proseCommand = tokens.findIndex(
    (token, index) =>
      index > 0 &&
      /[:;,]$/.test(token.raw) &&
      (tokens[index + 1]?.value === executable || tokens[index + 1]?.value.endsWith(`/${executable}`)),
  );
  if (proseCommand >= 0) return proseCommand + 1;
  const politeRun = tokens.findIndex(
    (token, index) =>
      index > 0 &&
      /^run$/i.test(token.value) &&
      (tokens[index + 1]?.value === executable || tokens[index + 1]?.value.endsWith(`/${executable}`)) &&
      index <= 3 &&
      tokens.slice(0, index).every((prefix) => /^(?:please|kindly|just|now|then)$/i.test(prefix.value)),
  );
  if (politeRun >= 0) return politeRun + 1;
  const reminderCommand = tokens.findIndex(
    (token, index) =>
      token.value.toLowerCase() === "to" &&
      /^(?:forget|hesitate|remember)$/i.test(tokens[index - 1]?.value ?? "") &&
      (tokens[index + 1]?.value === executable || tokens[index + 1]?.value.endsWith(`/${executable}`)),
  );
  if (reminderCommand >= 0) return reminderCommand + 1;

  let index = 0;
  while (/^(?:!|-|\*|>|\d+|[({]|do)$/.test(tokens[index]?.value ?? "") || /^\d*[<>]/.test(tokens[index]?.value ?? "")) index += 1;
  if (
    index > 0 &&
    tokens[index]?.value === "[" &&
    /^(?:\]|x|X)$/.test(tokens[index + 1]?.value ?? "")
  ) {
    index += 2;
  }
  const prefixIndex = index;
  let wrapper = tokens[prefixIndex]?.value.toLowerCase();
  let timeoutDurationConsumed = false;
  let timeoutOptionValuePending = false;
  while (index < tokens.length) {
    const value = tokens[index].value;
    const ungroupedValue = value.replace(/^[({]/, "").replace(/[)};,]+$/, "");
    if (ungroupedValue === executable || ungroupedValue.endsWith(`/${executable}`)) return index;
    if (index === prefixIndex && /^(?:run|sudo|env|command|exec|if|while|until|nohup|timeout|nice|xargs)$/.test(wrapper ?? "")) {
      index += 1;
      continue;
    }
    if (
      index > prefixIndex &&
      /^(?:run|sudo|env|command|exec|if|while|until|nohup|timeout|nice|xargs)$/.test(value.toLowerCase())
    ) {
      wrapper = value.toLowerCase();
      timeoutDurationConsumed = false;
      timeoutOptionValuePending = false;
      index += 1;
      continue;
    }
    if (/^(?:if|while|until)$/.test(wrapper ?? "") && value === "!") {
      index += 1;
      continue;
    }
    if (/^(?:do|then|else)$/.test(value) && /^(?:if|while|until)$/.test(wrapper ?? "")) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index += 1;
      continue;
    }
    if (wrapper === "sudo") {
      if (value === "--") {
        index += 1;
        continue;
      }
      if (/^(?:-u|--user|-g|--group|-C|-D|--chdir|-R|--chroot|-T|--command-timeout|-p|--prompt|-r|--role|-t|--type)$/.test(value)) {
        index += 2;
        continue;
      }
      if (/^-[A-Za-z]+$/.test(value) || /^--[\w-]+$/.test(value)) {
        index += 1;
        continue;
      }
    }
    if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index += 1;
      continue;
    }
    if (wrapper === "env") {
      if (value === "--" || value === "-i" || value === "--ignore-environment") {
        index += 1;
        continue;
      }
      if (value === "-u" || value === "--unset") {
        index += 2;
        continue;
      }
      if (value.startsWith("--unset=")) {
        index += 1;
        continue;
      }
      if (value === "-C" || value === "--chdir") {
        index += 2;
        continue;
      }
      if (value.startsWith("--chdir=")) {
        index += 1;
        continue;
      }
      if (value.startsWith("-")) {
        index += 1;
        continue;
      }
    }
    if (wrapper === "nohup") {
      if (/^(?:-h|--help|-V|--version)$/.test(value)) return -1;
      if (value === "--" || value.startsWith("-")) {
        index += 1;
        continue;
      }
    }
    if (wrapper === "nice") {
      if (value === "-n" || value === "--adjustment") {
        index += 2;
        continue;
      }
      if (value.startsWith("--adjustment=") || value.startsWith("-n")) {
        index += 1;
        continue;
      }
    }
    if (wrapper === "command" && /^-[Vv]$/.test(value)) return -1;
    if (wrapper === "command" && /^-p$/.test(value)) {
      index += 1;
      continue;
    }
    if (wrapper === "exec") {
      if (value === "-a") {
        index += 2;
        continue;
      }
      if (value === "-c" || value === "-l") {
        index += 1;
        continue;
      }
    }
    if (wrapper === "timeout") {
      if (/^(?:-h|--help|-V|--version)$/.test(value)) return -1;
      if (timeoutOptionValuePending) {
        timeoutOptionValuePending = false;
        index += 1;
        continue;
      }
      if (value.startsWith("-")) {
        if (/^(?:-k|--kill-after|-s|--signal)$/.test(value)) timeoutOptionValuePending = true;
        index += 1;
        continue;
      }
      if (!timeoutDurationConsumed) {
        timeoutDurationConsumed = true;
        index += 1;
        continue;
      }
      wrapper = "";
      continue;
    }
    if (wrapper === "xargs") {
      const option = parseXargsOption(value);
      if (option === "terminal") return -1;
      if (option !== null) {
        index += option;
        continue;
      }
      wrapper = "";
      continue;
    }
    return -1;
  }
  return -1;
}

function nestedShellCommands(line: string): Array<{ text: string; index: number }> {
  const nested: Array<{ text: string; index: number }> = [];
  for (const clause of splitCommandClauses(line)) {
    const tokens = tokenizeCommand(clause.text);
    const shellIndex = ["bash", "sh", "dash", "zsh", "ksh"]
      .map((shell) => findExecutableIndex(tokens, shell))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;
    const envIndex = findExecutableIndex(tokens, "env");
    if (envIndex >= 0) {
      const splitIndex = tokens.findIndex(
        (token, index) => index > envIndex && (token.value === "-S" || token.value === "--split-string"),
      );
      const splitToken = splitIndex >= 0 ? tokens[splitIndex + 1] : undefined;
      if (splitToken?.quoted) nested.push({ text: splitToken.value, index: clause.index + splitToken.index });
      const inlineSplit = tokens.find(
        (token, index) => index > envIndex && token.value.startsWith("--split-string="),
      );
      if (inlineSplit) {
        nested.push({
          text: normalizeCommandToken(inlineSplit.value.slice("--split-string=".length)),
          index: clause.index + inlineSplit.index,
        });
      }
      const attachedSplit = tokens.find(
        (token, index) => index > envIndex && token.value.startsWith("-S") && token.value.length > 2,
      );
      if (attachedSplit) {
        nested.push({
          text: normalizeCommandToken(attachedSplit.value.slice(2)),
          index: clause.index + attachedSplit.index + 2,
        });
      }
    }
    const evalIndex = findExecutableIndex(tokens, "eval");
    if (evalIndex >= 0) {
      const bodyTokens = tokens.slice(evalIndex + 1).filter((token) => token.quoted);
      const body = bodyTokens.map((token) => token.value).join(" ");
      if (body && bodyTokens[0]) {
        nested.push({ text: body, index: clause.index + bodyTokens[0].index });
      }
    }
    if (shellIndex < 0) continue;
    let commandIndex = -1;
    for (let index = shellIndex + 1; index < tokens.length; index += 1) {
      const value = tokens[index].value;
      if (value === "--") break;
      if (/^(?:--rcfile|--init-file|-O|-o)$/.test(value)) {
        index += 1;
        continue;
      }
      if (/^(?:--rcfile|--init-file|-O|-o)=/.test(value) || /^-[Oo].+/.test(value)) continue;
      if (value === "-c" || value === "--command" || /^-[^-]*c/.test(value)) {
        commandIndex = index;
        break;
      }
      if (!value.startsWith("-")) break;
    }
    let commandTokenIndex = commandIndex + 1;
    if (commandIndex >= 0 && tokens[commandTokenIndex]?.value === "--") commandTokenIndex += 1;
    const command = commandIndex >= 0 ? tokens[commandTokenIndex] : undefined;
    if (command && (command.quoted || command.raw !== command.value)) {
      nested.push({ text: command.value, index: clause.index + command.index });
    }
  }
  return nested;
}

function nestedShellSubstitutions(line: string): Array<{ text: string; index: number }> {
  return findNestedSubstitutions(splitCommandClauses(line));
}

function parsePushCommand(segment: string): ParsedPush | null {
  const tokens = tokenizeCommand(segment);
  const gitIndex = findExecutableIndex(tokens, "git");
  if (gitIndex < 0) return null;

  let index = gitIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index].value;
    index += 1;
    if (token === "push") break;
    if (
      token === "--" ||
      /^(?:-h|--help|-v|--version|--html-path|--man-path|--info-path)$/.test(token)
    ) return null;
    if (GIT_GLOBAL_VALUE_OPTION.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return null;
  }
  if (index > tokens.length || tokens[index - 1]?.value !== "push") return null;

  const parsed: ParsedPush = { flags: [], repo: null, refspecs: [] };
  let i = index;
  while (i < tokens.length) {
    const token = tokens[i];
    const value = token.value;
    i += 1;
    if (/^(?:-h|--help|--version)$/.test(value)) return null;
    if (value.length === 0 || (!COMMAND_WORD.test(value) && !token.quoted)) break; // prose begins here
    if (value.startsWith("-")) {
      if (!isValidPushBundle(value)) return null;
      if (PUSH_REPO_OPTION.test(value)) {
        const repoToken = tokens[i];
        if (repoToken && parsed.repo === null) parsed.repo = repoToken.value;
        i += 1;
      } else if (PUSH_INLINE_REPO_OPTION.test(value)) {
        if (parsed.repo === null) parsed.repo = value.slice("--repo=".length);
      } else if (PUSH_OPTION_VALUE.test(value)) {
        if (!tokens[i]) return null;
        i += 1; // consume the option value
      } else if (PUSH_INLINE_OPTION_VALUE.test(value)) {
        continue;
      } else {
        parsed.flags.push({ snippet: value, index: token.index });
      }
      continue;
    }
    if (CLAUSE_CONNECTOR.test(value)) break; // prose begins here
    if (parsed.repo === null) parsed.repo = value;
    else parsed.refspecs.push({ snippet: value, index: token.index });
  }
  return parsed;
}
function isPushDryRun(parsed: ParsedPush): boolean {
  let dryRun = false;
  for (const flag of parsed.flags) {
    if (flag.snippet === "--no-dry-run") dryRun = false;
    else if (isPushDryRunFlag(flag.snippet)) dryRun = true;
  }
  return dryRun;
}
export function addMatch(hits: CollectedMatch[], snippet: string, index: number): void {
  if (snippet) hits.push({ snippet, index });
}
function collectPushForceOps(line: string): CollectedMatch[] {
  const hits: CollectedMatch[] = [];
  for (const clause of splitCommandClauses(line)) {
    const parsed = parsePushCommand(clause.text);
    if (!parsed || isPushDryRun(parsed)) continue;
    let forceSnippet: CollectedMatch | null = null;
    let leaseSnippet: CollectedMatch | null = null;
    let mirrorSnippet: CollectedMatch | null = null;
    for (const flag of parsed.flags) {
      const match = { snippet: flag.snippet, index: clause.index + flag.index };
      if (flag.snippet === "--no-force") forceSnippet = null;
      else if (flag.snippet === "--no-force-with-lease") leaseSnippet = null;
      else if (flag.snippet === "--no-mirror") mirrorSnippet = null;
      else if (isPushForceFlag(flag.snippet)) {
        if (/^--force-with-lease(?:=|$)/.test(flag.snippet)) leaseSnippet = match;
        else if (flag.snippet === "--mirror") mirrorSnippet = match;
        else forceSnippet = match;
      }
    }
    if (forceSnippet) addMatch(hits, forceSnippet.snippet, forceSnippet.index);
    if (leaseSnippet) addMatch(hits, leaseSnippet.snippet, leaseSnippet.index);
    if (mirrorSnippet) addMatch(hits, mirrorSnippet.snippet, mirrorSnippet.index);
    for (const refspec of parsed.refspecs) {
      if (refspec.snippet.startsWith("+")) {
        addMatch(hits, refspec.snippet, clause.index + refspec.index);
        break;
      }
    }
  }
  return hits;
}

function collectRmForceOps(line: string): CollectedMatch[] {
  const hits: CollectedMatch[] = [];
  for (const clause of splitCommandClauses(line)) {
    const tokens = tokenizeCommand(clause.text);
    const rmIndex = findExecutableIndex(tokens, "rm");
    if (rmIndex < 0) continue;
    const rm = tokens[rmIndex];
    const xargsIndex = findExecutableIndex(tokens, "xargs");
    const receivesXargsOperands = xargsIndex >= 0 && xargsIndex < rmIndex;
    let destructive = false;
    let help = false;
    let hasOperand = false;
    let invalid = false;
    let operandsOnly = false;
    const optionTokens: CommandToken[] = [];
    for (const token of tokens.slice(rmIndex + 1)) {
      if (token.value === "--") {
        operandsOnly = true;
        continue;
      }
      if (token.value === "rm" || token.value.endsWith("/rm")) break;
      if (operandsOnly) {
        hasOperand = true;
        continue;
      }
      if (/^(?:-h|--help|--version)$/.test(token.value)) {
        help = true;
        break;
      }
      if (token.value === "--recursive" || token.value === "--force") {
        optionTokens.push(token);
        destructive = true;
      } else if (/^--(?:preserve-root|no-preserve-root|one-file-system)(?:=.+)?$/.test(token.value)) {
        continue;
      } else if (/^--(?:dir|verbose|interactive|context)(?:=.+)?$/.test(token.value)) {
        continue;
      } else if (token.value.startsWith("--")) {
        invalid = true;
        break;
      } else if (/^-[^-][A-Za-z]*$/.test(token.value)) {
        if (!isValidRmBundle(token.value)) {
          invalid = true;
          break;
        }
        const options = token.value.slice(1).toLowerCase();
        if (options.includes("r") || options.includes("f")) {
          optionTokens.push(token);
          destructive = true;
        }
      } else {
        hasOperand = true;
      }
    }
    if (destructive && (hasOperand || receivesXargsOperands) && !help && !invalid) {
      addMatch(
        hits,
        `rm ${optionTokens.map((token) => token.value).join(" ")}`,
        clause.index + rm.index,
      );
    }
  }
  return hits;
}
interface GitSubcommand {
  gitIndex: number;
  commandIndex: number;
  cleanRequireForceDisabled: boolean;
}

function findGitSubcommand(tokens: CommandToken[], command: string): GitSubcommand | null {
  const gitIndex = findExecutableIndex(tokens, "git");
  if (gitIndex < 0) return null;
  const commandEnv: Record<string, string> = {};
  for (const token of tokens.slice(0, gitIndex)) {
    const assignment = token.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assignment) commandEnv[assignment[1]] = assignment[2];
  }

  let index = gitIndex + 1;
  let cleanRequireForceDisabled = false;
  while (index < tokens.length) {
    const value = tokens[index].value;
    if (value === command) return { gitIndex, commandIndex: index, cleanRequireForceDisabled };
    if (
      value === "--" ||
      /^(?:-h|--help|-v|--version|--html-path|--man-path|--info-path)$/.test(value)
    ) return null;
    const inlineConfig = value.match(/^--config-env=([^=]+)=(.+)$/i);
    if (
      inlineConfig &&
      inlineConfig[1].toLowerCase() === "clean.requireforce"
    ) {
      cleanRequireForceDisabled = isFalseGitBoolean(commandEnv[inlineConfig[2]] ?? process.env[inlineConfig[2]]);
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTION.test(value)) {
      const config = tokens[index + 1]?.value.match(/^clean\.requireforce=(.+)$/i);
      if (value === "-c" && config) {
        cleanRequireForceDisabled = isFalseGitBoolean(config[1]);
      } else if (value === "--config-env" && config) {
        cleanRequireForceDisabled = isFalseGitBoolean(commandEnv[config[1]] ?? process.env[config[1]]);
      }
      index += 2;
      continue;
    }
    if (value.startsWith("-")) {
      index += 1;
      continue;
    }
    return null;
  }
  return null;
}
function isFalseGitBoolean(value: string | undefined): boolean {
  return /^(?:false|0|no|off)$/i.test(value ?? "");
}
function collectGitForceOps(line: string): CollectedMatch[] {
  const hits: CollectedMatch[] = [];
  for (const clause of splitCommandClauses(line)) {
    const tokens = tokenizeCommand(clause.text);
    const reset = findGitSubcommand(tokens, "reset");
    if (reset) {
      const resetArgs = tokens.slice(reset.commandIndex + 1);
      const terminator = resetArgs.findIndex((token) => token.value === "--");
      const resetOptions = terminator < 0 ? resetArgs : resetArgs.slice(0, terminator);
      if (resetOptions.some((token) => /^(?:-h|--help|-v|--version)$/.test(token.value))) continue;
      const hard = resetOptions.find((token) => token.value === "--hard");
      const hasPathspec = terminator >= 0 && resetArgs.slice(terminator + 1).length > 0;
      const hardOperands = hard ? resetOptions.filter((token) => token !== hard && !token.value.startsWith("-")) : [];
      if (hard && !hasPathspec && hardOperands.length <= 1) {
        addMatch(hits, "git reset --hard", clause.index + tokens[reset.gitIndex].index);
      }
    }

    const clean = findGitSubcommand(tokens, "clean");
    if (!clean) continue;
    let force = false;
    let dryRun = false;
    let interactive = false;
    let help = false;
    const cleanArgs = tokens.slice(clean.commandIndex + 1);
    for (let index = 0; index < cleanArgs.length; index += 1) {
      const value = cleanArgs[index].value;
      if (value === "--") break;
      if (/^(?:-h|--help|--version)$/.test(value)) {
        help = true;
        break;
      }
      if (value.startsWith("--") && !/^(?:--(?:dry-run|force|interactive|quiet|exclude(?:=.+)?|no-(?:force|dry-run|interactive)))$/.test(value)) {
        help = true;
        break;
      }
      if (CLEAN_BUNDLED_SHORT_FLAGS.test(value) && !isValidCleanBundle(value)) {
        help = true;
        break;
      }
      if (CLEAN_VALUE_OPTION.test(value)) {
        if (index + 1 >= cleanArgs.length) {
          help = true;
          break;
        }
        index += 1;
        continue;
      }
      if (CLEAN_INLINE_VALUE_OPTION.test(value)) continue;
      if (value === "--no-force") force = false;
      else if (value === "--force" || (CLEAN_BUNDLED_SHORT_FLAGS.test(value) && bundledCleanHasFlag(value, "f"))) force = true;
      if (value === "--no-dry-run") dryRun = false;
      else if (value === "--dry-run" || (CLEAN_BUNDLED_SHORT_FLAGS.test(value) && bundledCleanHasFlag(value, "n"))) dryRun = true;
      if (value === "--no-interactive") interactive = false;
      else if (value === "--interactive" || (CLEAN_BUNDLED_SHORT_FLAGS.test(value) && bundledCleanHasFlag(value, "i"))) interactive = true;
    }
    if (!help && !dryRun && (force || interactive || clean.cleanRequireForceDisabled)) {
      addMatch(
        hits,
        clean.cleanRequireForceDisabled && !force ? "git clean (clean.requireForce=false)" : "git clean",
        clause.index + tokens[clean.gitIndex].index,
      );
    }
  }
  return hits;
}
export function collectForceOps(line: string, depth = 0): CollectedMatch[] {
  const hits = [...collectGitForceOps(line), ...collectPushForceOps(line), ...collectRmForceOps(line)];
  if (depth >= MAX_NESTED_SCAN_DEPTH) return hits;
  for (const nested of nestedShellCommands(line)) {
    for (const match of collectForceOps(nested.text, depth + 1)) {
      addMatch(hits, match.snippet, nested.index + match.index);
    }
  }
  for (const nested of nestedShellSubstitutions(line)) {
    for (const match of collectForceOps(nested.text, depth + 1)) {
      addMatch(hits, match.snippet, nested.index + match.index);
    }
  }
  return hits;
}
export function collectProtectedPushDests(line: string, depth = 0): CollectedMatch[] {
  const hits: CollectedMatch[] = [];
  for (const clause of splitCommandClauses(line)) {
    const parsed = parsePushCommand(clause.text);
    if (!parsed || isPushDryRun(parsed)) continue;
    let allBranches: CollectedMatch | null = null;
    for (const flag of parsed.flags) {
      if (flag.snippet === "--no-all" || flag.snippet === "--no-branches") allBranches = null;
      else if (flag.snippet === "--all" || flag.snippet === "--branches") {
        allBranches = flag;
      }
    }
    if (allBranches) addMatch(hits, allBranches.snippet, clause.index + allBranches.index);
    for (let refspecIndex = 0; refspecIndex < parsed.refspecs.length; refspecIndex += 1) {
      const refspec = parsed.refspecs[refspecIndex];
      if (refspec.snippet === "tag" && parsed.refspecs[refspecIndex + 1]) {
        refspecIndex += 1;
        continue;
      }
      const bare = refspec.snippet.replace(/^\+/, "");
      const colon = bare.lastIndexOf(":");
      const source = colon >= 0 ? bare.slice(0, colon) : null;
      const rawDestination = colon >= 0 ? bare.slice(colon + 1) : bare;
      const explicitDestination = rawDestination.startsWith("refs/");
      if (rawDestination.startsWith("refs/tags/") || rawDestination.startsWith("refs/remotes/")) continue;
      if (source?.startsWith("refs/tags/") && !explicitDestination) continue;
      const dest = rawDestination.replace(/^refs\/heads\//, "");
      const wildcard = dest.indexOf("*");
      const broadBranchWildcard =
        dest === "*" ||
        rawDestination === "refs/*" ||
        (wildcard >= 0 && wildcardCanMatchProtectedBranch(dest));
      if (broadBranchWildcard || PROTECTED_BRANCH_NAME.test(dest)) {
        addMatch(hits, refspec.snippet, clause.index + refspec.index);
      }
    }
  }
  if (depth >= MAX_NESTED_SCAN_DEPTH) return hits;
  for (const nested of nestedShellCommands(line)) {
    for (const match of collectProtectedPushDests(nested.text, depth + 1)) {
      addMatch(hits, match.snippet, nested.index + match.index);
    }
  }
  for (const nested of nestedShellSubstitutions(line)) {
    for (const match of collectProtectedPushDests(nested.text, depth + 1)) {
      addMatch(hits, match.snippet, nested.index + match.index);
    }
  }
  return hits;
}

