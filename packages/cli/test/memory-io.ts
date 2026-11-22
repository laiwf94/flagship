import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/command.js';
import { run } from '../src/run.js';

export interface Captured {
  status: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON; throws when it isn't. */
  json: () => any;
}

/** A CLI with its own config directory, captured output and a fake or real fetch. */
export function harness(options: { fetch?: typeof fetch; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flagship-cli-'));
  const configFile = join(dir, 'config', 'config.json');
  const env: Record<string, string> = { FLAGSHIP_CONFIG: configFile, ...options.env };
  return {
    dir,
    configFile,
    env,
    cli: async (
      argv: string[],
      extra: { stdin?: string; prompt?: string } = {},
    ): Promise<Captured> => {
      const out: string[] = [];
      const err: string[] = [];
      const io: Io = {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        readStdin: async () => extra.stdin ?? '',
        promptSecret: extra.prompt === undefined ? undefined : async () => extra.prompt ?? '',
        env,
        cwd: dir,
        fetch: options.fetch,
      };
      const status = await run(argv, io);
      const stdout = out.join('\n');
      return { status, stdout, stderr: err.join('\n'), json: () => JSON.parse(stdout) };
    },
  };
}
