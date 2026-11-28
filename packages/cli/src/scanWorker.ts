/**
 * Finds flag keys in source files, on a worker thread. This module imports
 * nothing but node: built-ins, so the same file can run as a worker from the
 * build or, in tests, straight from source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/** A run of lines around references to one flag, line numbers counting from 1. */
export interface Hunk {
  path: string;
  startLine: number;
  lines: string[];
  matchLines: number[];
}

export interface FileReferences {
  path: string;
  /** References per flag key, in the order the keys first appear. */
  flags: { key: string; count: number; hunks: Hunk[] }[];
}

export interface FindOptions {
  /** Lines of source on each side of a reference; -1 sends no source at all. */
  context: number;
  /** Longest line kept; longer ones are cut. */
  lineLength: number;
  /** Most lines (or, with no source, references) in one hunk. */
  linesPerHunk: number;
}

export interface WorkerSetup {
  kind: 'flagship-scan';
  root: string;
  keys: string[];
  maxFileBytes: number;
  options: FindOptions;
}

export interface WorkerBatch {
  id: number;
  paths: string[];
}

export interface WorkerResult {
  id: number;
  files: FileReferences[];
  /** Files skipped: too large, binary, or unreadable. */
  skipped: number;
  bytes: number;
}

/**
 * A key in quotes or backticks, as code names flags: 'a', "a" or `a`. Keys
 * are letters, digits, ".", "_" and "-", starting with a letter or digit, so
 * one pattern finds every candidate and a set lookup keeps the cost
 * independent of how many flags there are.
 */
const QUOTED = /(["'`])([A-Za-z0-9][A-Za-z0-9._-]{0,99})\1/g;

/** How many bytes are checked for a NUL to tell binary files apart, as git does. */
const BINARY_SNIFF = 8000;

/** Splits matched lines into hunks of at most `linesPerHunk` lines with `context` around each. */
function hunksFor(
  path: string,
  matches: number[],
  lineAt: (n: number) => string,
  lineCount: number,
  o: FindOptions,
): Hunk[] {
  const hunks: Hunk[] = [];
  if (o.context < 0) {
    for (let i = 0; i < matches.length; i += o.linesPerHunk) {
      const matchLines = matches.slice(i, i + o.linesPerHunk);
      hunks.push({ path, startLine: matchLines[0] ?? 1, lines: [], matchLines });
    }
    return hunks;
  }
  let current: { start: number; end: number; matchLines: number[] } | undefined;
  const flush = () => {
    if (current === undefined) return;
    const lines: string[] = [];
    for (let n = current.start; n <= current.end; n++) lines.push(lineAt(n));
    hunks.push({ path, startLine: current.start, lines, matchLines: current.matchLines });
    current = undefined;
  };
  for (const line of matches) {
    const start = Math.max(1, line - o.context);
    const end = Math.min(lineCount, line + o.context);
    if (current !== undefined && start <= current.end + 1 && end - current.start < o.linesPerHunk) {
      current.end = end;
      current.matchLines.push(line);
      continue;
    }
    flush();
    current = { start, end, matchLines: [line] };
  }
  flush();
  return hunks;
}

/** Every reference to one of `keys` in a file's text. */
export function findReferences(
  path: string,
  text: string,
  keys: ReadonlySet<string>,
  o: FindOptions,
): FileReferences {
  const byKey = new Map<string, { count: number; lines: number[] }>();
  let line = 1;
  let scanned = 0;
  QUOTED.lastIndex = 0;
  for (let m = QUOTED.exec(text); m !== null; m = QUOTED.exec(text)) {
    const key = m[2] ?? '';
    if (!keys.has(key)) {
      // The closing quote may open the next string: "a","b".
      QUOTED.lastIndex = m.index + m[0].length - 1;
      continue;
    }
    for (
      let i = text.indexOf('\n', scanned);
      i !== -1 && i < m.index;
      i = text.indexOf('\n', i + 1)
    ) {
      line++;
      scanned = i + 1;
    }
    let refs = byKey.get(key);
    if (refs === undefined) byKey.set(key, (refs = { count: 0, lines: [] }));
    refs.count++;
    if (refs.lines.at(-1) !== line) refs.lines.push(line);
  }
  if (byKey.size === 0) return { path, flags: [] };

  let lines: string[] | undefined;
  const all = () => (lines ??= text.split('\n'));
  const lineAt = (n: number) => {
    let s = all()[n - 1] ?? '';
    if (s.endsWith('\r')) s = s.slice(0, -1);
    return s.length > o.lineLength ? s.slice(0, o.lineLength) : s;
  };
  const lineCount = o.context < 0 ? 0 : all().length;
  return {
    path,
    flags: [...byKey].map(([key, refs]) => ({
      key,
      count: refs.count,
      hunks: hunksFor(path, refs.lines, lineAt, lineCount, o),
    })),
  };
}

/** Reads and searches a batch of files, skipping large, binary and unreadable ones. */
export function scanBatch(setup: WorkerSetup, keys: ReadonlySet<string>, batch: WorkerBatch) {
  const result: WorkerResult = { id: batch.id, files: [], skipped: 0, bytes: 0 };
  for (const path of batch.paths) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(setup.root, path));
    } catch {
      result.skipped++;
      continue;
    }
    if (buf.length > setup.maxFileBytes || buf.subarray(0, BINARY_SNIFF).includes(0)) {
      result.skipped++;
      continue;
    }
    result.bytes += buf.length;
    const refs = findReferences(path, buf.toString('utf8'), keys, setup.options);
    if (refs.flags.length > 0) result.files.push(refs);
  }
  return result;
}

const setup = workerData as WorkerSetup | null | undefined;
if (!isMainThread && parentPort !== null && setup?.kind === 'flagship-scan') {
  const port = parentPort;
  const keys = new Set(setup.keys);
  port.on('message', (batch: WorkerBatch) => {
    port.postMessage(scanBatch(setup, keys, batch));
  });
}
