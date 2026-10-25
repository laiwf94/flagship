import type { Db } from '../db/database.js';
import type { Role } from '../db/schema.js';
import { hashPassword } from '../auth/passwords.js';
import { AppError } from '../errors.js';
import { recordAudit, type Actor } from './audit.js';

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
}

const columns = ['id', 'email', 'name', 'role', 'disabled_at', 'created_at'] as const;

function view(row: {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled_at: Date | null;
  created_at: Date;
}): UserView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: row.disabled_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export async function listUsers(db: Db): Promise<UserView[]> {
  const rows = await db.selectFrom('users').select(columns).orderBy('email').execute();
  return rows.map(view);
}

export async function createUser(
  db: Db,
  input: { email: string; name: string; role: Role; password: string },
  actor: Actor | null,
): Promise<UserView> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('users')
        .values({
          email: input.email.toLowerCase(),
          name: input.name,
          role: input.role,
          password_hash: passwordHash,
        })
        .returning(columns)
        .executeTakeFirstOrThrow();
      const created = view(row);
      await recordAudit(trx, {
        projectId: null,
        actor: actor ?? { id: null, name: 'bootstrap' },
        action: 'user.create',
        targetType: 'user',
        targetKey: created.email,
        after: { email: created.email, name: created.name, role: created.role },
      });
      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('already_exists', 'a user with that email exists');
    throw err;
  }
}

export async function updateUser(
  db: Db,
  id: string,
  patch: { name?: string | undefined; role?: Role | undefined; disabled?: boolean | undefined },
  actor: Actor & { id: string },
): Promise<UserView> {
  if (id === actor.id && (patch.role !== undefined || patch.disabled !== undefined)) {
    throw new AppError('invalid_argument', "you can't change your own role or disable yourself");
  }
  return db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('users')
      .select(columns)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (before === undefined) throw new AppError('not_found', 'user not found');
    const set: { name?: string; role?: Role; disabled_at?: Date | null } = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.disabled !== undefined) set.disabled_at = patch.disabled ? new Date() : null;
    const row =
      Object.keys(set).length === 0
        ? before
        : await trx
            .updateTable('users')
            .set(set)
            .where('id', '=', id)
            .returning(columns)
            .executeTakeFirstOrThrow();
    if (patch.disabled === true || (patch.role !== undefined && patch.role !== before.role)) {
      await trx.deleteFrom('sessions').where('user_id', '=', id).execute();
    }
    const b = view(before);
    const a = view(row);
    await recordAudit(trx, {
      projectId: null,
      actor,
      action: 'user.update',
      targetType: 'user',
      targetKey: a.email,
      before: { name: b.name, role: b.role, disabled: b.disabled },
      after: { name: a.name, role: a.role, disabled: a.disabled },
    });
    return a;
  });
}

/** Creates the configured first admin when the users table is empty. */
export async function bootstrapAdmin(
  db: Db,
  admin: { email: string; password: string } | undefined,
): Promise<UserView | undefined> {
  if (admin === undefined) return undefined;
  const existing = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  if (existing.n > 0) return undefined;
  try {
    return await createUser(
      db,
      { email: admin.email, name: 'Admin', role: 'admin', password: admin.password },
      null,
    );
  } catch (err) {
    // Another instance won the race; that is the outcome we wanted anyway.
    if (err instanceof AppError && err.code === 'already_exists') return undefined;
    throw err;
  }
}
