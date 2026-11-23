import { describe, expect, it } from 'vitest';
import {
  FlagsFileError,
  defaultOffVariant,
  readFlagsFile,
  writeFlagsFile,
  type FileIssue,
  type LiveFlag,
} from './flagsfile.js';

const read = (lines: string[]) =>
  readFlagsFile(`${lines.join('\n')}\n`, 'flags.yaml', 'flags.yaml');

function issues(lines: string[]): FileIssue[] {
  try {
    read(lines);
  } catch (e) {
    if (e instanceof FlagsFileError) return e.issues;
    throw e;
  }
  throw new Error('expected a FlagsFileError');
}

describe('readFlagsFile', () => {
  it('fills in defaults and expands serve shorthand', () => {
    const f = read([
      'version: 1',
      'flags:',
      '  plain:',
      '  checkout:',
      '    environments:',
      '      development:',
      '        enabled: true',
      '        rules:',
      '          - id: staff',
      '            clauses: [{ attribute: email, operator: endsWith, values: ["@acme.com"] }]',
      '            serve: on',
      '        fallthrough: { rollout: { variants: [{ variant: on, weight: 10000 }, { variant: off, weight: 90000 }] } }',
      '      production:',
      '      staging: {}',
    ]);
    expect(f).toMatchObject({ file: 'flags.yaml', source: 'flags.yaml', project: undefined });
    expect(f.flags).toEqual([
      {
        key: 'plain',
        name: 'plain',
        description: '',
        type: 'boolean',
        clientSide: false,
        variants: [
          { key: 'on', value: true },
          { key: 'off', value: false },
        ],
        environments: {},
      },
      {
        key: 'checkout',
        name: 'checkout',
        description: '',
        type: 'boolean',
        clientSide: false,
        variants: [
          { key: 'on', value: true },
          { key: 'off', value: false },
        ],
        environments: {
          development: {
            enabled: true,
            offVariant: 'off',
            prerequisites: [],
            rules: [
              {
                id: 'staff',
                clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
                serve: { variant: 'on' },
              },
            ],
            fallthrough: {
              rollout: {
                variants: [
                  { variant: 'on', weight: 10000 },
                  { variant: 'off', weight: 90000 },
                ],
              },
            },
          },
          production: {
            enabled: false,
            offVariant: 'off',
            prerequisites: [],
            rules: [],
            fallthrough: { variant: 'off' },
          },
          staging: {
            enabled: false,
            offVariant: 'off',
            prerequisites: [],
            rules: [],
            fallthrough: { variant: 'off' },
          },
        },
      },
    ]);
  });

  it('takes the project and source from the file', () => {
    const f = read(['version: 1', 'project: web', 'source: github.com/acme/web/flags.yaml']);
    expect(f).toMatchObject({
      project: 'web',
      source: 'github.com/acme/web/flags.yaml',
      flags: [],
    });
    expect(f.lineOf('source')).toBe(3);
  });

  it('reports every schema problem at its line', () => {
    expect(
      issues([
        'version: 2', // 1
        'flags:', // 2
        '  a:', // 3
        '    nmae: typo', // 4
        '    type: text', // 5
        '    environments:', // 6
        '      development:', // 7
        '        fallthrough: { variant: 1 }', // 8
        '  "bad key!": {}', // 9
      ]),
    ).toEqual([
      { file: 'flags.yaml', line: 1, path: 'version', message: 'must be 1' },
      { file: 'flags.yaml', line: 4, path: 'flags.a.nmae', message: 'unknown field "nmae"' },
      {
        file: 'flags.yaml',
        line: 5,
        path: 'flags.a.type',
        message: expect.stringContaining('expected one of'),
      },
      {
        file: 'flags.yaml',
        line: 8,
        path: 'flags.a.environments.development.fallthrough.variant',
        message: expect.stringContaining('expected string'),
      },
      {
        file: 'flags.yaml',
        line: 9,
        path: 'flags.bad key!',
        message: expect.stringContaining('must start with a letter or digit'),
      },
    ]);
  });

  it('needs variants for non-boolean flags and a fallthrough when enabled', () => {
    expect(
      issues([
        'version: 1',
        'flags:',
        '  theme:',
        '    type: string',
        '  on-flag:',
        '    environments:',
        '      production: { enabled: true }',
      ]),
    ).toEqual([
      {
        file: 'flags.yaml',
        line: 4,
        path: 'flags.theme.type',
        message: 'string flags need variants',
      },
      {
        file: 'flags.yaml',
        line: 7,
        path: 'flags.on-flag.environments.production.enabled',
        message: 'an enabled flag needs a fallthrough: what everyone no rule matches gets',
      },
    ]);
  });

  it('turns YAML errors and non-mapping documents into file issues', () => {
    expect(issues(['version: 1', 'flags: [unclosed'])).toEqual([
      {
        file: 'flags.yaml',
        line: 2,
        path: '',
        message: 'column 8: a [ list ] must close on the same line',
      },
    ]);
    expect(issues(['- just', '- a list'])[0]?.message).toContain('must be a mapping');
    expect(issues([])[0]?.message).toContain('must be a mapping');
    const e = (() => {
      try {
        read(['version: 1', 'flags: [x', '']);
      } catch (err) {
        return err as FlagsFileError;
      }
      return undefined;
    })();
    expect(e?.message).toBe('flags.yaml has a problem');
    expect(e?.code).toBe('invalid_flags_file');
    try {
      read(['version: 2', 'extra: 1']);
    } catch (err) {
      expect((err as FlagsFileError).message).toBe('flags.yaml has 2 problems');
    }
  });
});

