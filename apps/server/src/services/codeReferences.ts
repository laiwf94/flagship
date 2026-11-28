import { CODE_REFERENCE_LIMITS, type CodeReferencesUpload } from '@flagship/core';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';
import type { CodeHunk } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import type { Actor } from './audit.js';
import type { ProjectRow } from './projects.js';

export interface CodeBranchView {
  repository: string;
  branch: string;
  commit: string | null;
  urlTemplate: string | null;
  filesScanned: number;
  scannedAt: string;
  uploadedBy: string;
}

export interface CodeBranchSummary extends CodeBranchView {
  /** Flags referenced in this branch. */
  flags: number;
  /** References over all flags. */
  references: number;
}

export interface FlagCodeBranch extends CodeBranchView {
  count: number;
  hunks: CodeHunk[];
}

/** Rows inserted per statement, well under Postgres's 65,535 parameters. */
const INSERT_CHUNK = 500;

interface BranchRow {
  repository: string;
  branch: string;
  commit_sha: string | null;
  url_template: string | null;
  files_scanned: number;
  scanned_at: Date;
  uploaded_by: string;
}

function branchView(r: BranchRow): CodeBranchView {
  return {
    repository: r.repository,
    branch: r.branch,
    commit: r.commit_sha,
    urlTemplate: r.url_template,
    filesScanned: r.files_scanned,
    scannedAt: r.scanned_at.toISOString(),
    uploadedBy: r.uploaded_by,
  };
}

/**
 * Replaces one branch's references with an upload, in one transaction, so
 * the flag page shows either the old scan or the new one, never a mix. Keys
 * that name no flag in the project (archived flags count) are refused, and a
 * new branch past the project's limit is refused rather than evicting one.
 */
export async function uploadCodeReferences(
  db: Db,
  project: ProjectRow,
  actor: Actor,
  upload: CodeReferencesUpload,
): Promise<CodeBranchSummary> {
  const keys = Object.keys(upload.references);
  return db.transaction().execute(async (trx) => {
    // Uploads to one project take turns, so the branch limit holds under concurrency.
    await trx
      .selectFrom('projects')
      .select('id')
      .where('id', '=', project.id)
      .forUpdate()
      .execute();

    if (keys.length > 0) {
      const known = new Set(
        (
          await trx
            .selectFrom('flags')
            .select('key')
            .where('project_id', '=', project.id)
            .where('key', 'in', keys)
            .execute()
        ).map((r) => r.key),
      );
      const unknown = keys.filter((k) => !known.has(k));
      if (unknown.length > 0) {
        throw new AppError(
          'invalid_argument',
          `${unknown.length === 1 ? 'no flag' : 'no flags'} ${unknown
            .slice(0, 10)
            .map((k) => `"${k}"`)
            .join(
              ', ',
            )}${unknown.length > 10 ? ` and ${unknown.length - 10} more` : ''} in project "${project.key}"`,
          { unknownFlags: unknown.slice(0, 100) },
        );
      }
    }

    const existing = await trx
      .selectFrom('code_reference_branches')
      .select('id')
      .where('project_id', '=', project.id)
      .where('repository', '=', upload.repository)
      .where('branch', '=', upload.branch)
      .executeTakeFirst();
    if (existing === undefined) {
      const { count } = await trx
        .selectFrom('code_reference_branches')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('project_id', '=', project.id)
        .executeTakeFirstOrThrow();
      if (Number(count) >= CODE_REFERENCE_LIMITS.branchesPerProject) {
        throw new AppError(
          'failed_precondition',
          `project "${project.key}" already keeps ${CODE_REFERENCE_LIMITS.branchesPerProject} branches of code references; delete merged branches first`,
        );
      }
    }

    const values = {
      commit_sha: upload.commit ?? null,
      url_template: upload.urlTemplate ?? null,
      files_scanned: upload.filesScanned,
      scanned_at: sql<Date>`now()`,
      uploaded_by: actor.name,
    };
    const branch =
      existing === undefined
        ? await trx
            .insertInto('code_reference_branches')
            .values({
              project_id: project.id,
              repository: upload.repository,
              branch: upload.branch,
              ...values,
            })
            .returningAll()
            .executeTakeFirstOrThrow()
        : await trx
            .updateTable('code_reference_branches')
            .set(values)
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();

    await trx.deleteFrom('code_references').where('branch_id', '=', branch.id).execute();
    const rows = Object.entries(upload.references).map(([key, refs]) => ({
      branch_id: branch.id,
      project_id: project.id,
      flag_key: key,
      count: refs.count,
      hunks: JSON.stringify(refs.hunks),
    }));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await trx
        .insertInto('code_references')
        .values(rows.slice(i, i + INSERT_CHUNK))
        .execute();
    }
    return {
      ...branchView(branch),
      flags: rows.length,
      references: rows.reduce((n, r) => n + r.count, 0),
    };
  });
}

