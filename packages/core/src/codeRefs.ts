import { z } from 'zod';
import { keySchema } from './model.js';

/**
 * Bounds on what `flagship scan` uploads for one branch. The scanner keeps
 * within them and the server refuses anything past them, so one noisy
 * repository can't fill the database or the flag page.
 */
export const CODE_REFERENCE_LIMITS = {
  /** Lines of source kept on each side of a reference. */
  contextLines: 5,
  /** Hunks kept per flag in one branch; the count still covers every reference. */
  hunksPerFlag: 100,
  /** Hunks in one upload, over all flags. */
  hunksPerUpload: 20_000,
  linesPerHunk: 50,
  /** Longer lines are cut to this many characters. */
  lineLength: 500,
  pathLength: 1024,
  flagsPerUpload: 5000,
  /** Branches a project keeps over all its repositories. */
  branchesPerProject: 500,
} as const;

const L = CODE_REFERENCE_LIMITS;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A path relative to the repository root, with forward slashes and no "." or ".." parts. */
export const codePathSchema = z
  .string()
  .min(1)
  .max(L.pathLength)
  .refine(
    (p) =>
      !CONTROL.test(p) &&
      !p.includes('\\') &&
      p.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'must be a relative path with forward slashes and no empty, "." or ".." parts',
  );

export const codeHunkSchema = z
  .strictObject({
    path: codePathSchema,
    /** Line number of lines[0], counting from 1. */
    startLine: z.int().min(1),
    /** The source around the references; empty when the scan sent no source. */
    lines: z.array(z.string().max(L.lineLength)).max(L.linesPerHunk),
    /** Lines that reference the flag, ascending. */
    matchLines: z.array(z.int().min(1)).min(1).max(L.linesPerHunk),
  })
  .superRefine((h, ctx) => {
    for (let i = 1; i < h.matchLines.length; i++) {
      if ((h.matchLines[i] ?? 0) <= (h.matchLines[i - 1] ?? 0)) {
        ctx.addIssue({ code: 'custom', path: ['matchLines'], message: 'must be ascending' });
        return;
      }
    }
    if (h.lines.length === 0) return;
    const last = h.startLine + h.lines.length - 1;
    const first = h.matchLines[0] ?? h.startLine;
    const end = h.matchLines.at(-1) ?? h.startLine;
    if (first < h.startLine || end > last) {
      ctx.addIssue({
        code: 'custom',
        path: ['matchLines'],
        message: `must be within lines ${h.startLine} to ${last}`,
      });
    }
  });

export type CodeHunk = z.infer<typeof codeHunkSchema>;

export const flagCodeReferencesSchema = z
  .strictObject({
    /** Every reference found, which may be more than the hunks kept. */
    count: z.int().min(1),
    hunks: z.array(codeHunkSchema).max(L.hunksPerFlag),
  })
  .refine(
    (r) => r.hunks.reduce((n, h) => n + h.matchLines.length, 0) <= r.count,
    'count must cover every reference in the hunks',
  );

export type FlagCodeReferences = z.infer<typeof flagCodeReferencesSchema>;

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !CONTROL.test(s), 'must not contain control characters');

/** One branch's references, replacing whatever that branch uploaded before. */
export const codeReferencesUploadSchema = z
  .strictObject({
    /** What the repository calls itself, e.g. "github.com/acme/shop". */
    repository: label(200),
    branch: label(255),
    commit: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/, 'must be a lowercase hexadecimal commit id')
      .nullable()
      .optional(),
    /** A link to one line: {commit}, {branch}, {path} and {line} are filled in. */
    urlTemplate: z
      .string()
      .max(500)
      .regex(/^https?:\/\/[^\s]+$/, 'must be an http or https URL')
      .nullable()
      .optional(),
    filesScanned: z.int().min(0),
    references: z.record(keySchema, flagCodeReferencesSchema),
  })
  .superRefine((u, ctx) => {
    const flags = Object.values(u.references);
    if (flags.length > L.flagsPerUpload) {
      ctx.addIssue({
        code: 'custom',
        path: ['references'],
        message: `at most ${L.flagsPerUpload} flags`,
      });
    }
    const hunks = flags.reduce((n, r) => n + r.hunks.length, 0);
    if (hunks > L.hunksPerUpload) {
      ctx.addIssue({
        code: 'custom',
        path: ['references'],
        message: `at most ${L.hunksPerUpload} hunks in one upload, not ${hunks}`,
      });
    }
  });

export type CodeReferencesUpload = z.infer<typeof codeReferencesUploadSchema>;

/**
 * A link to one line of a hunk, or null without a template. Every value is
 * percent-encoded except the slashes between path parts.
 */
export function codeReferenceUrl(
  template: string | null | undefined,
  at: { commit: string | null; branch: string; path: string; line: number },
): string | null {
  if (template === null || template === undefined) return null;
  const ref = at.commit ?? at.branch;
  return template.replace(/\{(commit|branch|path|line)\}/g, (_, name: string) => {
    if (name === 'commit') return encodeURIComponent(ref);
    if (name === 'branch') return at.branch.split('/').map(encodeURIComponent).join('/');
    if (name === 'path') return at.path.split('/').map(encodeURIComponent).join('/');
    return String(at.line);
  });
}
