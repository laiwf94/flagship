import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { AdminApiError } from '@flagship/admin-client';
import { ALIASES, COMMANDS } from './commands/index.js';
import {
  GLOBAL_OPTIONS,
  Context,
  type Command,
  type Io,
  type Option,
  type Values,
} from './command.js';
import { configPath, loadConfig } from './config.js';
import { CliError, UsageError } from './errors.js';

export const VERSION = '0.1.0';

/** Global options that take a value, so their values aren't mistaken for command words. */
const VALUE_OPTIONS = new Set(
  Object.entries(GLOBAL_OPTIONS).flatMap(([name, o]) =>
    o.type === 'string' ? [`--${name}`, ...(o.short ? [`-${o.short}`] : [])] : [],
  ),
);

/** The words of argv that aren't options, skipping the values of global options, with their indexes. */
function words(argv: readonly string[]): { word: string; at: number }[] {
  const out: { word: string; at: number }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (VALUE_OPTIONS.has(a)) i++;
      continue;
    }
    out.push({ word: a, at: i });
  }
  return out;
}

/** The command whose path is the longest prefix of `ws`. */
function find(ws: readonly string[]): Command | undefined {
  let best: Command | undefined;
  for (const c of COMMANDS) {
    if (c.path.every((p, i) => ws[i] === p) && c.path.length > (best?.path.length ?? 0)) best = c;
  }
  return best;
}

function optionUsage(name: string, o: Option): string {
  const short = o.short ? `-${o.short}, ` : '    ';
  const value = o.type === 'string' ? ` ${o.value ?? 'VALUE'}` : '';
  const repeat = o.multiple ? ' ...' : '';
  return `${short}--${name}${value}${repeat}`;
}

function optionLines(options: Record<string, Option>): string[] {
  const entries = Object.entries(options);
  const left = entries.map(([n, o]) => optionUsage(n, o));
  const width = Math.max(...left.map((l) => l.length));
  return entries.map(([, o], i) => `  ${(left[i] ?? '').padEnd(width)}  ${o.description}`);
}

function commandHelp(c: Command): string {
  const lines = [
    `Usage: flagship ${c.path.join(' ')}${c.args ? ` ${c.args}` : ''} [options]`,
    '',
    c.summary,
  ];
  if (c.details) lines.push('', c.details);
  if (c.options && Object.keys(c.options).length > 0) {
    lines.push('', 'Options:', ...optionLines(c.options));
  }
  lines.push('', 'Global options:', ...optionLines(GLOBAL_OPTIONS));
  return lines.join('\n');
}

function groupHelp(prefix: readonly string[]): string {
  const matching = COMMANDS.filter((c) => prefix.every((p, i) => c.path[i] === p));
  const left = matching.map((c) => `${c.path.join(' ')}${c.args ? ` ${c.args}` : ''}`);
  const width = Math.max(...left.map((l) => l.length));
  const lines = [
    prefix.length === 0
      ? `flagship ${VERSION}: manage feature flags from the terminal.\n\nUsage: flagship <command> [options]`
      : `Usage: flagship ${prefix.join(' ')} <command> [options]`,
    '',
    'Commands:',
    ...matching.map((c, i) => `  ${(left[i] ?? '').padEnd(width)}  ${c.summary}`),
    '',
    'Global options:',
    ...optionLines(GLOBAL_OPTIONS),
    '',
    'Run flagship <command> --help for the options of one command.',
  ];
  return lines.join('\n');
}

function toConfig(options: Record<string, Option>): ParseArgsOptionsConfig {
  const out: ParseArgsOptionsConfig = {};
  for (const [name, { description: _d, value: _v, ...o }] of Object.entries(options)) {
    out[name] = o;
  }
  return out;
}

function errorBody(e: unknown): { code: string; message: string; [k: string]: unknown } {
  if (e instanceof AdminApiError) {
    const body: { code: string; message: string; [k: string]: unknown } = {
      code: e.code,
      message: e.message,
      status: e.status,
    };
    if (e.requestId !== undefined) body.requestId = e.requestId;
    if (e.details !== undefined) body.details = e.details;
    return body;
  }
  if (e instanceof CliError) {
    return e.details === undefined
      ? { code: e.code, message: e.message }
      : { code: e.code, message: e.message, details: e.details };
  }
  if (e instanceof UsageError) return { code: 'usage', message: e.message };
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}

