import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CODE_REFERENCE_LIMITS, type CodeHunk } from '@flagship/core';
import { isIgnored, parseIgnoreFile, type IgnoreFile } from './gitignore.js';
import type { FindOptions, WorkerBatch, WorkerResult, WorkerSetup } from './scanWorker.js';

export interface ScanOptions {
  /** The repository root; paths in the result are relative to it. */
  root: string;
  /** Flag keys to look for. */
  keys: readonly string[];
  /** Lines of source on each side of a reference, 0 to 5; -1 sends no source. */
  context: number;
  /** Worker threads at most; more start only as the tree turns out to be large. */
  workers?: number;
  /** Files larger than this are skipped. */
  maxFileBytes?: number;
  /** Extra patterns in .gitignore syntax, relative to the root. */
  exclude?: readonly string[];
}

export interface ScanResult {
  filesScanned: number;
  /** Files skipped because they were too large, binary or unreadable. */
  filesSkipped: number;
  bytesScanned: number;
  /** Worker threads used. */
  workers: number;
  durationMs: number;
  /** Flags with references, by key, sorted; hunks are capped per flag and in total. */
  references: Record<string, { count: number; hunks: CodeHunk[] }>;
  /** Hunks left out to stay within the upload limits. */
  hunksDropped: number;
}

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** Files sent to a worker at a time: enough to amortize a message, small enough to share out. */
const BATCH = 128;
/** Start another worker once each running one has this many batches queued. */
const QUEUE_PER_WORKER = 4;

/** The worker module beside this one: the build's .js, or the source .ts under tests. */
function workerUrl(): URL {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./scanWorker.${ext}`, import.meta.url);
}

function readIgnore(path: string, base: string): IgnoreFile | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const file = parseIgnoreFile(text, base);
  return file.rules.length === 0 ? null : file;
}

/**
 * Walks the tree under `root`, calling `onFile` with each path (relative,
 * forward slashes) that .gitignore files, .git/info/exclude and `exclude`
 * leave in. `.git` itself and symbolic links are never followed, and an
 * ignored directory is never entered, so nothing under it can be re-included.
 */
export function walk(
  root: string,
  exclude: readonly string[],
  onFile: (path: string) => void,
): void {
  const base: IgnoreFile[] = [];
  const info = readIgnore(join(root, '.git', 'info', 'exclude'), '');
  if (info !== null) base.push(info);
  if (exclude.length > 0) base.push(parseIgnoreFile(exclude.join('\n'), ''));

  const visit = (dir: string, rel: string, inherited: readonly IgnoreFile[]) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let files = inherited;
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      const own = readIgnore(join(dir, '.gitignore'), rel);
      if (own !== null) files = [...inherited, own];
    }
    // Sorted, so the walk (and so the result) is the same on every file system.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === '.git' || isIgnored(files, path, true)) continue;
        visit(join(dir, e.name), path, files);
      } else if (e.isFile() && !isIgnored(files, path, false)) {
        onFile(path);
      }
    }
  };
  visit(root, '', base);
}

/**
 * Scans a tree for flag keys on worker threads. The walk runs on this thread
 * and hands out batches of paths as it goes; workers read and search files
 * in parallel, starting more of them only when the queue grows, so a small
 * repository costs one thread.
 */
export async function scan(o: ScanOptions): Promise<ScanResult> {
  const started = performance.now();
  const maxWorkers = Math.max(1, o.workers ?? Math.min(availableParallelism(), 8));
  const options: FindOptions = {
    context: o.context,
    lineLength: CODE_REFERENCE_LIMITS.lineLength,
    linesPerHunk: CODE_REFERENCE_LIMITS.linesPerHunk,
  };
  const setup: WorkerSetup = {
    kind: 'flagship-scan',
    root: o.root,
    keys: [...o.keys],
    maxFileBytes: o.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    options,
  };

  const workers: { worker: Worker; queued: number }[] = [];
  const results: WorkerResult[] = [];
  let failure: Error | undefined;
  let outstanding = 0;
  let walked = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  const settle = () => {
    if (failure !== undefined || (walked && outstanding === 0)) finish();
  };

  const spawn = () => {
    const slot = { worker: new Worker(workerUrl(), { workerData: setup }), queued: 0 };
    slot.worker.on('message', (r: WorkerResult) => {
      results.push(r);
      slot.queued--;
      outstanding--;
      settle();
    });
    slot.worker.on('error', (e) => {
      failure ??= e;
      settle();
    });
    slot.worker.on('exit', (code) => {
      if (code !== 0 && slot.queued > 0) failure ??= new Error(`scan worker exited with ${code}`);
      settle();
    });
    workers.push(slot);
    return slot;
  };

  let filesScanned = 0;
  let nextId = 0;
  let pending: string[] = [];
  const send = () => {
    if (pending.length === 0) return;
    // The least busy worker, or a new one when they are all backed up.
    let slot = workers.reduce<(typeof workers)[number] | undefined>(
      (best, w) => (best === undefined || w.queued < best.queued ? w : best),
      undefined,
    );
    if (slot === undefined || (slot.queued >= QUEUE_PER_WORKER && workers.length < maxWorkers)) {
      slot = spawn();
    }
    const batch: WorkerBatch = { id: nextId++, paths: pending };
    slot.queued++;
    outstanding++;
    slot.worker.postMessage(batch);
    pending = [];
  };

  try {
    walk(o.root, o.exclude ?? [], (path) => {
      filesScanned++;
      pending.push(path);
      if (pending.length === BATCH) send();
    });
    send();
    walked = true;
    settle();
    await done;
  } finally {
    await Promise.all(workers.map((w) => w.worker.terminate()));
  }
  if (failure !== undefined) throw failure;

  const merged = new Map<string, { count: number; hunks: CodeHunk[] }>();
  let skipped = 0;
  let bytes = 0;
  results.sort((a, b) => a.id - b.id);
  for (const r of results) {
    skipped += r.skipped;
    bytes += r.bytes;
    for (const file of r.files) {
      for (const f of file.flags) {
        let entry = merged.get(f.key);
        if (entry === undefined) merged.set(f.key, (entry = { count: 0, hunks: [] }));
        entry.count += f.count;
        entry.hunks.push(...f.hunks);
      }
    }
  }

  // Keep the upload within its limits: the same number of hunks for every
  // flag, in path order, and every count in full.
  const totalHunks = [...merged.values()].reduce((n, e) => n + e.hunks.length, 0);
  const perFlag = Math.min(
    CODE_REFERENCE_LIMITS.hunksPerFlag,
    Math.floor(CODE_REFERENCE_LIMITS.hunksPerUpload / Math.max(1, merged.size)),
  );
  const references: ScanResult['references'] = {};
  let kept = 0;
  for (const [key, e] of [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    references[key] = { count: e.count, hunks: e.hunks.slice(0, perFlag) };
    kept += references[key].hunks.length;
  }
  return {
    filesScanned: filesScanned - skipped,
    filesSkipped: skipped,
    bytesScanned: bytes,
    workers: workers.length,
    durationMs: Math.round(performance.now() - started),
    references,
    hunksDropped: totalHunks - kept,
  };
}
