const shown = (text: string) => text.replace(/#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

export const drawn = (chart: string) => {
  const names = new Map<string, string>();
  for (const m of chart.matchAll(/^ *(?:state "(.*)" as (s\d+) \{|(s\d+): (.*))$/gm))
    names.set(m[2] ?? m[3], shown(m[1] ?? m[4]));
  const arrows: string[] = [];
  const blocks: string[] = [];
  for (const line of chart.split("\n")) {
    const block = line.match(/^ *state ".*" as (\w+) \{$/);
    if (block) blocks.push(block[1]);
    if (/^ *\}$/.test(line)) blocks.pop();
    const m = line.match(/^ *(s\d+|\[\*\]) --> (s\d+)(?:: (.*))?$/);
    const parent = names.get(blocks.at(-1) ?? "");
    if (!m || (m[1] === "[*]" && parent === undefined)) continue;
    const from = m[1] === "[*]" ? `${parent} start` : names.get(m[1]);
    arrows.push(`${from} --> ${names.get(m[2])}${m[3] === undefined ? "" : `: ${shown(m[3])}`}`);
  }
  return { states: [...names.values()], arrows };
};
