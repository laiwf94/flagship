import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isIgnored, parseIgnoreFile, parseIgnoreLine } from './gitignore.js';
import { walk } from './scan.js';

const ignored = (patterns: string, path: string, isDir = false) =>
  isIgnored([parseIgnoreFile(patterns, '')], path, isDir);

describe('gitignore patterns', () => {
  it('skips blanks and comments, and keeps escaped specials', () => {
    expect(parseIgnoreLine('')).toBeNull();
    expect(parseIgnoreLine('   ')).toBeNull();
    expect(parseIgnoreLine('# comment')).toBeNull();
    expect(parseIgnoreLine('/')).toBeNull();
    expect(ignored('\\#notes', '#notes')).toBe(true);
    expect(ignored('\\!important', '!important')).toBe(true);
    expect(ignored('trailing   ', 'trailing')).toBe(true);
    expect(ignored('space\\ ', 'space ')).toBe(true);
    expect(ignored('crlf\r', 'crlf')).toBe(true);
  });

  it('matches a name without slashes at any depth', () => {
    expect(ignored('*.log', 'a.log')).toBe(true);
    expect(ignored('*.log', 'deep/er/b.log')).toBe(true);
    expect(ignored('*.log', 'a.log.txt')).toBe(false);
    expect(ignored('build', 'x/build', true)).toBe(true);
    expect(ignored('build', 'x/build')).toBe(true);
    expect(ignored('?.ts', 'a.ts')).toBe(true);
    expect(ignored('?.ts', 'ab.ts')).toBe(false);
  });

  it('anchors patterns with a slash to the file that holds them', () => {
    expect(ignored('/dist', 'dist', true)).toBe(true);
    expect(ignored('/dist', 'pkg/dist', true)).toBe(false);
    expect(ignored('doc/*.txt', 'doc/a.txt')).toBe(true);
    expect(ignored('doc/*.txt', 'doc/sub/a.txt')).toBe(false);
    expect(ignored('doc/*.txt', 'x/doc/a.txt')).toBe(false);
    const nested = [parseIgnoreFile('/gen\n*.tmp', 'pkg')];
    expect(isIgnored(nested, 'pkg/gen', true)).toBe(true);
    expect(isIgnored(nested, 'gen', true)).toBe(false);
    expect(isIgnored(nested, 'pkg/a/b.tmp', false)).toBe(true);
    expect(isIgnored(nested, 'other/b.tmp', false)).toBe(false);
    expect(isIgnored(nested, 'pkgx/b.tmp', false)).toBe(false);
  });

  it('matches directories only with a trailing slash', () => {
    expect(ignored('cache/', 'cache', true)).toBe(true);
    expect(ignored('cache/', 'cache', false)).toBe(false);
    expect(ignored('a/cache/', 'a/cache', true)).toBe(true);
  });

  it('handles ** before, between and after path parts', () => {
    expect(ignored('**/foo', 'foo')).toBe(true);
    expect(ignored('**/foo', 'a/b/foo')).toBe(true);
    expect(ignored('**/foo/bar', 'x/foo/bar')).toBe(true);
    expect(ignored('a/**/b', 'a/b')).toBe(true);
    expect(ignored('a/**/b', 'a/x/y/b')).toBe(true);
    expect(ignored('a/**/b', 'a/xb')).toBe(false);
    expect(ignored('abc/**', 'abc/x/y')).toBe(true);
    expect(ignored('abc/**', 'abc', true)).toBe(false);
    // Asterisks next to other characters are ordinary stars.
    expect(ignored('a**z', 'abcz')).toBe(true);
    expect(ignored('x/a**z', 'x/ab/cz')).toBe(false);
  });

  it('supports bracket expressions, including negation, ranges and classes', () => {
    expect(ignored('[ab].ts', 'a.ts')).toBe(true);
    expect(ignored('[ab].ts', 'c.ts')).toBe(false);
    expect(ignored('[!ab].ts', 'c.ts')).toBe(true);
    expect(ignored('[^ab].ts', 'a.ts')).toBe(false);
    expect(ignored('[a-c]x', 'bx')).toBe(true);
    expect(ignored('[a-c]x', 'dx')).toBe(false);
    expect(ignored('[-a]x', '-x')).toBe(true);
    expect(ignored('[a-]x', '-x')).toBe(true);
    expect(ignored('[!-]x', 'ax')).toBe(true);
    expect(ignored('[!-]x', '-x')).toBe(false);
    expect(ignored('[]]x', ']x')).toBe(true);
    expect(ignored('[[:digit:]].log', '7.log')).toBe(true);
    expect(ignored('[[:digit:]].log', 'a.log')).toBe(false);
    expect(ignored('[\\]]', ']')).toBe(true);
    // An unclosed bracket is a literal.
    expect(ignored('[abc', '[abc')).toBe(true);
    // Regex characters mean themselves.
    expect(ignored('a+b(c).{d}|$^', 'a+b(c).{d}|$^')).toBe(true);
    expect(ignored('a.b', 'axb')).toBe(false);
  });

  it('lets the last match win, and deeper files override shallower ones', () => {
    expect(ignored('*.log\n!keep.log', 'keep.log')).toBe(false);
    expect(ignored('!keep.log\n*.log', 'keep.log')).toBe(true);
    const files = [parseIgnoreFile('*.log', ''), parseIgnoreFile('!keep.log', 'sub')];
    expect(isIgnored(files, 'sub/keep.log', false)).toBe(false);
    expect(isIgnored(files, 'keep.log', false)).toBe(true);
    expect(isIgnored(files, 'sub/other.log', false)).toBe(true);
  });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'flagship-ignore-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function walked(root: string, exclude: string[] = []): string[] {
  const out: string[] = [];
  walk(root, exclude, (p) => out.push(p));
  return out;
}

describe('walking a tree', () => {
  const files: Record<string, string> = {
    '.gitignore': [
      '# build output',
      '/dist/',
      'node_modules/',
      '*.log',
      '!important.log',
      'logs/',
      '!logs/keep.txt',
      'docs/**/draft-*',
      '[Tt]emp*',
      'secret.env ',
      '\\#hash',
    ].join('\n'),
    'src/a.ts': '',
    'src/b.log': '',
    'src/important.log': '',
    'src/#hash': '',
    'src/.gitignore': '/generated\n!b.log\nlocal-*\n',
    'src/generated/x.ts': '',
    'src/nested/generated/y.ts': '',
    'src/local-config.ts': '',
    'src/nested/local-z.ts': '',
    'dist/out.js': '',
    'pkg/dist/kept.js': '',
    'node_modules/m/index.js': '',
    'pkg/node_modules/n/index.js': '',
    // A file can't be re-included under an ignored directory.
    'logs/keep.txt': '',
    'logs/x.txt': '',
    'docs/a/b/draft-1.md': '',
    'docs/final.md': '',
    'docs/draft-0.md': '',
    'Temp.txt': '',
    'temporary/t.txt': '',
    'secret.env': '',
    'README.md': '',
    'weird [name].txt': '',
    'unicode/ünï.ts': '',
  };

  it('matches what git itself would track', () => {
    const root = tree(files);
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'README.md\n');
    const git = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } },
    )
      .split('\n')
      .filter((l) => l !== '')
      .sort();
    const ours = walked(root).sort();
    expect(ours).toEqual(git);
    expect(ours).toContain('src/b.log');
    expect(ours).toContain('src/nested/generated/y.ts');
    expect(ours).not.toContain('logs/keep.txt');
    expect(ours).not.toContain('README.md');
  });

  it('applies extra exclusions, never enters .git, and skips symbolic links', async () => {
    const root = tree({ 'a.ts': '', 'b/c.ts': '', 'vendor/d.ts': '', '.git/config': '' });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(root, 'b'), join(root, 'link'));
    symlinkSync(join(root, 'a.ts'), join(root, 'alias.ts'));
    expect(walked(root)).toEqual(['a.ts', 'b/c.ts', 'vendor/d.ts']);
    expect(walked(root, ['vendor/', '*.ts', '!a.ts'])).toEqual(['a.ts']);
  });

  it('copes with a missing directory', () => {
    expect(walked(join(tmpdir(), 'flagship-no-such-dir-x9'))).toEqual([]);
  });
});
