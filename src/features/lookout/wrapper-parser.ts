/** Small shell-wrapper option parsers used by lookout command discovery. */

export type XargsOptionResult = number | "terminal" | null;

export function parseXargsOption(value: string): XargsOptionResult {
  if (/^(?:-h|--help|-V|--version|--show-limits)$/.test(value)) return "terminal";
  if (value === "--") return 1;
  if (/^(?:-a|--arg-file|-d|--delimiter|-E|--eof|-I|--replace|-L|--max-lines|-n|--max-args|-P|--max-procs|-s|--max-chars|--process-slot-var)$/.test(value)) {
    return 2;
  }
  if (/^(?:--arg-file=|--delimiter=|--eof=|--replace=|--max-lines=|--max-args=|--max-procs=|--max-chars=|--process-slot-var=)/.test(value)) {
    return 1;
  }
  return value.startsWith("-") ? 1 : null;
}
