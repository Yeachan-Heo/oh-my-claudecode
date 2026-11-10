import type { Config, ConfigSection, Spec } from "../ir.ts";
import { NAME } from "./config.ts";

export type Checks = Pick<Spec, "invariants" | "properties" | "deadlock" | "written">;

export function readChecks({ configFile, config }: { configFile: string; config: Config }): Checks {
  const refuse = (words: string) => new Error(`TLC refuses the config ${configFile}. ${words}`);
  if (config.spec && (config.init || config.next))
    throw refuse("The configuration file cannot specify both INIT/NEXT and SPECIFICATION fields.");
  if (!config.spec && !config.init)
    throw refuse("The configuration file did not specify the initial state predicate.");
  const written: ConfigSection[] = [];
  for (const s of config.sections)
    if (!["INVARIANT", "PROPERTY", "CHECK_DEADLOCK"].includes(s.key)) written.push(s);
  return {
    invariants: config.invariants,
    properties: config.properties,
    deadlock: config.checkDeadlock !== false,
    written,
  };
}

type XmlNode = { tag: string; text: string; children: XmlNode[] };

const ENTITIES: { [name: string]: string } = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

const decode = (text: string) =>
  text.replace(/&(#x?)?(\w+);/g, (_, number: string | undefined, name: string) =>
    number
      ? String.fromCodePoint(Number.parseInt(name, number === "#x" ? 16 : 10))
      : ENTITIES[name],
  );

function parseXml(xml: string) {
  const document: XmlNode = { tag: "", text: "", children: [] };
  const open = [document];
  for (const [, close, tag, empty, text] of xml.matchAll(
    /<(\/?)([^\s/>?!]+)[^>]*?(\/?)>|<[?!][^>]*>|([^<]+)/g,
  )) {
    const parent = open[open.length - 1];
    if (text !== undefined) parent.text += decode(text);
    else if (close) open.pop();
    else if (tag) {
      const node: XmlNode = { tag, text: "", children: [] };
      parent.children.push(node);
      if (!empty) open.push(node);
    }
  }
  return document;
}

const child = (node: XmlNode | undefined, tag: string) => node?.children.find((c) => c.tag === tag);
const textOf = (node: XmlNode | undefined, tag: string) => child(node, tag)?.text ?? "";

export type Sany = {
  variables: string[];
  definitions: Map<string, XmlNode>;
};

const VARIABLE_KIND = "3";

export function readSany(xml: string): Sany {
  const modules = child(parseXml(xml), "modules");
  const symbols = new Map<string, XmlNode>();
  for (const entry of child(modules, "context")?.children ?? [])
    symbols.set(textOf(entry, "UID"), entry.children[1]);
  const root = textOf(modules, "RootModule");
  let module: XmlNode | undefined;
  for (const node of symbols.values())
    if (node.tag === "ModuleNode" && textOf(node, "uniquename") === root) module = node;
  const definitions = new Map<string, XmlNode>();
  const variables: { uid: number; name: string }[] = [];
  for (const ref of module?.children ?? []) {
    if (ref.tag !== "OpDeclNodeRef" && ref.tag !== "UserDefinedOpKindRef") continue;
    const uid = textOf(ref, "UID");
    const node = symbols.get(uid);
    if (!node) continue;
    const name = textOf(node, "uniquename");
    definitions.set(name, node);
    if (node.tag === "OpDeclNode" && textOf(node, "kind") === VARIABLE_KIND)
      variables.push({ uid: Number(uid), name });
  }
  variables.sort((a, b) => a.uid - b.uid);
  return { variables: variables.map((v) => v.name), definitions };
}

export function readSpec({
  module,
  sany,
  checks,
}: {
  module: string;
  sany: Sany;
  checks: Checks;
}): Spec {
  return { module, variables: sany.variables, ...checks };
}

const STATE_LEVEL = 1;

export function initialOnlyProperties({ definitions }: Sany, { written, properties }: Spec) {
  const replaced = new Map<string, string>();
  for (const s of written)
    if (s.key === "CONSTANT")
      for (let i = 1; i + 1 < s.tokens.length; i++)
        if (s.tokens[i] === "<-" && NAME.test(s.tokens[i + 1]))
          replaced.set(s.tokens[i - 1], s.tokens[i + 1]);
  const names = new Set<string>();
  for (const name of properties) {
    const definition = definitions.get(replaced.get(name) ?? name);
    if (definition && Number(textOf(definition, "level")) <= STATE_LEVEL) names.add(name);
  }
  return names;
}
