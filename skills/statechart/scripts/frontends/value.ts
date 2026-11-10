import type { Value } from "../ir.ts";

export const BRACKET = new Int8Array(128);
for (const c of "<{[(") BRACKET[c.charCodeAt(0)] = 1;
for (const c of ">}])") BRACKET[c.charCodeAt(0)] = -1;
const PUNCT = new Map([
  [60, "<<"],
  [62, ">>"],
  [124, "|->"],
  [58, ":>"],
  [64, "@@"],
  [46, ".."],
]);
const SPACE = /\s/;
export const isSpace = (c: number) =>
  c === 32 || (c >= 9 && c <= 13) || (c > 127 && SPACE.test(String.fromCharCode(c)));
const isDigit = (c: number) => c >= 48 && c <= 57;
const isWord = (c: number) =>
  isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isLineEnd = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

export const tokenEnd = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  if (c === 34) {
    for (let j = i + 1; j < s.length; j++) {
      const d = s.charCodeAt(j);
      if (d === 34) return j + 1;
      if (d === 92 && (++j >= s.length || isLineEnd(s.charCodeAt(j)))) return -1;
    }
    return -1;
  }
  const punct = PUNCT.get(c);
  if (punct) return s.startsWith(punct, i) ? i + punct.length : -1;
  if (BRACKET[c] || c === 44) return i + 1;
  let j = i + 1;
  if (c === 45 || isDigit(c)) {
    while (isDigit(s.charCodeAt(j))) j++;
    return c === 45 && j === i + 1 ? -1 : j;
  }
  if (!isWord(c)) return -1;
  while (isWord(s.charCodeAt(j))) j++;
  return j;
};

export const unreadable = (text: string, pos: number) =>
  new Error(`cannot read TLA+ value at "${text.slice(pos, pos + 20)}"`);

const INT = /^-?\d+$/;
const NAME = /^\w*[A-Za-z]\w*$/;
const UNESCAPED: { [c: string]: string } = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "\t",
  r: "\r",
  f: "\f",
};

const models = new Map<string, Value>();
const model = (name: string) => {
  let v = models.get(name);
  if (v === undefined) models.set(name, (v = { kind: "model", name }));
  return v;
};

export function parseValue(text: string): Value {
  const tokens: string[] = [];
  const starts: number[] = [];
  for (let pos = 0; ;) {
    while (pos < text.length && isSpace(text.charCodeAt(pos))) pos++;
    if (pos === text.length) break;
    const end = tokenEnd(text, pos);
    if (end === -1) throw unreadable(text, pos);
    tokens.push(text.slice(pos, end));
    starts.push(pos);
    pos = end;
  }
  let i = 0;
  const fail = (): never => {
    throw unreadable(text, i < starts.length ? starts[Math.max(i - 1, 0)] : text.length);
  };
  const next = () => (i < tokens.length ? tokens[i++] : fail());
  const eat = (t: string) => {
    if (next() !== t) fail();
  };
  const items = <T>(close: string, item: () => T) => {
    const out: T[] = [];
    if (tokens[i] === close) {
      i++;
      return out;
    }
    for (;;) {
      out.push(item());
      const t = next();
      if (t === close) return out;
      if (t !== ",") fail();
    }
  };
  const string = (t: string) => {
    let s = "";
    for (let j = 1, from = 1; ;) {
      const k = t.indexOf("\\", j);
      if (k === -1 || k >= t.length - 1) return s + t.slice(from, -1);
      const c = UNESCAPED[t[k + 1]];
      if (c === undefined) fail();
      s += t.slice(from, k) + c;
      j = from = k + 2;
    }
  };
  const value = (): Value => {
    const t = next();
    switch (t) {
      case "TRUE":
        return true;
      case "FALSE":
        return false;
      case "{":
        return { kind: "set", members: items("}", value) };
      case "<<": {
        const values = items(">>", value);
        const keys: Value[] = [];
        for (let k = 1; k <= values.length; k++) keys.push(k);
        return { kind: "function", printedAs: "tuple", keys, values };
      }
      case "[": {
        const keys: Value[] = [];
        const values: Value[] = [];
        items("]", () => {
          const name = next();
          if (!NAME.test(name)) fail();
          eat("|->");
          keys.push(name);
          values.push(value());
        });
        return { kind: "function", printedAs: "record", keys, values };
      }
      case "(": {
        const keys: Value[] = [];
        const values: Value[] = [];
        do {
          keys.push(value());
          eat(":>");
          values.push(value());
        } while (next() === "@@");
        if (tokens[i - 1] !== ")") fail();
        return { kind: "function", printedAs: "pairs", keys, values };
      }
    }
    if (t.charCodeAt(0) === 34) return string(t);
    if (INT.test(t)) {
      if (tokens[i] !== "..") {
        // TLC integers are unbounded; a value past Number.MAX_SAFE_INTEGER
        // must not round, or distinct states collide in the state keys.
        const n = Number(t);
        return Number.isSafeInteger(n) ? n : { kind: "bigint", digits: t };
      }
      i++;
      const hi = next();
      if (!INT.test(hi)) fail();
      // Interval endpoints get the same lossless treatment: rounding can
      // collapse distinct endpoints, merging distinct model values in the
      // state keys. The raw tokens ride along (marked lossy) for
      // key()/show(); the numeric fields remain for bounded expansion.
      const lo = Number(t);
      const hiN = Number(hi);
      const lossy = !Number.isSafeInteger(lo) || !Number.isSafeInteger(hiN) || String(lo) !== t || String(hiN) !== hi;
      return { kind: "interval", lo: lo, hi: hiN, rawLo: t, rawHi: hi, lossy: lossy };
    }
    if (NAME.test(t)) return model(t);
    return fail();
  };
  const out = value();
  if (i < tokens.length) {
    i++;
    fail();
  }
  return out;
}