/** Every branch with references, newest scan first within each repository. */
export async function listCodeBranches(
  db: Db,
  project: ProjectRow,
): Promise<{ flagKeys: string[]; branches: CodeBranchSummary[] }> {
  const [flags, branches] = await Promise.all([
    db
      .selectFrom('flags')
      .select('key')
      .where('project_id', '=', project.id)
      .orderBy('key')
      .execute(),
    db
      .selectFrom('code_reference_branches as b')
      .leftJoin('code_references as r', 'r.branch_id', 'b.id')
      .select([
        'b.repository',
        'b.branch',
        'b.commit_sha',
        'b.url_template',
        'b.files_scanned',
        'b.scanned_at',
        'b.uploaded_by',
      ])
      .select((eb) => [
        eb.fn.count<string>('r.flag_key').as('flags'),
        eb.fn.coalesce(eb.fn.sum<string>('r.count'), sql<string>`0`).as('references'),
      ])
      .where('b.project_id', '=', project.id)
      .groupBy('b.id')
      .orderBy('b.repository')
      .orderBy('b.scanned_at', 'desc')
      .orderBy('b.branch')
      .execute(),
  ]);
  return {
    flagKeys: flags.map((f) => f.key),
    branches: branches.map((b) => ({
      ...branchView(b),
      flags: Number(b.flags),
      references: Number(b.references),
    })),
  };
}

/** Where one flag is referenced, per branch, newest scan first within each repository. */
export async function flagCodeReferences(
  db: Db,
  project: ProjectRow,
  flagKey: string,
): Promise<{ branches: FlagCodeBranch[] }> {
  const flag = await db
    .selectFrom('flags')
    .select('id')
    .where('project_id', '=', project.id)
    .where('key', '=', flagKey)
    .executeTakeFirst();
  if (flag === undefined) throw notFound(`flag "${flagKey}"`);
  const rows = await db
    .selectFrom('code_references as r')
    .innerJoin('code_reference_branches as b', 'b.id', 'r.branch_id')
    .select([
      'b.repository',
      'b.branch',
      'b.commit_sha',
      'b.url_template',
      'b.files_scanned',
      'b.scanned_at',
      'b.uploaded_by',
      'r.count',
      'r.hunks',
    ])
    .where('r.project_id', '=', project.id)
    .where('r.flag_key', '=', flagKey)
    .orderBy('b.repository')
    .orderBy('b.scanned_at', 'desc')
    .orderBy('b.branch')
    .execute();
  return {
    branches: rows.map((r) => ({ ...branchView(r), count: r.count, hunks: r.hunks })),
  };
}

/** Forgets a branch, typically once it is merged or deleted. */
export async function deleteCodeBranch(
  db: Db,
  project: ProjectRow,
  repository: string,
  branch: string,
): Promise<void> {
  const deleted = await db
    .deleteFrom('code_reference_branches')
    .where('project_id', '=', project.id)
    .where('repository', '=', repository)
    .where('branch', '=', branch)
    .executeTakeFirst();
  if (deleted.numDeletedRows === 0n) {
    throw notFound(`branch "${branch}" of repository "${repository}"`);
  }
}
