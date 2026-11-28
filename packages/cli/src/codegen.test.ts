import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  camelCase,
  generateGo,
  generateTypeScript,
  goPackageName,
  goQuote,
  pascalCase,
  type CodegenFlag,
  type CodegenInput,
} from './codegen.js';
import { CliError } from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, '../..');

const FLAGS: CodegenFlag[] = [
  {
    key: 'new-checkout',
    name: 'New checkout',
    description: 'The */ new flow.\nSecond line.',
    type: 'boolean',
    clientSide: true,
    variants: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
  },
  {
    key: 'banner',
    name: 'banner',
    description: '',
    type: 'string',
    clientSide: false,
    variants: [
      { key: 'red', value: 'red "x"\\', name: 'Red' },
      { key: 'blue', value: 'blue' },
      { key: 'blue-again', value: 'blue' },
    ],
  },
  {
    key: '2fa.limit',
    name: 'Limit',
    description: '',
    type: 'number',
    clientSide: true,
    variants: [
      { key: 'low', value: 1 },
      { key: 'high', value: 10.5 },
    ],
  },
  {
    key: 'config',
    name: 'Config',
    description: '',
    type: 'json',
    clientSide: false,
    variants: [
      { key: 'a', value: { limit: 3, tags: ['x', 1], 'odd-key': null, nested: { on: true } } },
      { key: 'b', value: [] },
      { key: 'c', value: {} },
    ],
  },
  {
    key: 'theme',
    name: 'Theme',
    description: '',
    type: 'string',
    clientSide: true,
    variants: [
      { key: 'light', value: 'light' },
      { key: 'dark', value: 'dark' },
    ],
  },
];

const INPUT: CodegenInput = { project: 'shop', flags: FLAGS };

describe('names', () => {
  it('turns keys into identifiers', () => {
    expect(camelCase('new-checkout')).toBe('newCheckout');
    expect(camelCase('New_UI.banner')).toBe('newUIBanner');
    expect(camelCase('2fa.limit')).toBe('flag2faLimit');
    expect(pascalCase('new-checkout')).toBe('NewCheckout');
    expect(pascalCase('2fa.limit')).toBe('Flag2faLimit');
    expect(pascalCase('a')).toBe('A');
  });

  it('refuses keys that become the same name', () => {
    const clash = (flags: CodegenFlag[], go: boolean) => {
      try {
        if (go) generateGo({ project: 'p', flags }, 'flags');
        else generateTypeScript({ project: 'p', flags });
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        return (e as CliError).message;
      }
      throw new Error('expected a clash');
    };
    const base = FLAGS[0] as CodegenFlag;
    expect(
      clash(
        [
          { ...base, key: 'new-checkout' },
          { ...base, key: 'new_checkout' },
        ],
        false,
      ),
    ).toBe(
      'generated names clash: flag "new-checkout" and flag "new_checkout" both become newCheckout. Rename one of the flags or variants',
    );
    // A string flag "a" with variant "value" and the value type of flag "a" are both AValue.
    const a: CodegenFlag = {
      ...base,
      key: 'a',
      type: 'string',
      variants: [
        { key: 'value', value: 'v' },
        { key: 'other', value: 'o' },
      ],
    };
    expect(clash([a], true)).toContain(
      'the value type of flag "a" and variant "value" of "a" both become AValue',
    );
    expect(
      clash(
        [
          { ...base, key: 'keys-x' },
          { ...base, key: 'keys.x' },
        ],
        true,
      ),
    ).toContain('both become KeyKeysX');
  });

  it('checks Go package names and quotes Go strings', () => {
    expect(goPackageName('flags')).toBe(true);
    expect(goPackageName('my_flags2')).toBe(true);
    expect(goPackageName('Flags')).toBe(false);
    expect(goPackageName('func')).toBe(false);
    expect(goPackageName('2x')).toBe(false);
    expect(() => generateGo(INPUT, 'type')).toThrow('"type" is not a Go package name');
    expect(goQuote('a"b\\c\nd\te\rf\u0001\u007fé😀 ')).toBe(
      '"a\\"b\\\\c\\nd\\te\\rf\\x01\\x7fé😀\\u2028"',
    );
    expect(goQuote('\ud800x')).toBe('"\\uFFFDx"');
  });
});

