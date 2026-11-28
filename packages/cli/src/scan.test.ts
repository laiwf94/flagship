import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODE_REFERENCE_LIMITS, codeReferencesUploadSchema } from '@flagship/core';
import { describe, expect, it } from 'vitest';
import { scan } from './scan.js';
import { findReferences, scanBatch, type FindOptions } from './scanWorker.js';

const O: FindOptions = { context: 1, lineLength: 40, linesPerHunk: 8 };
const keys = new Set(['new-checkout', 'banner', 'a.b_c']);

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'flagship-scan-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('finding references in a file', () => {
  it('finds keys in single quotes, double quotes and backticks, with line numbers', () => {
    const text = [
      "import x from 'y';", // 1
      "if (flags.get('new-checkout')) {}", // 2
      'const b = "banner";', // 3
      '', // 4
      'tpl(`a.b_c`) + `banner`', // 5
      'not new-checkout, nor "new-checkout-2", nor \'Banner\'', // 6
    ].join('\n');
    const r = findReferences('src/x.ts', text, keys, { ...O, context: 0 });
    expect(r.flags).toEqual([
      {
        key: 'new-checkout',
        count: 1,
        hunks: [
          {
            path: 'src/x.ts',
            startLine: 2,
            lines: ["if (flags.get('new-checkout')) {}"],
            matchLines: [2],
          },
        ],
      },
      {
        key: 'banner',
        count: 2,
        hunks: [
          { path: 'src/x.ts', startLine: 3, lines: ['const b = "banner";'], matchLines: [3] },
          { path: 'src/x.ts', startLine: 5, lines: ['tpl(`a.b_c`) + `banner`'], matchLines: [5] },
        ],
      },
      {
        key: 'a.b_c',
        count: 1,
        hunks: [
          { path: 'src/x.ts', startLine: 5, lines: ['tpl(`a.b_c`) + `banner`'], matchLines: [5] },
        ],
      },
    ]);
  });

  it('finds adjacent strings that share no quote, and counts repeats on one line', () => {
    const r = findReferences('a.go', `x := []string{"other","banner","banner"}`, keys, O);
    expect(r.flags).toEqual([
      { key: 'banner', count: 2, hunks: [expect.objectContaining({ matchLines: [1] })] },
    ]);
    expect(findReferences('a', `"x" banner"`, keys, O).flags).toEqual([]);
    expect(findReferences('a', 'nothing here', keys, O)).toEqual({ path: 'a', flags: [] });
  });

  it('merges nearby references into one hunk with context, and splits long runs', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    for (const n of [5, 7, 20, 21, 22, 23, 24, 25, 26, 27, 28]) lines[n - 1] = `use('banner') ${n}`;
    lines[29] = `${'x'.repeat(50)}'banner'\r`;
    const r = findReferences('f.ts', lines.join('\n'), keys, O);
    const hunks = r.flags[0]!.hunks;
    expect(r.flags[0]!.count).toBe(12);
    expect(hunks.map((h) => [h.startLine, h.lines.length, h.matchLines])).toEqual([
      [4, 5, [5, 7]],
      [19, 8, [20, 21, 22, 23, 24, 25]],
      [25, 6, [26, 27, 28, 30]],
    ]);
    // Long lines are cut, and a CR before the newline is dropped.
    expect(hunks[2]!.lines[5]).toBe('x'.repeat(40));
    for (const h of hunks) {
      expect(h.lines.length).toBeLessThanOrEqual(O.linesPerHunk);
      for (const m of h.matchLines) expect(h.lines[m - h.startLine]).toMatch(/banner|x{40}/);
    }
    // Context is clipped at the start and end of the file.
    const edge = findReferences('e', "'banner'\nx\n'banner'", keys, { ...O, context: 5 });
    expect(edge.flags[0]!.hunks).toEqual([
      { path: 'e', startLine: 1, lines: ["'banner'", 'x', "'banner'"], matchLines: [1, 3] },
    ]);
  });

  it('sends no source with context -1, still grouping line numbers', () => {
    const text = Array.from({ length: 20 }, () => "'banner'").join('\n');
    const r = findReferences('f', text, keys, { ...O, context: -1 });
    expect(r.flags[0]!.hunks).toEqual([
      { path: 'f', startLine: 1, lines: [], matchLines: [1, 2, 3, 4, 5, 6, 7, 8] },
      { path: 'f', startLine: 9, lines: [], matchLines: [9, 10, 11, 12, 13, 14, 15, 16] },
      { path: 'f', startLine: 17, lines: [], matchLines: [17, 18, 19, 20] },
    ]);
  });

  it('skips binary, oversized and unreadable files in a batch', () => {
    const root = tree({
      'ok.ts': "'banner'",
      'bin.dat': Buffer.from([0x27, 0x62, 0x00, 0x27]),
      'big.ts': `'banner'${' '.repeat(200)}`,
    });
    const r = scanBatch(
      { kind: 'flagship-scan', root, keys: [...keys], maxFileBytes: 100, options: O },
      keys,
      { id: 3, paths: ['ok.ts', 'bin.dat', 'big.ts', 'missing.ts'] },
    );
    expect(r).toEqual({
      id: 3,
      files: [{ path: 'ok.ts', flags: [expect.objectContaining({ key: 'banner', count: 1 })] }],
      skipped: 3,
      bytes: 8,
    });
  });
});

