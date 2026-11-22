import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectExport } from '@flagship/admin-client';
import {
  ROLLOUT_TOTAL,
  evaluateAll,
  explain,
  validateRuleset,
  type ClauseTrace,
  type Evaluation,
  type Explanation,
  type Ruleset,
  type TraceStep,
} from '@flagship/core';
import { bool, str, strs, type Command, type Context, type Values } from '../command.js';
import { CliError, UsageError } from '../errors.js';
import { compact, table } from '../output.js';
import { serveText } from './flags.js';

/**
 * The context from --context and --key and --attr. An --attr value is read as
 * JSON when it parses (age=30 is a number, beta=true a boolean, tags=["a"] an
 * array) and as a string otherwise; --context is exact.
 */
export async function contextFrom(ctx: Context, values: Values): Promise<Record<string, unknown>> {
  let context: Record<string, unknown> = {};
  const source = str(values, 'context');
  if (source !== undefined) {
    const v = await ctx.readJson(source, '--context');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new UsageError('--context must be a JSON object such as {"key":"user-1"}');
    }
    context = { ...(v as Record<string, unknown>) };
  }
  for (const pair of strs(values, 'attr')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`--attr takes name=value, not "${pair}"`);
    const name = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // Not JSON: keep the string.
    }
    context[name] = value;
  }
  const key = str(values, 'key');
  if (key !== undefined) context.key = key;
  if (typeof context.key !== 'string' || context.key === '') {
    throw new UsageError('the context needs a key: pass --key KEY or include "key" in --context');
  }
  return context;
}

async function loadRuleset(
  ctx: Context,
  values: Values,
): Promise<{ ruleset: Ruleset; source: string }> {
  const file = str(values, 'ruleset');
  let raw: unknown;
  let source: string;
  if (file !== undefined) {
    raw = await ctx.readFileJson(file, 'ruleset');
    source = file === '-' ? 'stdin' : file;
  } else {
    const project = ctx.project();
    const environment = ctx.environment();
    raw = await ctx.call((c) => c.getRuleset({ path: { project, environment } }));
    source = `${project}/${environment}`;
  }
  const checked = validateRuleset(raw);
  if (!checked.ok) {
    throw new CliError(
      'invalid_ruleset',
      `the ruleset from ${source} is not valid`,
      checked.issues,
    );
  }
  return { ruleset: checked.value, source };
}

function resultText(e: Evaluation): string {
  if (e.reason === 'ERROR') return `error ${e.errorCode}: ${e.message}`;
  return `${compact(e.value)} (variant ${e.variant}, ${e.reason}${e.ruleId ? ` by rule ${e.ruleId}` : ''})`;
}

function clauseLine(c: ClauseTrace): string {
  const mark = c.matched ? 'yes' : 'no ';
  const not = c.clause.negate === true ? 'not ' : '';
  if (c.clause.operator === 'inSegment') {
    const segments = (c.segments ?? [])
      .map((s) => `${s.key}${s.found ? (s.matched ? ' (in)' : ' (not in)') : ' (missing)'}`)
      .join(', ');
    return `      ${mark}  ${not}in segment ${segments}`;
  }
  return `      ${mark}  ${c.clause.attribute} ${not}${c.clause.operator} ${c.clause.values
    .map((v) => compact(v))
    .join(', ')}`;
}

function bucketLine(step: Extract<TraceStep, { step: 'rule' | 'fallthrough' }>): string[] {
  if (step.bucket === undefined) return [];
  const pct = ((step.bucket.bucket / ROLLOUT_TOTAL) * 100).toFixed(3);
  return [
    `      bucket ${step.bucket.bucket} of ${ROLLOUT_TOTAL} (${pct}%) by ${step.bucket.bucketBy} = ${compact(step.bucket.value)}`,
  ];
}

