import { CHECK_DEADLOCK, type Config } from "../ir.ts";

type ListField = "invariants" | "properties" | "constraints" | "actionConstraints";
type Section = {
  key: string;
  plural?: string;
  field?:
    | ListField
    | "checkDeadlock"
    | "init"
    | "next"
    | "spec"
    | "view"
    | "symmetry"
    | "type"
    | "typeConstraint";
  undefinedNoun?: string;
};
const isListField = (field: Section["field"]): field is ListField =>
  field === "invariants" ||
  field === "properties" ||
  field === "constraints" ||
  field === "actionConstraints";

const SECTIONS = new Map<string, Section>();
for (const section of [
  { key: "CONSTANT", plural: "CONSTANTS" },
  { key: CHECK_DEADLOCK, field: "checkDeadlock" },
  { key: "INIT", field: "init", undefinedNoun: "initial predicate" },
  { key: "NEXT", field: "next", undefinedNoun: "next state action" },
  { key: "SPECIFICATION", field: "spec", undefinedNoun: "name" },
  { key: "VIEW", field: "view", undefinedNoun: "view function" },
  { key: "SYMMETRY", field: "symmetry", undefinedNoun: "symmetry function" },
  { key: "TYPE", field: "type" },
  { key: "TYPE_CONSTRAINT", field: "typeConstraint" },
  { key: "INVARIANT", plural: "INVARIANTS", field: "invariants", undefinedNoun: "invariant" },
  { key: "PROPERTY", plural: "PROPERTIES", field: "properties", undefinedNoun: "property" },
  { key: "CONSTRAINT", plural: "CONSTRAINTS", field: "constraints", undefinedNoun: "constraint" },
  {
    key: "ACTION_CONSTRAINT",
    plural: "ACTION_CONSTRAINTS",
    field: "actionConstraints",
    undefinedNoun: "action constraint",
  },
] satisfies Section[]) {
  SECTIONS.set(section.key, section);
  if (section.plural) SECTIONS.set(section.plural, section);
}
export const NAME = /^\w*[A-Za-z]\w*$/;
const WORD = /\w+/y;
const CONFIG_HOLDS =
  "A config can hold only names, numbers, strings, comments, and the symbols { } ( ) [ ] , = ! <-.";
const shown = (c: string) => {
  const code = c.codePointAt(0) ?? 0;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  if (code < 0x20 || code === 0x7f) return hex;
  return code < 0x7f ? `"${c}"` : `"${c}" (${hex})`;
};

type Token = { image: string; line: number };

function tokenizeConfig(text: string, cannot: (line: number, words: string) => Error) {
  if (text.startsWith("\uFEFF"))
    throw cannot(1, "The file starts with a byte order mark. Save it as UTF-8 without one.");
  const tokens: Token[] = [];
  let line = 1;
  let last = 1;
  let i = 0;
  const skip = (to: number) => {
    for (; i < to; i++) {
      last = line;
      if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] !== "\n")) line++;
    }
  };
  const push = (image: string) => {
    tokens.push({ image, line });
    skip(i + image.length);
  };
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    const start = line;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") skip(i + 1);
    else if (two === "\\*") {
      const end = text.slice(i).search(/[\n\r]/);
      skip(end < 0 ? text.length : i + end);
    } else if (two === "(*") {
      const marks = /\(\*|\*\)/g;
      let depth = 0;
      do {
        marks.lastIndex = i;
        const m = marks.exec(text);
        if (!m) throw cannot(start, "A comment starts here and does not end.");
        depth += m[0] === "(*" ? 1 : -1;
        skip(m.index + 2);
      } while (depth);
    } else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') {
        const ch = text[j];
        if (ch === undefined) throw cannot(start, "A string starts here and does not end.");
        if (ch === "\n" || ch === "\r")
          throw cannot(
            start,
            "A string starts here and does not end on its line. Write \\n for a line break in a string.",
          );
        if (ch === "\0") throw cannot(start, "A string has the character U+0000.");
        if (ch === "\\" && text[j + 1] !== undefined && !'"\\ntrf'.includes(text[j + 1]))
          throw cannot(
            start,
            `A string has a backslash before ${shown(text[j + 1])}. A string can use only the escapes \\" \\\\ \\n \\t \\r \\f.`,
          );
        j += ch === "\\" ? 2 : 1;
      }
      push(text.slice(i, j + 1));
    } else if (/\w/.test(c)) {
      WORD.lastIndex = i;
      const word = WORD.exec(text)?.[0] ?? c;
      if (/^[WS]F_/.test(word))
        throw cannot(
          start,
          `TLC reads ${word.slice(0, 3)} at the start of a word as a TLA+ keyword, so it cannot read ${word} as a name.`,
        );
      if (!/[A-Za-z]/.test(word) && word !== "_") {
        if (/\D/.test(word))
          throw cannot(
            start,
            `TLC splits ${word} into ${word.match(/\d+|_/g)?.join(" ")}, because a name needs a letter.`,
          );
        if (Number(word) > 2147483647)
          throw cannot(start, `TLC cannot read a number above 2147483647, such as ${word}.`);
      }
      push(word);
    } else if (two === "<-") push(two);
    else if (["[]", "]_", "==", "=<", "!!"].includes(two))
      throw cannot(start, `TLC reads ${two} as one TLA+ symbol, and a config cannot hold it.`);
    else if ("{}()[],=!".includes(c)) push(c);
    else {
      const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
      const where = ch > "\x7f" ? " outside a string" : "";
      throw cannot(start, `It cannot read the character ${shown(ch)}${where}. ${CONFIG_HOLDS}`);
    }
  }
  return { tokens, end: last };
}

