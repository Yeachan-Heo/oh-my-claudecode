import { EC, LEVEL, type Message, PART, type Part } from "../ir.ts";

const PREFIX: { [level: number]: string } = {
  [LEVEL.ERROR]: "Error: ",
  [LEVEL.TLCBUG]: "TLC Bug: ",
  [LEVEL.WARNING]: "Warning: ",
  [LEVEL.STATE]: "State ",
};
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");

export function runtime(ms: number) {
  const t = new Date(ms > DAY ? ms - DAY : ms);
  const [hh, mm, ss] = [t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()].map(pad);
  if (ms > DAY)
    return `${Math.floor((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY) + 1}d ${hh}h`;
  if (ms > HOUR) return `${hh}h ${mm}min`;
  if (ms > MINUTE) return `${mm}min ${ss}s`;
  return `${ss}s`;
}

const firstLine = ({ code, level }: Message, line: string) => {
  if (code === EC.TLC_BACK_TO_STATE)
    return line.replace(/^(\d+): Back to state: /, "Back to state $1: ");
  if (code === EC.TLC_FINISHED)
    return line.replace(
      /^Finished in (\d+)ms/,
      (_, ms: string) => `Finished in ${runtime(Number(ms))}`,
    );
  return (PREFIX[level] ?? "") + line;
};

const render = (m: Message): string =>
  (m.beforeMarker ?? "") +
  firstLine(m, m.body.map((part) => (typeof part === "string" ? part : render(part))).join("\n"));

function* printed(parts: Iterable<Part>): Generator<string> {
  let warned = false;
  let progress: Message | undefined;
  for (const part of parts) {
    if (progress?.body.length && (typeof part === "string" || part.code !== EC.TLC_STATS))
      yield render(progress);
    progress = undefined;
    if (typeof part === "string") {
      yield part;
      continue;
    }
    if (part.code === EC.TLC_SANY_START || part.code === EC.TLC_SANY_END) continue;
    if (part.code === EC.TLC_PROGRESS_STATS) progress = part;
    else if (part.body.length) yield render(part);
    if (part.level === LEVEL.WARNING && !warned) {
      yield "(Use the -nowarning option to disable this warning.)";
      warned = true;
    }
  }
  if (progress?.body.length) yield render(progress);
}

export function* plainText(parts: Iterable<Part>): Generator<string> {
  let chunk = "";
  for (const line of printed(parts)) {
    chunk += `${line}\n`;
    if (chunk.length >= PART) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk) yield chunk;
}