describe('generateTypeScript', () => {
  it('is the same whatever order the flags come in', () => {
    expect(generateTypeScript({ ...INPUT, flags: [...FLAGS].reverse() })).toBe(
      generateTypeScript(INPUT),
    );
  });

  it('types each flag and keeps comments closed', () => {
    const code = generateTypeScript(INPUT);
    expect(code).toContain('  banner: "red \\"x\\"\\\\" | "blue";');
    expect(code).toContain('  "2fa.limit": number;');
    expect(code).toContain('  "new-checkout": boolean;');
    expect(code).toContain(
      'export const FLAG_KEYS: readonly FlagKey[] = ["2fa.limit", "banner", "config", "new-checkout", "theme"];',
    );
    expect(code).toContain('The *\\/ new flow.');
    expect(code).not.toMatch(/\*\/ new/);
  });

  it('compiles under strict settings against the real Node and browser clients', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flagship-codegen-ts-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(dir, 'flags.ts'), generateTypeScript(INPUT));
    writeFileSync(join(dir, 'empty.ts'), generateTypeScript({ project: 'empty', flags: [] }));
    writeFileSync(
      join(dir, 'use.ts'),
      [
        "import type { FlagshipClient } from '@flagship/node';",
        "import type { BrowserClient } from '@flagship/browser';",
        "import { browserFlags, serverFlags, FLAG_KEYS, type FlagKey, type FlagValues } from './flags.js';",
        "import { serverFlags as none } from './empty.js';",
        'declare const node: FlagshipClient;',
        'declare const browser: BrowserClient;',
        'const s = serverFlags(node);',
        "const ctx = { key: 'u1', plan: 'pro' };",
        'const checkout: boolean = s.newCheckout(ctx, false);',
        "const banner: 'blue' | 'red \"x\"\\\\' = s.banner(ctx, 'blue');",
        'const limit: number = s.flag2faLimit(ctx, 0);',
        'const config: FlagValues["config"] = s.config(ctx, []);',
        "if (!Array.isArray(config) && 'limit' in config) { const n: number = config.limit; void n; }",
        '// @ts-expect-error a value the flag does not have',
        "s.banner(ctx, 'green');",
        '// @ts-expect-error a server context is required',
        's.newCheckout(false);',
        'const b = browserFlags(browser);',
        "const theme: 'light' | 'dark' = b.theme('light');",
        'const limit2: number = b.flag2faLimit(1);',
        '// @ts-expect-error banner is not a client-side flag',
        "b.banner('blue');",
        "const k: FlagKey = 'theme';",
        '// @ts-expect-error not a flag',
        "const bad: FlagKey = 'nope';",
        'const empty: Record<string, never> = none(node);',
        'export const all = [checkout, banner, limit, theme, limit2, k, bad, empty, FLAG_KEYS];',
        '',
      ].join('\n'),
    );
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2023,
      lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      customConditions: ['@flagship/source'],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitReturns: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
      typeRoots: [resolve(packages, '../node_modules/@types')],
      paths: {
        '@flagship/node': [resolve(packages, 'sdk-node/src/index.ts')],
        '@flagship/browser': [resolve(packages, 'sdk-browser/src/index.ts')],
      },
    };
    const program = ts.createProgram([join(dir, 'use.ts')], options);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it('serves what the client serves, and the fallback for unknown string values', async () => {
    const { outputText } = ts.transpileModule(generateTypeScript(INPUT), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    });
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
    )) as {
      serverFlags: (c: unknown) => Record<string, (...a: unknown[]) => unknown>;
      browserFlags: (c: unknown) => Record<string, (...a: unknown[]) => unknown>;
      FLAG_KEYS: string[];
    };
    const served: Record<string, unknown> = {
      banner: 'green',
      theme: 'dark',
      'new-checkout': true,
      '2fa.limit': 10.5,
      config: { limit: 3 },
    };
    const calls: unknown[][] = [];
    const server = {
      boolVariation: (k: string, c: unknown, f: unknown) => (
        calls.push(['bool', k, c, f]),
        served[k]
      ),
      stringVariation: (k: string, c: unknown, f: unknown) => (
        calls.push(['string', k, c, f]),
        served[k]
      ),
      numberVariation: (k: string, c: unknown, f: unknown) => (
        calls.push(['number', k, c, f]),
        served[k]
      ),
      jsonVariation: (k: string, c: unknown, f: unknown) => (
        calls.push(['json', k, c, f]),
        served[k]
      ),
    };
    const s = mod.serverFlags(server);
    const ctx = { key: 'u' };
    expect(s.newCheckout?.(ctx, false)).toBe(true);
    expect(s.banner?.(ctx, 'blue')).toBe('blue');
    served.banner = 'red "x"\\';
    expect(s.banner?.(ctx, 'blue')).toBe('red "x"\\');
    expect(s.flag2faLimit?.(ctx, 0)).toBe(10.5);
    expect(s.config?.(ctx, [])).toEqual({ limit: 3 });
    expect(calls[0]).toEqual(['bool', 'new-checkout', ctx, false]);
    expect(calls[1]).toEqual(['string', 'banner', ctx, 'blue']);
    const browser = {
      boolVariation: (k: string) => served[k],
      stringVariation: (k: string) => served[k],
      numberVariation: (k: string) => served[k],
      jsonVariation: (k: string) => served[k],
    };
    const b = mod.browserFlags(browser);
    expect(Object.keys(b).sort()).toEqual(['flag2faLimit', 'newCheckout', 'theme']);
    expect(b.theme?.('light')).toBe('dark');
    served.theme = 'sepia';
    expect(b.theme?.('light')).toBe('light');
    expect(mod.FLAG_KEYS).toEqual(['2fa.limit', 'banner', 'config', 'new-checkout', 'theme']);
  });
});