export function readConfig({ file, text }: { file: string; text: string }): Config {
  const refuse = (line: number, words: string) =>
    new Error(`TLC refuses the config ${file} at line ${line}. ${words}`);
  const cannot = (line: number, words: string) =>
    new Error(`The command cannot read the config ${file} at line ${line}. ${words}`);
  const { tokens, end } = tokenizeConfig(text, cannot);
  const eof: Token = { image: "", line: end };
  let at = 0;
  const next = () => tokens[at++] ?? eof;
  let deferred: Error | undefined;
  const defer = (error: Error) => (deferred ??= error);
  const defined = (t: Token, undefinedNoun: string | undefined) => {
    if (!NAME.test(t.image))
      defer(
        refuse(
          t.line,
          `The ${undefinedNoun} ${t.image} specified in the configuration file is not defined in the specification.`,
        ),
      );
  };
  const name = (t: Token, what: string) => {
    if (SECTIONS.has(t.image))
      defer(cannot(t.line, `TLC would read the keyword ${t.image} as ${what}.`));
    else if (!NAME.test(t.image))
      defer(cannot(t.line, `TLC would read ${t.image} as ${what}, and it is not a name.`));
  };
  const value = (t: Token): void => {
    if (t === eof) throw refuse(t.line, "It was expecting a value, but did not find it.");
    if (t.image === "{") {
      t = next();
      if (t.image === "}") return;
      value(t);
      while ((t = next()).image === ",") value(next());
      if (t.image !== "}") throw refuse(t.line, "It was expecting }, but did not find it.");
    } else if (SECTIONS.has(t.image))
      defer(cannot(t.line, `TLC would read the keyword ${t.image} as a value.`));
    else if (!NAME.test(t.image) && !/^(\d+|".*")$/.test(t.image))
      defer(
        cannot(
          t.line,
          `TLC would read ${t.image} as a value. A value is a name, a number, a string, or a set in braces.`,
        ),
      );
  };
  const constant = (t: Token, loc: number) => {
    name(t, "a constant name");
    for (t = next(); t.image === "!"; t = next()) name((t = next()), "a constant name");
    if (t.image === "<-") {
      t = next();
      if (t.image === "[") {
        t = next();
        if (t === eof) throw refuse(t.line, "Expected an identifier after <-[.");
        name(t, "a module name");
        t = next();
        if (t.image !== "]") throw refuse(t.line, "It was expecting ], but did not find it.");
        t = next();
        if (t === eof) throw refuse(t.line, "Expected an identifier after <-[mod].");
      } else if (t === eof) throw refuse(t.line, "Expected an identifier after <-.");
      name(t, "the name after <-");
      return;
    }
    if (t.image === "(") {
      value(next());
      while ((t = next()).image === ",") value(next());
      if (t.image !== ")")
        throw refuse(
          loc,
          "TLC gives no reason here. An operator's arguments are one or more values in ( ), with commas between them.",
        );
      t = next();
    }
    if (t.image !== "=") throw refuse(t.line, "It was expecting = or <-, but did not find it.");
    t = next();
    if (t.image === "[") {
      t = next();
      if (t === eof) throw refuse(t.line, "Expected an identifier after =[.");
      name(t, "a module name");
      t = next();
      if (t.image !== "]") throw refuse(t.line, "It was expecting ], but did not find it.");
      t = next();
    }
    value(t);
  };
  const config: Config = {
    sections: [],
    invariants: [],
    properties: [],
    constraints: [],
    actionConstraints: [],
  };
  for (let t = next(); t !== eof;) {
    const keyword = t;
    const section = SECTIONS.get(keyword.image);
    if (!section) throw refuse(t.line, "It was expecting a keyword, but did not find it.");
    const { key, field, undefinedNoun } = section;
    const begin = at;
    if (field === undefined) {
      for (t = next(); t !== eof && !SECTIONS.has(t.image); t = next()) constant(t, keyword.line);
    } else if (isListField(field)) {
      for (t = next(); t !== eof && !SECTIONS.has(t.image); t = next()) {
        config[field].push(t.image);
        defined(t, undefinedNoun);
      }
    } else {
      t = next();
      if (t === eof)
        throw refuse(
          keyword.line,
          `The keyword ${keyword.image} was not followed by an identifier.`,
        );
      if (field === "checkDeadlock" && t.image !== "TRUE" && t.image !== "FALSE")
        throw refuse(t.line, "It was expecting TRUE or FALSE, but did not find it.");
      if (config[field] !== undefined)
        throw refuse(keyword.line, `The keyword ${keyword.image} appeared twice.`);
      if (field === "checkDeadlock") config[field] = t.image === "TRUE";
      else {
        config[field] = t.image;
        if (SECTIONS.has(t.image))
          defer(cannot(t.line, `TLC would read the keyword ${t.image} as the name after ${key}.`));
        else if (undefinedNoun) defined(t, undefinedNoun);
      }
      t = next();
    }
    const images: string[] = [];
    for (let k = begin; k < (t === eof ? tokens.length : at - 1); k++) images.push(tokens[k].image);
    config.sections.push({ key, line: keyword.line, tokens: images });
  }
  if (deferred) throw deferred;
  return config;
}
