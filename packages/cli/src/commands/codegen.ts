import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import {
  generateGo,
  generateTypeScript,
  goPackageName,
  LANGUAGES,
  type CodegenFlag,
  type Language,
} from '../codegen.js';
import { bool, oneOf, str, type Command, type Context, type Values } from '../command.js';
import { UsageError } from '../errors.js';
import { readFlagsFile } from '../flagsfile.js';
import { CHANGES_STATUS } from './code.js';
import { getFlag, type FlagSummary } from './flags.js';

/** Flag details fetched at once while reading a project from the server. */
const CONCURRENCY = 8;

const EXTENSIONS: Record<string, Language> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.go': 'go',
};

function language(values: Values, out: string | undefined): Language {
  const given = oneOf(values, 'lang', [...LANGUAGES, 'ts']);
  if (given !== undefined) return given === 'ts' ? 'typescript' : given;
  const inferred = out === undefined ? undefined : EXTENSIONS[extname(out).toLowerCase()];
  if (inferred === undefined) {
    throw new UsageError('pass --lang typescript or --lang go, or an --out file ending .ts or .go');
  }
  return inferred;
}

/** The Go package: --package, else the output's directory name, else "flags". */
function packageName(values: Values, out: string | undefined, cwd: string): string {
  const given = str(values, 'package');
  if (given !== undefined) {
    if (!goPackageName(given)) {
      throw new UsageError(
        `--package "${given}" is not a Go package name: use lowercase letters, digits and _`,
      );
    }
    return given;
  }
  if (out === undefined) return 'flags';
  const dir = basename(dirname(resolve(cwd, out)))
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return goPackageName(dir) ? dir : 'flags';
}

async function firstEnvironment(ctx: Context, project: string): Promise<string> {
  const p = await ctx.call<{ environments: { key: string }[] }>((c) =>
    c.getProject({ path: { project } }),
  );
  const first = p.environments[0]?.key;
  if (first === undefined) throw new UsageError(`project "${project}" has no environments`);
  return first;
}

/** Every live (unarchived) flag of the project, with its variants. */
async function serverFlags(ctx: Context, project: string): Promise<CodegenFlag[]> {
  // Flags and variants are the same in every environment; the list just needs one. With
  // one named, a token with only flags:read is enough.
  const environment =
    ctx.explicitEnvironment() ?? ctx.profile.environment ?? (await firstEnvironment(ctx, project));
  const keys: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await ctx.call<{ flags: FlagSummary[] }>((c) =>
      c.listFlags({ path: { project }, query: { environment, limit: 500, after } }),
    );
    keys.push(...page.flags.filter((f) => f.status !== 'archived').map((f) => f.key));
    const last = page.flags.at(-1);
    if (page.flags.length < 500 || last === undefined) break;
    after = last.key;
  }
  const flags: CodegenFlag[] = new Array<CodegenFlag>(keys.length);
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const i = next++;
      const f = await getFlag(ctx, keys[i] ?? '');
      flags[i] = {
        key: f.key,
        name: f.name,
        description: f.description,
        type: f.type,
        clientSide: f.clientSide,
        variants: f.variants,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker));
  return flags;
}

/** The 1-based line where two texts first differ. */
function firstDifference(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i + 1;
}

const codegen: Command = {
  path: ['codegen'],
  summary: 'Generate typed flag accessors for TypeScript or Go',
  details: [
    'Writes a module with a constant per flag key and one typed accessor per flag: the Node',
    'and browser SDKs for TypeScript (string flags typed as the union of their values), and an',
    'Evaluator interface the Go SDK implements for Go. Flags come from the server, or from a',
    'flags file with --file so CI needs no credentials. The output depends only on the flags,',
    `so --check (exit status ${CHANGES_STATUS} when --out is missing or out of date) keeps it`,
    'honest in CI. The language follows --out (.ts or .go) unless --lang says.',
  ].join('\n'),
  options: {
    lang: {
      type: 'string',
      value: 'LANG',
      description: 'typescript (or ts) or go; default from the --out extension',
    },
    out: { type: 'string', value: 'PATH', description: 'Write here instead of stdout' },
    file: {
      type: 'string',
      value: 'PATH',
      description: 'Read flags from a flags file instead of the server',
    },
    package: {
      type: 'string',
      value: 'NAME',
      description: "Go package name (default: --out's directory, else flags)",
    },
    check: {
      type: 'boolean',
      description: `Write nothing; exit with status ${CHANGES_STATUS} if --out differs from the output`,
    },
  },
  async run(ctx, values) {
    const out = str(values, 'out');
    const check = bool(values, 'check');
    if (check && out === undefined) throw new UsageError('--check compares with --out: pass both');
    const lang = language(values, out);
    if (lang !== 'go' && str(values, 'package') !== undefined) {
      throw new UsageError('--package is for --lang go');
    }
    // Checked before anything is fetched.
    const pkg = lang === 'go' ? packageName(values, out, ctx.io.cwd) : '';
    const path = str(values, 'file');
    let project: string;
    let flags: CodegenFlag[];
    if (path !== undefined) {
      let text: string;
      try {
        text = await readFile(resolve(ctx.io.cwd, path), 'utf8');
      } catch (e) {
        throw new UsageError(`can't read flags file ${path}: ${(e as Error).message}`);
      }
      const file = readFlagsFile(text, path, path);
      const explicit = str(ctx.globals, 'project') ?? ctx.io.env.FLAGSHIP_PROJECT;
      project = file.project ?? ctx.project();
      if (file.project !== undefined && explicit && explicit !== file.project) {
        throw new UsageError(`${path} is for project "${file.project}", not "${explicit}"`);
      }
      flags = file.flags;
    } else {
      project = ctx.project();
      flags = await serverFlags(ctx, project);
    }
    const code =
      lang === 'go' ? generateGo({ project, flags }, pkg) : generateTypeScript({ project, flags });
    const summary = { project, lang, flags: flags.length };
    if (out === undefined) return { json: { ...summary, file: null, code }, text: code.trimEnd() };
    const target = resolve(ctx.io.cwd, out);
    const shown = relative(ctx.io.cwd, target).split(sep).join('/') || out;
    if (check) {
      let existing: string | undefined;
      try {
        existing = await readFile(target, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new UsageError(`can't read ${out}: ${(e as Error).message}`);
        }
      }
      const upToDate = existing === code;
      const line = existing === undefined || upToDate ? null : firstDifference(existing, code);
      const how = `run flagship codegen --out ${out} and commit the result`;
      return {
        json: { ...summary, file: shown, upToDate, firstDifferentLine: line },
        text: upToDate
          ? `${shown} is up to date (${flags.length} flags).`
          : existing === undefined
            ? `${shown} does not exist: ${how}.`
            : `${shown} is out of date from line ${line}: ${how}.`,
        status: upToDate ? 0 : CHANGES_STATUS,
      };
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, code, 'utf8');
    return {
      json: { ...summary, file: shown },
      text: `Wrote ${flags.length} flag accessors for ${lang === 'go' ? 'Go' : 'TypeScript'} to ${shown}.`,
    };
  },
};

export const codegenCommands: Command[] = [codegen];
