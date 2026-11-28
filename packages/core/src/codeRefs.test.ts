import { describe, expect, it } from 'vitest';
import { codeHunkSchema, codePathSchema, codeReferenceUrl } from './codeRefs.js';

describe('code reference links', () => {
  const at = { commit: 'abc1234', branch: 'feature/a b', path: 'src/a b/#x.ts', line: 12 };

  it('fills the template, encoding each part but keeping path slashes', () => {
    expect(codeReferenceUrl('https://h/{branch}/{commit}/{path}#L{line}', at)).toBe(
      'https://h/feature/a%20b/abc1234/src/a%20b/%23x.ts#L12',
    );
    expect(codeReferenceUrl('https://h/{commit}', { ...at, commit: null })).toBe(
      'https://h/feature%2Fa%20b',
    );
    expect(codeReferenceUrl(null, at)).toBeNull();
    expect(codeReferenceUrl(undefined, at)).toBeNull();
    expect(codeReferenceUrl('https://h/{other}', at)).toBe('https://h/{other}');
  });
});

describe('code reference schemas', () => {
  it('accepts relative paths only', () => {
    for (const ok of ['a', 'a/b.ts', '.github/x.yml', 'a..b']) {
      expect(codePathSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', '/a', 'a/', 'a//b', './a', 'a/../b', 'a\\b', 'a\nb']) {
      expect(codePathSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('keeps match lines ascending and within the lines sent', () => {
    const h = { path: 'a', startLine: 5, lines: ['x', 'y'], matchLines: [5, 6] };
    expect(codeHunkSchema.safeParse(h).success).toBe(true);
    expect(codeHunkSchema.safeParse({ ...h, matchLines: [4] }).success).toBe(false);
    expect(codeHunkSchema.safeParse({ ...h, matchLines: [7] }).success).toBe(false);
    expect(codeHunkSchema.safeParse({ ...h, matchLines: [6, 6] }).success).toBe(false);
    expect(codeHunkSchema.safeParse({ ...h, lines: [], matchLines: [1, 900] }).success).toBe(true);
    expect(codeHunkSchema.safeParse({ ...h, matchLines: [] }).success).toBe(false);
  });
});
