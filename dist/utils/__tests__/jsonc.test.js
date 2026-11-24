import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { parseJsonc, stripJsoncComments } from '../jsonc.js';
// The shipped parsers import stripLeadingUtf8Bom, and they are standalone CLI entry
// points that cannot be imported without running main(). So their parser functions are
// lifted out of the real source and evaluated with the shared helper's own source
// alongside them: the BOM behaviour under test is the shipped helper's, not a copy.
function sharedBomHelperSource(path) {
    const helper = path.startsWith('templates/')
        ? 'templates/hooks/lib/utf8-bom.mjs'
        : 'scripts/lib/utf8-bom.mjs';
    const source = readFileSync(helper, 'utf8');
    const match = source.match(/^export function stripLeadingUtf8Bom\([\s\S]*?\n\}/m);
    expect(match, `${helper} must define stripLeadingUtf8Bom()`).not.toBeNull();
    return match[0].replace(/^export /, '');
}
describe('parseJsonc - trailing commas', () => {
    it('tolerates a trailing comma in an object', () => {
        expect(parseJsonc('{"a":1,}')).toEqual({ a: 1 });
    });
    it('tolerates a trailing comma in an array', () => {
        expect(parseJsonc('[1,2,]')).toEqual([1, 2]);
    });
    it('tolerates trailing commas in nested structures', () => {
        const input = `{
      "list": [1, 2, 3,],
      "obj": { "x": true, },
    }`;
        expect(parseJsonc(input)).toEqual({
            list: [1, 2, 3],
            obj: { x: true },
        });
    });
    it('tolerates a trailing comma followed by whitespace and newlines', () => {
        const input = '{\n  "a": 1,\n  "b": 2,\n}';
        expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
    });
});
describe('parseJsonc - string preservation', () => {
    it('preserves a comma inside a string value', () => {
        expect(parseJsonc('{"a":"1,"}')).toEqual({ a: '1,' });
    });
    it('does not strip a comma-then-brace sequence inside a string', () => {
        // The literal text "x,}" must survive intact as a string value.
        expect(parseJsonc('{"a":"x,}"}')).toEqual({ a: 'x,}' });
    });
    it('preserves a trailing-comma-like pattern inside a string', () => {
        expect(parseJsonc('{"a":"[1,2,]"}')).toEqual({ a: '[1,2,]' });
    });
});
describe('parseJsonc - comment stripping still works', () => {
    it('strips single-line comments', () => {
        const input = `{
      // this is a comment
      "a": 1
    }`;
        expect(parseJsonc(input)).toEqual({ a: 1 });
    });
    it('strips multi-line comments', () => {
        const input = `{
      /* block
         comment */
      "a": 1
    }`;
        expect(parseJsonc(input)).toEqual({ a: 1 });
    });
    it('does not strip // inside a string value', () => {
        expect(parseJsonc('{"url":"http://example.com"}')).toEqual({
            url: 'http://example.com',
        });
    });
    it('handles comments and trailing commas together', () => {
        const input = `{
      "a": 1, // trailing comment
      "b": 2, /* another */
    }`;
        expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
    });
});
describe('stripJsoncComments - trailing comma removal', () => {
    it('removes a trailing comma before a closing brace', () => {
        expect(stripJsoncComments('{"a":1,}')).toBe('{"a":1}');
    });
    it('removes a trailing comma before a closing bracket', () => {
        expect(stripJsoncComments('[1,2,]')).toBe('[1,2]');
    });
});
describe('parseJsonc - block comment boundaries', () => {
    it.each(['[1/*comment*/2]', '{"x":tr/*comment*/ue}', '{"x":1}/*unterminated'])('rejects invalid JSONC without joining tokens: %s', async (input) => {
        const runtimePath = '../../../scripts/lib/agent-model-config.mjs';
        const runtime = await import(runtimePath);
        expect(() => parseJsonc(input)).toThrow(SyntaxError);
        expect(() => JSON.parse(runtime.stripJsoncComments(input))).toThrow(SyntaxError);
    });
    it('preserves comments at valid token boundaries in both implementations', async () => {
        const runtimePath = '../../../scripts/lib/agent-model-config.mjs';
        const runtime = await import(runtimePath);
        const input = '{/*comment*/"x":/*comment*/true/*comment*/}';
        expect(parseJsonc(input)).toEqual({ x: true });
        expect(JSON.parse(runtime.stripJsoncComments(input))).toEqual({ x: true });
    });
});
describe('workflow runtime JSONC parser parity', () => {
    it.each(['scripts/lib/workflow-profile-runtime.mjs', 'templates/hooks/lib/workflow-profile-runtime.mjs'])('preserves trailing commas and comment boundaries in %s', (path) => {
        const source = readFileSync(path, 'utf8');
        const parserSource = source.split('\n').find(line => line.startsWith('function stripJsonc('));
        expect(parserSource).toBeDefined();
        const strip = runInNewContext(`${sharedBomHelperSource(path)}\n${parserSource}; stripJsonc`);
        expect(JSON.parse(strip('{"version":1,}'))).toEqual({ version: 1 });
        expect(JSON.parse(strip('["ralplan","execution",]'))).toEqual(['ralplan', 'execution']);
        expect(JSON.parse(strip('{/*comment*/"version":1,}'))).toEqual({ version: 1 });
        for (const input of ['{"version":1e/*comment*/0}', '{"version":1}/*unterminated']) {
            expect(() => JSON.parse(strip(input))).toThrow();
        }
    });
});
describe('agent model hook JSONC parity', () => {
    it.each([
        '{"agents":{"executor":{"model":"sonnet",},},}',
        '{"agents":{"executor":{"model":"sonnet",/* next */},},}',
        '{"items":["literal,}", "escaped\\\"quote",],}',
    ])('accepts supported JSONC without changing string contents: %s', async (input) => {
        const runtimePath = '../../../scripts/lib/agent-model-config.mjs';
        const runtime = await import(runtimePath);
        expect(JSON.parse(runtime.stripJsoncComments(input))).toEqual(parseJsonc(input));
    });
});
describe('leading UTF-8 BOM', () => {
    const BOM = '﻿';
    it('parses an object saved with a BOM', () => {
        expect(parseJsonc(`${BOM}{"a":1}`)).toEqual({ a: 1 });
    });
    it('parses a BOM alongside comments and trailing commas', () => {
        const input = `${BOM}{
      // leading comment
      "list": [1, 2,],
      "obj": { "x": true, },
    }`;
        expect(parseJsonc(input)).toEqual({ list: [1, 2], obj: { x: true } });
    });
    it('strips the BOM from stripJsoncComments output', () => {
        expect(stripJsoncComments(`${BOM}{"a":1,}`)).toBe('{"a":1}');
    });
    it('keeps a U+FEFF that is not the first character', () => {
        expect(parseJsonc(`{"a":"x${BOM}y"}`)).toEqual({ a: `x${BOM}y` });
        expect(parseJsonc(`${BOM}{"a":"x${BOM}y"}`)).toEqual({ a: `x${BOM}y` });
    });
    it('leaves BOM-free content unchanged', () => {
        expect(stripJsoncComments('{"a":1}')).toBe('{"a":1}');
    });
    it('matches the agent model hook runtime for BOM input', async () => {
        const runtimePath = '../../../scripts/lib/agent-model-config.mjs';
        const runtime = await import(runtimePath);
        for (const input of [`${BOM}{"a":1}`, `${BOM}{"agents":{"executor":{"model":"sonnet",},},}`]) {
            expect(JSON.parse(runtime.stripJsoncComments(input))).toEqual(parseJsonc(input));
        }
    });
});
describe('config loader reads a BOM-prefixed config file', () => {
    it('loads .claude/omc.jsonc saved as UTF-8 with BOM', async () => {
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { loadJsoncFile } = await import('../../config/loader.js');
        const dir = mkdtempSync(join(tmpdir(), 'omc-jsonc-bom-'));
        const file = join(dir, 'omc.jsonc');
        writeFileSync(file, '﻿{\n  // saved by a Windows editor\n  "security": { "enabled": true },\n}\n', 'utf-8');
        expect(loadJsoncFile(file)).toMatchObject({ security: { enabled: true } });
    });
});
describe('shipped hook JSONC parsers accept a leading UTF-8 BOM', () => {
    const BOM = '﻿';
    // The hook scripts are standalone CLI entry points, so their parsers cannot be
    // imported without running main(). Lift the parser functions out of the real
    // source and execute them, the way the workflow runtime parity test above does.
    function mirrorParser(path) {
        const source = readFileSync(path, 'utf8');
        const required = ['stripJsoncComments', 'stripComments', 'stripTrailingCommas'];
        expect(source, `${path} must import the shared BOM helper`).toContain('stripLeadingUtf8Bom');
        const blocks = required.map((name) => {
            const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm'));
            // A missing required function means the extraction itself broke and the
            // assertions below would be meaningless.
            expect(match, `${path} must define ${name}()`).not.toBeNull();
            return match[0];
        });
        return runInNewContext(`${sharedBomHelperSource(path)}\n${blocks.join('\n')}; stripJsoncComments`);
    }
    function inlineMirrorParser(path) {
        const source = readFileSync(path, 'utf8');
        const line = source.split('\n').find((candidate) => candidate.startsWith('function stripJsonc('));
        expect(line, `${path} must define stripJsonc() on one line`).toBeDefined();
        expect(source, `${path} must import the shared BOM helper`).toContain('stripLeadingUtf8Bom');
        return runInNewContext(`${sharedBomHelperSource(path)}\n${line}; stripJsonc`);
    }
    it.each([
        'scripts/keyword-detector.mjs',
        'templates/hooks/keyword-detector.mjs',
        'scripts/persistent-mode.mjs',
        'templates/hooks/persistent-mode.mjs',
    ])('parses a BOM-prefixed config in %s', (path) => {
        const strip = mirrorParser(path);
        expect(JSON.parse(strip(`${BOM}{"a":1}`))).toEqual({ a: 1 });
        const config = `${BOM}{\n  // saved by a Windows editor\n  "keywordDetector": { "disabled": true },\n}`;
        expect(JSON.parse(strip(config))).toEqual({ keywordDetector: { disabled: true } });
        expect(strip('{"a":1}')).toBe('{"a":1}');
        expect(JSON.parse(strip(`${BOM}{"a":"x${BOM}y"}`))).toEqual({ a: `x${BOM}y` });
    });
    it.each([
        'scripts/lib/workflow-profile-runtime.mjs',
        'templates/hooks/lib/workflow-profile-runtime.mjs',
    ])('parses a BOM-prefixed profile in %s', (path) => {
        const strip = inlineMirrorParser(path);
        expect(JSON.parse(strip(`${BOM}{"version":1,}`))).toEqual({ version: 1 });
        expect(strip('{"version":1}')).toBe('{"version":1}');
        expect(JSON.parse(strip(`${BOM}{"name":"x${BOM}y"}`))).toEqual({ name: `x${BOM}y` });
    });
    it.each([
        'scripts/keyword-detector.mjs',
        'templates/hooks/keyword-detector.mjs',
        'scripts/persistent-mode.mjs',
        'templates/hooks/persistent-mode.mjs',
    ])('matches the canonical parser output in %s', (path) => {
        const strip = mirrorParser(path);
        for (const input of [`${BOM}{"a":1,}`, '{"a":1}', `${BOM}{/*c*/"a":[1,2,],}`]) {
            expect(strip(input)).toBe(stripJsoncComments(input));
        }
    });
});
//# sourceMappingURL=jsonc.test.js.map