describe('generateGo', () => {
  it('is gofmt-clean and passes go vet and a test against a fake evaluator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flagship-codegen-go-'));
    mkdirSync(join(dir, 'flags'));
    mkdirSync(join(dir, 'empty'));
    writeFileSync(join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
    writeFileSync(join(dir, 'flags', 'flags.go'), generateGo(INPUT, 'flags'));
    writeFileSync(join(dir, 'empty', 'empty.go'), generateGo({ project: 'e', flags: [] }, 'empty'));
    writeFileSync(
      join(dir, 'flags', 'flags_test.go'),
      `package flags

import "testing"

type ctx struct{ key string }

type fake struct {
	served map[string]any
	calls  []string
}

func (f *fake) BoolVariation(k string, c ctx, d bool) bool {
	f.calls = append(f.calls, "bool "+k+" "+c.key)
	if v, ok := f.served[k].(bool); ok {
		return v
	}
	return d
}

func (f *fake) StringVariation(k string, c ctx, d string) string {
	f.calls = append(f.calls, "string "+k+" "+d)
	if v, ok := f.served[k].(string); ok {
		return v
	}
	return d
}

func (f *fake) NumberVariation(k string, c ctx, d float64) float64 {
	if v, ok := f.served[k].(float64); ok {
		return v
	}
	return d
}

func (f *fake) JSONVariation(k string, c ctx, d any) any {
	if v, ok := f.served[k]; ok {
		return v
	}
	return d
}

func TestAccessors(t *testing.T) {
	e := &fake{served: map[string]any{
		"new-checkout": true, "banner": "green", "theme": "dark", "2fa.limit": 10.5,
		"config": map[string]any{"limit": 3},
	}}
	f := New[ctx](e)
	u := ctx{key: "u1"}
	if !f.NewCheckout(u, false) {
		t.Fatal("new-checkout")
	}
	if got := f.Banner(u, BannerBlue); got != BannerBlue {
		t.Fatalf("an unknown value must give the fallback, got %q", got)
	}
	e.served["banner"] = "red \\"x\\"\\\\"
	if got := f.Banner(u, BannerBlue); got != BannerRed {
		t.Fatalf("banner = %q", got)
	}
	if BannerBlueAgain != BannerBlue {
		t.Fatal("variants with one value share it")
	}
	if got := f.Theme(u, ThemeLight); got != ThemeDark {
		t.Fatalf("theme = %q", got)
	}
	if got := f.Flag2faLimit(u, 0); got != 10.5 {
		t.Fatalf("limit = %v", got)
	}
	if got := f.Config(u, nil).(map[string]any)["limit"]; got != 3 {
		t.Fatalf("config = %v", got)
	}
	if KeyFlag2faLimit != "2fa.limit" || len(Keys) != 5 || Keys[0] != KeyFlag2faLimit {
		t.Fatalf("keys = %v", Keys)
	}
	if e.calls[0] != "bool new-checkout u1" || e.calls[1] != "string banner blue" {
		t.Fatalf("calls = %v", e.calls)
	}
}
`,
    );
    const env = {
      ...process.env,
      GOFLAGS: '-mod=mod',
      GOTOOLCHAIN: 'local',
      GOCACHE: join(dir, '.cache'),
      GOPATH: join(dir, '.gopath'),
    };
    const go = (...args: string[]) =>
      execFileSync('go', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
    expect(execFileSync('gofmt', ['-l', '.'], { cwd: dir, encoding: 'utf8' })).toBe('');
    go('vet', './...');
    expect(go('test', './flags')).toMatch(/^ok/);
  }, 120_000);

  it('documents each accessor and names the package', () => {
    const code = generateGo(INPUT, 'flags');
    expect(code.split('\n')[0]).toBe(
      '// Code generated by flagship codegen from project "shop". DO NOT EDIT.',
    );
    expect(code).toContain('package flags\n');
    expect(code).toContain(
      [
        '// NewCheckout returns flag "new-checkout" (boolean): New checkout.',
        '// The */ new flow. Second line.',
        '// Variants: on = true, off = false.',
        'func (f Flags[C]) NewCheckout(context C, fallback bool) bool {',
      ].join('\n'),
    );
    expect(code).toContain('\tcase BannerRed, BannerBlue:\n');
    expect(code).toContain('\tBannerBlueAgain BannerValue = "blue"\n');
  });
});