function detailLines(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((d: unknown) => {
    if (typeof d !== 'object' || d === null) return [];
    const { path, message } = d as { path?: unknown; message?: unknown };
    if (typeof message !== 'string') return [];
    return [`  ${typeof path === 'string' && path !== '' ? `${path}: ` : ''}${message}`];
  });
}

/**
 * Runs one command line and returns the exit status: 0 on success, 1 when
 * the server or the command failed, 2 for bad arguments.
 */
export async function run(input: readonly string[], io: Io): Promise<number> {
  const argv = [...input];
  const json = argv.includes('--json');
  try {
    const found = words(argv);
    const first = found[0];
    const alias =
      first !== undefined && Object.hasOwn(ALIASES, first.word) ? ALIASES[first.word] : undefined;
    if (first !== undefined && alias !== undefined) argv[first.at] = alias;
    const ws = found.map((w, i) => (i === 0 && alias !== undefined ? alias : w.word));
    if (ws.length === 0 || ws[0] === 'help') {
      if (argv.includes('--version')) {
        io.stdout(json ? JSON.stringify({ version: VERSION }) : VERSION);
        return 0;
      }
      const target = ws.slice(1);
      const named = target[0];
      if (named !== undefined && Object.hasOwn(ALIASES, named)) target[0] = ALIASES[named] ?? named;
      const c = find(target);
      io.stdout(
        c && c.path.length === target.length ? commandHelp(c) : groupHelp(target.slice(0, 1)),
      );
      return 0;
    }
    const command = find(ws);
    if (command === undefined) {
      const group = COMMANDS.some((c) => c.path[0] === ws[0]);
      if (group && (argv.includes('--help') || argv.includes('-h') || ws.length === 1)) {
        io.stdout(groupHelp(ws.slice(0, 1)));
        return ws.length === 1 && !argv.includes('--help') && !argv.includes('-h') ? 2 : 0;
      }
      throw new UsageError(`unknown command "${ws.slice(0, 2).join(' ')}": run flagship --help`);
    }
    const options = { ...GLOBAL_OPTIONS, ...command.options };
    let values: Values;
    let positionals: string[];
    try {
      ({ values, positionals } = parseArgs({
        args: argv,
        options: toConfig(options),
        allowPositionals: true,
        strict: true,
      }));
    } catch (e) {
      throw new UsageError((e as Error).message.replace(/\. To specify a positional.*$/s, ''));
    }
    if (values.help === true) {
      io.stdout(commandHelp(command));
      return 0;
    }
    if (!command.path.every((p, i) => positionals[i] === p)) {
      throw new UsageError(`put options after the command: flagship ${command.path.join(' ')} ...`);
    }
    const args = positionals.slice(command.path.length);
    const [min, max] = command.arity ?? [0, 0];
    if (args.length < min || args.length > max) {
      throw new UsageError(
        `flagship ${command.path.join(' ')} takes ${command.args ?? 'no arguments'}${
          args.length > max ? `, not "${args.slice(max).join(' ')}"` : ''
        }`,
      );
    }
    const file = configPath(io.env);
    const ctx = new Context(io, await loadConfig(file), file, values);
    const result = await command.run(ctx, values, args);
    if (json) io.stdout(JSON.stringify(result.json, null, 2));
    else if (result.text !== '') io.stdout(result.text);
    return result.status ?? 0;
  } catch (e) {
    const body = errorBody(e);
    if (json) {
      io.stderr(JSON.stringify({ error: body }, null, 2));
    } else {
      const lines = [`flagship: ${body.message}`, ...detailLines(body.details)];
      if (typeof body.requestId === 'string') lines.push(`  request id: ${body.requestId}`);
      if (e instanceof UsageError) lines.push('Run flagship --help for usage.');
      io.stderr(lines.join('\n'));
    }
    return e instanceof UsageError ? 2 : 1;
  }
}