describe('writeFlagsFile', () => {
  const live: LiveFlag[] = [
    {
      key: 'checkout',
      name: 'checkout',
      description: '',
      type: 'boolean',
      clientSide: false,
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      environments: {
        development: {
          enabled: false,
          offVariant: 'off',
          prerequisites: [],
          rules: [],
          fallthrough: { variant: 'off' },
        },
      },
    },
    {
      key: 'pricing',
      name: 'Pricing',
      description: 'What things cost',
      type: 'json',
      clientSide: true,
      variants: [
        { key: 'a', value: { price: 10 } },
        { key: 'b', value: { price: 12 }, name: 'Twelve' },
      ],
      environments: {
        production: {
          enabled: true,
          offVariant: 'b',
          prerequisites: [{ flag: 'checkout', variant: 'on' }],
          rules: [
            {
              id: 'nz',
              clauses: [{ attribute: 'country', operator: 'in', values: ['NZ'] }],
              serve: { variant: 'b' },
            },
            {
              id: 'split',
              clauses: [{ attribute: 'plan', operator: 'equals', values: ['pro'] }],
              serve: {
                rollout: {
                  variants: [
                    { variant: 'a', weight: 50000 },
                    { variant: 'b', weight: 50000 },
                  ],
                },
              },
            },
          ],
          fallthrough: { variant: 'a' },
        },
        staging: {
          enabled: false,
          offVariant: 'a',
          prerequisites: [],
          rules: [],
          fallthrough: { variant: 'b' },
        },
      },
    },
  ];

  it('writes only what differs from the defaults, and reads back to the same flags', () => {
    const text = writeFlagsFile(live, { project: 'web', source: 'flags.yaml' });
    expect(text).toContain('version: 1\nproject: web\nsource: flags.yaml\nflags:\n  checkout:\n');
    expect(text).toContain('    environments:\n      development: {}\n');
    expect(text).toContain('        fallthrough: a\n');
    expect(text).toContain('            serve: b\n');
    expect(text).not.toContain('clientSide: false');
    const back = readFlagsFile(text, 'flags.yaml', 'x');
    expect(back.project).toBe('web');
    expect(back.flags).toEqual(live);
    expect(writeFlagsFile([], {})).toBe(
      '# Flags managed as code. Edit, then run: flagship plan, flagship apply.\nversion: 1\nflags: {}\n',
    );
  });

  it('picks the off variant the server would', () => {
    expect(
      defaultOffVariant([
        { key: 'x', value: 1 },
        { key: 'no', value: false },
      ]),
    ).toBe('no');
    expect(defaultOffVariant([{ key: 'x', value: 1 }])).toBe('x');
    expect(defaultOffVariant([])).toBe('off');
  });
});