describe('random flags', () => {
  /** A small deterministic generator, so a failure reproduces. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  function randomInput(seed: number): CodegenInput {
    const r = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const word = () =>
      Array.from({ length: 1 + Math.floor(r() * 6) }, () =>
        ALNUM.charAt(Math.floor(r() * ALNUM.length)),
      ).join('');
    const key = () =>
      Array.from({ length: 1 + Math.floor(r() * 3) }, word).join(pick(['-', '_', '.', '--']));
    const text = () =>
      pick([
        '',
        'Plain text.',
        'Heading\n\nParagraph\n  indented code\n- list item\n# hash',
        '1. first\n\t2. tabbed */ /* `back` "quote" \\   é 😀',
        '   ',
        'Trailing   \n\n\n',
      ]);
    const strings = ['', ' ', 'a"b', 'back\\slash', 'new\nline', 'tab\t', 'é😀', '\u0000', 'x'];
    const json = (depth: number): unknown => {
      const k = Math.floor(r() * (depth > 2 ? 4 : 6));
      if (k === 0) return null;
      if (k === 1) return r() < 0.5;
      if (k === 2) return Math.floor(r() * 1000) / 10;
      if (k === 3) return pick(strings);
      if (k === 4) return Array.from({ length: Math.floor(r() * 3) }, () => json(depth + 1));
      return Object.fromEntries(
        Array.from({ length: Math.floor(r() * 3) }, () => [
          pick([key(), 'a b', '', 'x']),
          json(depth + 1),
        ]),
      );
    };
    const flags = new Map<string, CodegenFlag>();
    const names = new Set<string>();
    while (flags.size < 60) {
      const type = pick(['boolean', 'string', 'number', 'json'] as const);
      const k = key();
      const variants =
        type === 'boolean'
          ? [
              { key: 'on', value: true },
              { key: 'off', value: false },
            ]
          : Array.from({ length: 2 + Math.floor(r() * 3) }, (_, i) => ({
              key: `${word()}${i}`,
              value:
                type === 'string'
                  ? pick(strings) + String(i % 2)
                  : type === 'number'
                    ? i - r() * 100
                    : json(0),
            }));
      // Keep only flags whose generated names are all new, as a real project must.
      const own = [
        camelCase(k),
        `Key${pascalCase(k)}`,
        `${pascalCase(k)}Value`,
        ...variants.map((v) => pascalCase(k) + pascalCase(v.key)),
      ];
      if (own.some((n) => names.has(n)) || new Set(own).size !== own.length) continue;
      for (const n of own) names.add(n);
      flags.set(k, {
        key: k,
        name: text() || k,
        description: text(),
        type,
        clientSide: r() < 0.5,
        variants,
      });
    }
    return { project: 'rand"om', flags: [...flags.values()] };
  }

  it('stay gofmt-clean, vet-clean and strictly typed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flagship-codegen-rand-'));
    writeFileSync(join(dir, 'go.mod'), 'module example.com/rand\n\ngo 1.22\n');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const roots: string[] = [];
    for (let seed = 1; seed <= 5; seed++) {
      const input = randomInput(seed);
      mkdirSync(join(dir, `p${seed}`));
      writeFileSync(join(dir, `p${seed}`, 'flags.go'), generateGo(input, `p${seed}`));
      writeFileSync(join(dir, `flags${seed}.ts`), generateTypeScript(input));
      roots.push(join(dir, `flags${seed}.ts`));
    }
    expect(execFileSync('gofmt', ['-l', '.'], { cwd: dir, encoding: 'utf8' })).toBe('');
    execFileSync('go', ['vet', './...'], {
      cwd: dir,
      env: {
        ...process.env,
        GOTOOLCHAIN: 'local',
        GOCACHE: join(dir, '.cache'),
        GOPATH: join(dir, '.gopath'),
      },
      stdio: 'pipe',
    });
    const program = ts.createProgram(roots, {
      target: ts.ScriptTarget.ES2023,
      lib: ['lib.es2023.d.ts'],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noEmit: true,
      types: [],
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  }, 120_000);
});
