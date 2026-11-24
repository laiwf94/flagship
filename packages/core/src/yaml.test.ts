import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseYaml, stringifyYaml, YamlError, type YamlValue } from './yaml.js';

const value = (text: string) => parseYaml(text).value;

function errorOf(text: string): YamlError {
  try {
    parseYaml(text);
  } catch (e) {
    if (e instanceof YamlError) return e;
    throw e;
  }
  throw new Error('expected a YamlError');
}

describe('parseYaml', () => {
  it('reads block mappings and sequences', () => {
    expect(
      value(
        [
          '# a flags file',
          'version: 1',
          'flags:',
          '  checkout:',
          '    name: New checkout   # trailing comment',
          '    tags:',
          '      - web',
          '      - "mobile app"',
          '    nested:',
          '    - a',
          '    - b',
          '',
          '  other: {}',
        ].join('\n'),
      ),
    ).toEqual({
      version: 1,
      flags: {
        checkout: { name: 'New checkout', tags: ['web', 'mobile app'], nested: ['a', 'b'] },
        other: {},
      },
    });
  });

  it('reads compact mappings and sequences inside list items', () => {
    expect(
      value(
        [
          'rules:',
          '  - id: r1',
          '    clauses:',
          '      - attribute: country',
          '        operator: in',
          '        values: [NZ, AU]',
          '    serve: { variant: on }',
          '  - - 1',
          '    - 2',
          '  -',
          '  - - [x]',
        ].join('\n'),
      ),
    ).toEqual({
      rules: [
        {
          id: 'r1',
          clauses: [{ attribute: 'country', operator: 'in', values: ['NZ', 'AU'] }],
          serve: { variant: 'on' },
        },
        [1, 2],
        null,
        [['x']],
      ],
    });
  });

  it('resolves scalars with the JSON schema, so yes/on/off stay strings', () => {
    expect(
      value(
        [
          'a: true',
          'b: False',
          'c: ~',
          'd:',
          'e: null',
          'f: -12.5e3',
          'g: 0',
          'h: yes',
          'i: on',
          'j: 0x1F',
          'k: 1_000',
          'l: .inf',
          'm: 007',
          'n: http://example.com/a#b',
          'o: a:b',
        ].join('\n'),
      ),
    ).toEqual({
      a: true,
      b: false,
      c: null,
      d: null,
      e: null,
      f: -12500,
      g: 0,
      h: 'yes',
      i: 'on',
      j: '0x1F',
      k: '1_000',
      l: '.inf',
      m: '007',
      n: 'http://example.com/a#b',
      o: 'a:b',
    });
  });

  it('reads quoted scalars and their escapes', () => {
    expect(
      value(
        [
          `a: 'it''s # not a comment'`,
          'b: "tab\\tnew\\nline \\u00e9 \\x41 \\U0001F600 \\" \\\\ \\/"',
          '"quoted key": 1',
          `'single key': 2`,
          'c: "#"  # comment',
        ].join('\n'),
      ),
    ).toEqual({
      a: "it's # not a comment",
      b: 'tab\tnew\nline é A 😀 " \\ /',
      'quoted key': 1,
      'single key': 2,
      c: '#',
    });
  });

  it('reads flow collections', () => {
    expect(
      value('a: [1, "two", [three], {k: v, e: , q: "x,y"}, ]\nb: { x: [ ], y: {} }\nc: [a:b, c d]'),
    ).toEqual({
      a: [1, 'two', ['three'], { k: 'v', e: null, q: 'x,y' }],
      b: { x: [], y: {} },
      c: ['a:b', 'c d'],
    });
  });

  it('reads literal and folded block scalars with chomping', () => {
    const doc = [
      'lit: |',
      '  one',
      '    two',
      '',
      '  three',
      'strip: |-',
      '  x',
      '',
      'keep: |+',
      '  y',
      '',
      '',
      'fold: >',
      '  a',
      '  b',
      '',
      '  c',
      '    indented',
      '  d',
      'foldstrip: >-',
      '  p',
      '  q',
      'empty: |',
      'list:',
      '  - |',
      '    item',
      '  - after',
    ].join('\n');
    expect(value(doc)).toEqual({
      lit: 'one\n  two\n\nthree\n',
      strip: 'x',
      keep: 'y\n\n\n',
      fold: 'a b\nc\n  indented\nd\n',
      foldstrip: 'p q',
      empty: '',
      list: ['item\n', 'after'],
    });
  });

  it('accepts a document start and end marker, a BOM and CRLF line ends', () => {
    expect(value('\uFEFF---\r\na: 1\r\n...\r\n')).toEqual({ a: 1 });
    expect(value('')).toBeNull();
    expect(value('# only a comment\n')).toBeNull();
    expect(value('- 1\n- 2')).toEqual([1, 2]);
    expect(value('just text')).toBe('just text');
  });

  it('keeps __proto__ as a plain key', () => {
    const v = value('__proto__: {polluted: true}\n') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('maps paths to the lines they start on', () => {
    const doc = parseYaml(
      [
        'flags:', // 1
        '  checkout:', // 2
        '    rules:', // 3
        '      - id: a', // 4
        '        serve: {variant: on}', // 5
        '      - id: b', // 6
        '    list: [x, y]', // 7
      ].join('\n'),
    );
    expect(doc.lineOf('flags')).toBe(1);
    expect(doc.lineOf('flags.checkout.rules')).toBe(3);
    expect(doc.lineOf('flags.checkout.rules[0]')).toBe(4);
    expect(doc.lineOf('flags.checkout.rules[0].serve.variant')).toBe(5);
    expect(doc.lineOf('flags.checkout.rules[1].id')).toBe(6);
    expect(doc.lineOf('flags.checkout.rules[1].clauses[0].values')).toBe(6);
    expect(doc.lineOf('flags.checkout.list[1]')).toBe(7);
    expect(doc.lineOf('nothing.here')).toBe(1);
    expect(doc.lineOf('')).toBe(1);
  });

  it.each([
    ['a: 1\na: 2', 2, 'duplicate key "a"'],
    ['a: {b: 1, b: 2}', 1, 'duplicate key "b"'],
    ['a: &x 1', 1, 'anchors are not supported'],
    ['a: *x', 1, 'aliases are not supported'],
    ['a: !!str 1', 1, 'tags are not supported'],
    ['%YAML 1.2\n---\na: 1', 1, 'directives are not supported'],
    ['? a\n: b', 1, 'complex keys are not supported'],
    ['<<: {a: 1}', 1, 'merge keys are not supported'],
    ['a: 1\n---\nb: 2', 2, 'only one document per file'],
    ['a: 1\n...\nb: 2', 3, 'only one document per file'],
    ['--- a: 1', 1, 'put the document on the line after ---'],
    ['a:\n\tb: 1', 2, 'indent with spaces, not tabs'],
    ['a: 1\n  b: 2', 2, 'a value can not continue on the next line'],
    ['a: 1\n\n  b: 2', 3, 'unexpected indentation'],
    ['a:\n  b: 1\n c: 2', 3, 'unexpected indentation'],
    ['a: 1\nb', 2, 'expected "key: value"'],
    ['  a: 1', 1, 'the document must start at column 1'],
    ['a: b: c', 1, 'a key: value pair can not be a value on the same line'],
    ['a: [1, 2', 1, 'a [ list ] must close on the same line'],
    ['a: {b: 1', 1, 'a { mapping } must close on the same line'],
    ['a: ["1" 2]', 1, 'expected "," or "]"'],
    ['a: {b: "1" c}', 1, 'expected "," or "}"'],
    ['a: {b}', 1, 'expected ":" after key "b"'],
    ['a: [1, , 2]', 1, 'empty entry in a [ list ]'],
    ['a: "open', 1, 'a double-quoted string must close on the same line'],
    ["a: 'open", 1, 'a single-quoted string must close on the same line'],
    ['a: "\\q"', 1, 'unknown escape "\\q"'],
    ['a: "\\u12"', 1, '\\u needs 4 hex digits'],
    ['a: "\\UFFFFFFFF"', 1, 'is not a Unicode code point'],
    ['a: "x" y', 1, 'unexpected text after the value'],
    ['a: |2\n   x', 1, 'explicit block indentation is not supported'],
    ['a: |x', 1, 'expected "|" or ">"'],
    ['a:\n  - 1\n  b: 2', 3, 'unexpected indentation'],
    ['a: 1\n- 2', 2, 'a list item where a key was expected'],
    ['a: [b{c]', 1, '"{" inside a plain value'],
    ['- a\nb: 1', 2, 'unexpected content after the document'],
    ['a: @x', 1, '"@" at the start of a plain value'],
    [': x', 1, 'expected a key before ":"'],
    ['a: {: x}', 1, 'expected a key'],
    ['a:\n  - |\n\t x', 3, 'indent with spaces, not tabs'],
    ['a: [- x]', 1, 'a list item can not start here'],
  ])('refuses %j at line %i', (text, line, message) => {
    const e = errorOf(text);
    expect(e.line).toBe(line);
    expect(e.message).toContain(message);
    expect(e.message).toMatch(/^line \d+, column \d+: /);
  });

  describe('nesting depth', () => {
    const deepest = (v: YamlValue, key: string | number): number => {
      let n = 0;
      for (let cur: YamlValue | undefined = v; cur !== null && typeof cur === 'object'; n++) {
        cur = (cur as Record<string | number, YamlValue>)[key];
      }
      return n;
    };
    const blockMapping = (n: number) =>
      Array.from({ length: n }, (_, i) => `${' '.repeat(i * 2)}a:`).join('\n') + ' 1';
    const blockList = (n: number) =>
      Array.from({ length: n }, (_, i) => `${' '.repeat(i * 2)}-`).join('\n') + ' 1';

    it('reads collections nested up to the limit', () => {
      expect(deepest(value(blockMapping(64)), 'a')).toBe(64);
      expect(deepest(value(blockList(64)), 0)).toBe(64);
      const flow = value(`a: ${'['.repeat(63)}${']'.repeat(63)}`) as { a: YamlValue };
      expect(deepest(flow.a, 0)).toBe(63);
      expect(deepest(value(`${'- '.repeat(64)}x`), 0)).toBe(64);
    });

    it.each([
      ['block mappings', blockMapping(65), 65],
      ['block lists', blockList(65), 65],
      ['compact lists', `${'- '.repeat(65)}x`, 1],
      ['flow lists', `a: ${'['.repeat(65)}${']'.repeat(65)}`, 1],
      ['flow mappings', `a: ${'{b: '.repeat(65)}1${'}'.repeat(65)}`, 1],
    ])('refuses %s nested past the limit with a YamlError', (_name, text, line) => {
      const e = errorOf(text);
      expect(e.line).toBe(line);
      expect(e.message).toContain('nesting is deeper than 64 levels');
    });

    it('fails cleanly on input far deeper than the stack allows', () => {
      expect(errorOf(`${'- '.repeat(50000)}x`).message).toContain('nesting is deeper');
      expect(errorOf(`a: ${'['.repeat(100000)}`).message).toContain('nesting is deeper');
    });
  });

  it('reports the column of the problem', () => {
    const e = errorOf('flags:\n  a: [1, 2\n');
    expect([e.line, e.column]).toEqual([2, 6]);
    expect(errorOf('a: "\\q"').column).toBe(5);
  });
});

describe('stringifyYaml', () => {
  it('writes readable block YAML', () => {
    expect(
      stringifyYaml({
        version: 1,
        flags: {
          'new-checkout': {
            name: 'New checkout',
            on: true,
            variants: [
              { key: 'on', value: true },
              { key: 'off', value: false },
            ],
            rules: [],
            meta: {},
            nested: [[1, 2], [], 'x'],
            tricky: ['true', '1.5', '', 'a: b', 'x #y', ' lead', 'trail ', 'multi\nline', null],
          },
        },
      }),
    ).toBe(
      [
        'version: 1',
        'flags:',
        '  new-checkout:',
        '    name: New checkout',
        '    on: true',
        '    variants:',
        '      - key: on',
        '        value: true',
        '      - key: off',
        '        value: false',
        '    rules: []',
        '    meta: {}',
        '    nested:',
        '      -',
        '        - 1',
        '        - 2',
        '      - []',
        '      - x',
        '    tricky:',
        '      - "true"',
        '      - "1.5"',
        '      - ""',
        '      - "a: b"',
        '      - "x #y"',
        '      - " lead"',
        '      - "trail "',
        '      - "multi\\nline"',
        '      - null',
        '',
      ].join('\n'),
    );
    expect(stringifyYaml('x')).toBe('x\n');
    expect(stringifyYaml({ 'a key': 1, '': 2 })).toBe('"a key": 1\n"": 2\n');
  });

  it('round-trips any JSON value through parseYaml', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const json = JSON.parse(JSON.stringify(v)) as YamlValue;
        expect(parseYaml(stringifyYaml(json)).value).toEqual(json);
      }),
      { numRuns: 500 },
    );
  });
});