describe('scanning a tree on worker threads', () => {
  it('honours .gitignore, merges results in path order and fits the upload schema', async () => {
    const files: Record<string, string> = {
      '.gitignore': 'dist/\n*.min.js\n',
      'dist/bundle.js': "'banner'",
      'app.min.js': "'banner'",
      'README.md': 'Turn on `new-checkout` first.',
      'logo.png': '\u0000PNG banner',
    };
    for (let i = 0; i < 700; i++) {
      files[`src/m${String(i).padStart(3, '0')}.ts`] =
        i % 100 === 0
          ? `export const on = flags.get('banner') // ${i}\n`
          : `export const n = ${i};\n`;
    }
    const root = tree(files);
    const r = await scan({ root, keys: [...keys], context: 2, workers: 3 });
    expect(r.filesScanned).toBe(702);
    expect(r.filesSkipped).toBe(1);
    // 703 files are six batches: the first worker queues four before a second starts.
    expect(r.workers).toBe(2);
    expect(Object.keys(r.references)).toEqual(['banner', 'new-checkout']);
    expect(r.references.banner!.count).toBe(7);
    expect(r.references.banner!.hunks.map((h) => h.path)).toEqual(
      ['000', '100', '200', '300', '400', '500', '600'].map((n) => `src/m${n}.ts`),
    );
    expect(r.references['new-checkout']).toEqual({
      count: 1,
      hunks: [
        {
          path: 'README.md',
          startLine: 1,
          lines: ['Turn on `new-checkout` first.'],
          matchLines: [1],
        },
      ],
    });
    expect(r.hunksDropped).toBe(0);
    expect(r.bytesScanned).toBeGreaterThan(0);
    const upload = codeReferencesUploadSchema.safeParse({
      repository: 'local',
      branch: 'main',
      filesScanned: r.filesScanned,
      references: r.references,
    });
    expect(upload.success, JSON.stringify(upload.error)).toBe(true);
  });

  it('runs on one thread for a small tree and finds nothing without keys', async () => {
    const root = tree({ 'a.ts': "'banner'" });
    const one = await scan({ root, keys: ['banner'], context: 0 });
    expect(one.workers).toBe(1);
    expect(one.references).toEqual({
      banner: {
        count: 1,
        hunks: [{ path: 'a.ts', startLine: 1, lines: ["'banner'"], matchLines: [1] }],
      },
    });
    const none = await scan({ root, keys: [], context: 0, exclude: ['*.ts'] });
    expect(none).toMatchObject({ filesScanned: 0, workers: 0, references: {} });
  });

  it('keeps hunks within the per-flag limit, keeping every count', async () => {
    const files: Record<string, string> = {};
    const n = CODE_REFERENCE_LIMITS.hunksPerFlag + 20;
    for (let i = 0; i < n; i++) files[`f${String(i).padStart(4, '0')}.ts`] = "'banner'";
    const r = await scan({ root: tree(files), keys: ['banner'], context: 0, workers: 2 });
    expect(r.references.banner!.count).toBe(n);
    expect(r.references.banner!.hunks).toHaveLength(CODE_REFERENCE_LIMITS.hunksPerFlag);
    expect(r.references.banner!.hunks[0]!.path).toBe('f0000.ts');
    expect(r.hunksDropped).toBe(20);
    expect(r.filesScanned).toBe(n);
  });
});
