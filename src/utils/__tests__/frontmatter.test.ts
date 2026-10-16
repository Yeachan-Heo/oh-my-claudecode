import { describe, it, expect } from "vitest";
import {
  stripLeadingUtf8Bom,
  stripOptionalQuotes,
  parseFrontmatter,
  parseFrontmatterAliases,
  parseFrontmatterList,
  splitFlowSequenceItems,
} from "../frontmatter.js";

describe("stripOptionalQuotes", () => {
  it("strips double quotes", () => {
    expect(stripOptionalQuotes('"hello"')).toBe("hello");
  });

  it("strips single quotes", () => {
    expect(stripOptionalQuotes("'hello'")).toBe("hello");
  });

  it("trims whitespace before stripping", () => {
    expect(stripOptionalQuotes('  "hello"  ')).toBe("hello");
  });

  it("does not strip mismatched quotes", () => {
    expect(stripOptionalQuotes("\"hello'")).toBe("\"hello'");
  });

  it("returns unquoted strings as-is", () => {
    expect(stripOptionalQuotes("hello")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(stripOptionalQuotes("")).toBe("");
  });

  it("handles string with only quotes", () => {
    expect(stripOptionalQuotes('""')).toBe("");
  });

  it("trims inner whitespace after stripping quotes", () => {
    expect(stripOptionalQuotes('" hello "')).toBe("hello");
  });
});

describe("parseFrontmatter", () => {
  it("parses valid frontmatter", () => {
    const content = `---
name: my-skill
description: A test skill
---
Body content here`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({
      name: "my-skill",
      description: "A test skill",
    });
    expect(result.body).toBe("Body content here");
  });

  it("returns empty metadata when no frontmatter", () => {
    const content = "Just some plain text";
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({});
    expect(result.body).toBe("Just some plain text");
  });

  it("handles quoted values", () => {
    const content = `---
name: "quoted-name"
aliases: 'single-quoted'
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.metadata.name).toBe("quoted-name");
    expect(result.metadata.aliases).toBe("single-quoted");
  });

  it("handles values with colons", () => {
    const content = `---
url: https://example.com:8080/path
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.metadata.url).toBe("https://example.com:8080/path");
  });

  it("skips lines without colons", () => {
    const content = `---
name: valid
this-has-no-value
another: valid-too
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({
      name: "valid",
      another: "valid-too",
    });
  });

  it("handles empty frontmatter", () => {
    const content = `---

---
Body`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({});
    expect(result.body).toBe("Body");
  });

  it("handles Windows-style line endings", () => {
    const content = "---\r\nname: test\r\n---\r\nBody";
    const result = parseFrontmatter(content);
    expect(result.metadata.name).toBe("test");
    expect(result.body).toBe("Body");
  });

  it("handles mixed LF and CRLF while preserving the body", () => {
    const body = "Body\r\nwith mixed\nline endings\r\n";
    const content = `---\r\nname: mixed\ndescription: Mixed separators\r\n---\n${body}`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: "mixed",
      description: "Mixed separators",
    });
    expect(result.body).toBe(body);
  });

  it("does not treat a bare carriage return as a frontmatter separator", () => {
    const partialOpen = "---\rname: test\n---\nBody";
    const partialClose = "---\nname: test\n---\rBody";

    expect(parseFrontmatter(partialOpen)).toEqual({
      metadata: {},
      body: partialOpen,
    });
    expect(parseFrontmatter(partialClose)).toEqual({
      metadata: {},
      body: partialClose,
    });
  });

  it("handles empty body", () => {
    const content = `---
name: test
---
`;
    const result = parseFrontmatter(content);
    expect(result.metadata.name).toBe("test");
    expect(result.body).toBe("");
  });

  it("handles multiline body", () => {
    const content = `---
name: test
---
Line 1
Line 2
Line 3`;
    const result = parseFrontmatter(content);
    expect(result.body).toBe("Line 1\nLine 2\nLine 3");
  });

  it("does not promote nested mapping fields to top-level metadata", () => {
    const content = `---
name: compatibility-skill
description: Top-level description
metadata:
  integration:
    description: Nested integration description
    model: nested-model
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: "compatibility-skill",
      description: "Top-level description",
      metadata: "",
    });
  });

  it("preserves uniformly indented root mappings without promoting nested fields", () => {
    const content = `---
# comment: does not define mapping indentation
  name: indented-skill
  description: Indented root description
  model: opus
  metadata:
    description: Nested description
    model: nested-model
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: "indented-skill",
      description: "Indented root description",
      model: "opus",
      metadata: "",
    });
  });

  it("ignores de-indented members of multiline flow mappings", () => {
    const content = `---
  name: indented-skill
  metadata: {
integration: remote,
model: nested-model
  }
  description: Root description
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: "indented-skill",
      metadata: "{",
      description: "Root description",
    });
  });

  it("ignores nested members of same-indent multiline flow mappings", () => {
    const content = `---
name: example-skill
description: Top-level description
metadata: {
description: Nested,
model: nested
}
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: "example-skill",
      description: "Top-level description",
      metadata: "{",
    });
  });

  it("ignores nested members of same-indent multiline flow sequences", () => {
    const content = `---
name: example-skill
description: Top-level description
metadata: [
description: Nested,
model: nested
]
agent: coder
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: "example-skill",
      description: "Top-level description",
      metadata: "[",
      agent: "coder",
    });
  });

  it("does not open flow tracking for braces embedded in plain scalar values", () => {
    const content = `---
name: example-skill
description: prose with { stray brace
model: opus
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: "example-skill",
      description: "prose with { stray brace",
      model: "opus",
    });
  });
  it("ignores comments at the detected root indentation", () => {
    const content = `---
  name: indented-skill
  # fake: comment
  description: Root description
---
Body`;
    const result = parseFrontmatter(content);

    expect(result.metadata).toEqual({
      name: "indented-skill",
      description: "Root description",
    });
  });
});

describe("parseFrontmatterAliases", () => {
  it("parses inline YAML list", () => {
    expect(parseFrontmatterAliases("[foo, bar, baz]")).toEqual([
      "foo",
      "bar",
      "baz",
    ]);
  });

  it("parses single value", () => {
    expect(parseFrontmatterAliases("my-alias")).toEqual(["my-alias"]);
  });

  it("returns empty array for undefined", () => {
    expect(parseFrontmatterAliases(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseFrontmatterAliases("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseFrontmatterAliases("   ")).toEqual([]);
  });

  it("handles quoted items in list", () => {
    expect(parseFrontmatterAliases("[\"foo\", 'bar']")).toEqual(["foo", "bar"]);
  });

  it("handles empty list", () => {
    expect(parseFrontmatterAliases("[]")).toEqual([]);
  });

  it("handles list with whitespace-only items", () => {
    expect(parseFrontmatterAliases("[foo, , bar]")).toEqual(["foo", "bar"]);
  });

  it("strips quotes from single value", () => {
    expect(parseFrontmatterAliases('"my-alias"')).toEqual(["my-alias"]);
  });

  it("handles list with spaces around items", () => {
    expect(parseFrontmatterAliases("[ foo , bar , baz ]")).toEqual([
      "foo",
      "bar",
      "baz",
    ]);
  });
});

describe("parseFrontmatterList quoted commas", () => {
  it("keeps commas inside quoted items", () => {
    expect(parseFrontmatterList("[\"a, b\", plain, 'x, y']")).toEqual([
      "a, b",
      "plain",
      "x, y",
    ]);
  });

  it("does not let an escaped quote end a double-quoted item", () => {
    expect(parseFrontmatterList('["say \\"hi\\", twice", next]')).toEqual([
      'say \\"hi\\", twice',
      "next",
    ]);
  });

  it("keeps commas inside single-quoted items with escaped apostrophes", () => {
    expect(splitFlowSequenceItems("'it''s, fine', next")).toEqual([
      "'it''s, fine'",
      " next",
    ]);
    expect(parseFrontmatterList("['it''s, fine', next]")).toEqual([
      "it's, fine",
      "next",
    ]);
  });

  it("treats a bare apostrophe as literal text", () => {
    expect(parseFrontmatterList("[don't, stop]")).toEqual(["don't", "stop"]);
  });

  it("still splits simple lists", () => {
    expect(parseFrontmatterList("[foo, bar,baz]")).toEqual([
      "foo",
      "bar",
      "baz",
    ]);
    expect(parseFrontmatterList("[]")).toEqual([]);
  });
});

describe("parseFrontmatter UTF-8 BOM", () => {
  it("parses frontmatter that follows a leading BOM", () => {
    expect(
      parseFrontmatter(
        "\uFEFF---\nname: x\ndescription: hello\n---\nbody\uFEFFtail",
      ),
    ).toEqual({
      metadata: { name: "x", description: "hello" },
      body: "body\uFEFFtail",
    });
  });

  it("parses block scalar values after a leading BOM", () => {
    expect(
      parseFrontmatter(
        "\uFEFF---\ndescription: >-\n  first\n  second\n---\nbody",
      ),
    ).toEqual({
      metadata: { description: "first second" },
      body: "body",
    });
  });

  it("strips exactly one BOM only at the beginning", () => {
    expect(stripLeadingUtf8Bom("\uFEFF\uFEFFbody\uFEFF")).toBe(
      "\uFEFFbody\uFEFF",
    );
    expect(stripLeadingUtf8Bom("body\uFEFF")).toBe("body\uFEFF");
  });
});

describe("parseFrontmatter block scalars", () => {
  const parse = (yaml: string) =>
    parseFrontmatter(`---\n${yaml}\n---\nbody`).metadata;

  it("folds `>-` descriptions into one line", () => {
    expect(
      parse(
        "name: x\ndescription: >-\n  First part\n  second part\nmodel: opus",
      ),
    ).toEqual({
      name: "x",
      description: "First part second part",
      model: "opus",
    });
  });

  it("folds `>` descriptions and keeps blank-line paragraph breaks", () => {
    expect(parse("description: >\n  One\n  two\n\n  three\n")).toEqual({
      description: "One two\nthree\n",
    });
  });

  it("keeps line breaks for `|` literals", () => {
    expect(
      parse("description: |\n  line one\n    indented\n  line two"),
    ).toEqual({
      description: "line one\n  indented\nline two\n",
    });
  });

  it("preserves spaces beyond the content indent on whitespace-only literal rows", () => {
    expect(parse("description: |-\n  first\n   \n  second")).toEqual({
      description: "first\n \nsecond",
    });
    expect(parse("description: |-\n  first\n   \n")).toEqual({
      description: "first\n ",
    });
  });

  it("preserves breaks around more-indented folded lines", () => {
    expect(
      parse("description: >-\n  Run:\n    npm test\n  afterwards"),
    ).toEqual({
      description: "Run:\n  npm test\nafterwards",
    });
  });

  it("stops at a nonblank line indented less than the scalar content", () => {
    expect(
      parse("description: >-\n    Real text\n  # note\nmodel: opus"),
    ).toEqual({
      description: "Real text",
      model: "opus",
    });
  });

  it("applies explicit indentation relative to the key and retains extra indentation", () => {
    expect(
      parse("  name: x\n  description: |2-\n      kept\n  model: opus"),
    ).toEqual({
      name: "x",
      description: "  kept",
      model: "opus",
    });
  });

  it("counts only ASCII spaces when inferring scalar indentation", () => {
    expect(parse("description: |-\n   text")).toEqual({ description: " text" });
    expect(parse("description: >-\n  first\n   second")).toEqual({
      description: "first  second",
    });
  });

  it("preserves folded breaks around tab-indented content", () => {
    expect(parse("description: >-\n  before\n  \tcode\n  after")).toEqual({
      description: "before\n\tcode\nafter",
    });
  });

  it("applies strip, clip, and keep chomping to folded scalars", () => {
    expect(parse("description: >-\n  first\n  second")).toEqual({
      description: "first second",
    });
    expect(parse("description: >-\n  first\n  second\n\n")).toEqual({
      description: "first second",
    });
    expect(parse("description: >\n  first\n  second")).toEqual({
      description: "first second\n",
    });
    expect(parse("description: >+\n  first\n  second\n")).toEqual({
      description: "first second\n\n",
    });
  });

  it("applies strip, clip, and keep chomping to literal scalars", () => {
    expect(parse("description: |-\n  first\n  second")).toEqual({
      description: "first\nsecond",
    });
    expect(parse("description: |-\n  first\n  second\n\n")).toEqual({
      description: "first\nsecond",
    });
    expect(parse("description: |\n  first\n  second")).toEqual({
      description: "first\nsecond\n",
    });
    expect(parse("description: |+\n  first\n  second\n")).toEqual({
      description: "first\nsecond\n\n",
    });
  });

  it("does not add a clipped line break to an empty block scalar", () => {
    expect(parse("description: |\n\n")).toEqual({ description: "" });
  });

  it("normalizes all-blank implicit block scalars", () => {
    expect(parse("description: |-\n  \nmodel: opus")).toEqual({
      description: "",
      model: "opus",
    });
  });

  it("keeps a shallower comment outside a block after leading blank rows", () => {
    expect(parse("description: |-\n  \n # note\nmodel: opus")).toEqual({
      description: "",
      model: "opus",
    });
    expect(parse("description: |-\n  \n  # note\nmodel: opus")).toEqual({
      description: "\n# note",
      model: "opus",
    });
  });

  it("accepts chomping and indentation indicators and a trailing comment", () => {
    expect(parse("description: |+2 # note\n  kept")).toEqual({
      description: "kept\n",
    });
  });

  it("parses CRLF block scalars", () => {
    expect(
      parseFrontmatter(
        "---\r\ndescription: >-\r\n  a\r\n  b\r\nname: x\r\n---\r\nbody",
      ).metadata,
    ).toEqual({
      description: "a b",
      name: "x",
    });
  });

  it("does not treat a quoted or plain `>` text value as a block scalar", () => {
    expect(
      parse('description: ">"\nargument-hint: a > b\nplain-leading: > text'),
    ).toEqual({
      description: ">",
      "argument-hint": "a > b",
      "plain-leading": "> text",
    });
  });
});