export function traceText(ruleset: Ruleset, flagKey: string, x: Explanation): string[] {
  const flag = ruleset.flags[flagKey];
  const lines: string[] = [];
  for (const [i, step] of x.trace.entries()) {
    const n = `${i + 1}.`;
    switch (step.step) {
      case 'killSwitch':
        lines.push(
          `  ${n} kill switch: ${step.enabled ? 'on' : 'off, so the off variant is served'}`,
        );
        break;
      case 'prerequisite':
        lines.push(
          `  ${n} prerequisite ${step.flag} must serve ${step.expected}: it ${
            step.actual === null ? "couldn't be evaluated" : `served ${step.actual}`
          }${step.enabled ? '' : ' and is off'}, ${step.passed ? 'passed' : 'failed'}`,
        );
        break;
      case 'rule': {
        const rule = flag?.rules[step.index];
        lines.push(
          `  ${n} rule ${step.id}${step.description ? ` (${step.description})` : ''}: ${
            step.matched ? `matched, serves ${rule ? serveText(rule.serve) : '?'}` : 'no match'
          }`,
          ...step.clauses.map(clauseLine),
          ...bucketLine(step),
        );
        break;
      }
      case 'fallthrough':
        lines.push(
          `  ${n} default rule: serves ${flag ? serveText(flag.fallthrough) : '?'}`,
          ...bucketLine(step),
        );
        break;
    }
  }
  const last = x.trace.at(-1);
  const skipped =
    flag !== undefined && last?.step === 'rule' && last.matched
      ? flag.rules.length - last.index - 1
      : 0;
  if (skipped > 0) lines.push(`  (${skipped} later rule${skipped === 1 ? '' : 's'} not reached)`);
  return lines;
}

const evalCommand: Command = {
  path: ['eval'],
  summary: 'Evaluate a flag for a context and show why it got its value',
  args: '[flag]',
  arity: [0, 1],
  details: [
    "Fetches the environment's ruleset (or reads --ruleset) and evaluates it here with the same",
    'evaluator the SDKs use, recording the kill switch, prerequisites, every rule tried with each',
    'clause, and the bucket of a percentage split. Exits 1 when the result is an error.',
    'Without a flag, --all evaluates every flag.',
  ].join('\n'),
  options: {
    key: { type: 'string', value: 'KEY', description: 'The context key' },
    attr: {
      type: 'string',
      multiple: true,
      value: 'NAME=VALUE',
      description: 'A context attribute; the value is JSON when it parses, else a string',
    },
    context: {
      type: 'string',
      value: 'JSON',
      description: 'The whole context as JSON, @file or -',
    },
    all: { type: 'boolean', description: 'Evaluate every flag for the context' },
    ruleset: {
      type: 'string',
      value: 'PATH',
      description: 'Evaluate a saved ruleset file (or - for stdin) instead of fetching one',
    },
  },
  async run(ctx, values, [flagKey]) {
    if ((flagKey === undefined) === !bool(values, 'all')) {
      throw new UsageError('name one flag, or pass --all for every flag');
    }
    const context = await contextFrom(ctx, values);
    const { ruleset, source } = await loadRuleset(ctx, values);
    if (flagKey === undefined) {
      const results = evaluateAll(ruleset, context);
      const keys = Object.keys(results).sort();
      return {
        json: { source, context, results },
        text:
          keys.length === 0
            ? `No flags in ${source}.`
            : table(
                ['FLAG', 'VALUE', 'VARIANT', 'REASON'],
                keys.map((k) => {
                  const r = results[k];
                  if (r === undefined || r.reason === 'ERROR')
                    return [k, '-', '-', `ERROR ${r?.errorCode ?? ''}`];
                  return [
                    k,
                    compact(r.value),
                    r.variant,
                    r.ruleId ? `${r.reason} (${r.ruleId})` : r.reason,
                  ];
                }),
              ),
      };
    }
    const x = explain(ruleset, flagKey, context);
    return {
      json: { source, flag: flagKey, context, ...x },
      text: [
        `${flagKey} = ${resultText(x.evaluation)}`,
        `  in ${source} for ${compact(context)}`,
        '',
        ...traceText(ruleset, flagKey, x),
      ].join('\n'),
      status: x.evaluation.reason === 'ERROR' ? 1 : 0,
    };
  },
};

const exportCommand: Command = {
  path: ['export'],
  summary: 'Export a project to one JSON document (flags, targeting, segments, checksums)',
  details:
    'The document imports back with POST /api/projects/import, into a new project or a copy.',
  options: {
    out: { type: 'string', value: 'PATH', description: 'Write it to this file instead of stdout' },
  },
  async run(ctx, values) {
    const project = ctx.project();
    const doc = await ctx.call<ProjectExport>((c) => c.exportProject({ path: { project } }));
    const out = str(values, 'out');
    if (out === undefined) return { json: doc, text: JSON.stringify(doc, null, 2) };
    const path = resolve(ctx.io.cwd, out);
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
    const summary = {
      project,
      file: path,
      environments: doc.environments.length,
      flags: doc.flags.length,
      segments: doc.segments.length,
    };
    return {
      json: summary,
      text: `Exported ${project} to ${out}: ${summary.flags} flags and ${summary.segments} segments in ${summary.environments} environments.`,
    };
  },
};

export const evalCommands: Command[] = [evalCommand, exportCommand];
