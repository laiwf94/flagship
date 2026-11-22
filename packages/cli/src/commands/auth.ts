import { AdminApiError, AdminClient } from '@flagship/admin-client';
import { bool, normalizeServer, str, type Command, type Context } from '../command.js';
import { checkProfileName, profileOf, type Profile } from '../config.js';
import { CliError, UsageError } from '../errors.js';
import { fields, table } from '../output.js';

interface SessionBody {
  user: { id: string; email: string; name: string; role: string };
}

/** Standard input up to the end, without the newline `echo` adds. */
async function secretFromStdin(ctx: Context, what: string): Promise<string> {
  const text = (await ctx.io.readStdin()).replace(/\r?\n$/, '');
  if (text === '') throw new UsageError(`no ${what} on standard input`);
  return text;
}

/** The profile without its credentials, for output: tokens and cookies are never printed. */
export function redact(name: string, p: Profile, current: string) {
  return {
    name,
    current: name === current,
    server: p.server ?? null,
    project: p.project ?? null,
    environment: p.environment ?? null,
    auth: p.token ? 'token' : p.session ? 'session' : null,
    user: p.user ?? null,
  };
}

async function verifyToken(ctx: Context, server: string, token: string): Promise<void> {
  const client = new AdminClient({ ...ctx.clientOptions(), baseUrl: server, token });
  try {
    await client.listProjects();
  } catch (e) {
    // 403 means the token is good but scoped to one project or to other routes.
    if (e instanceof AdminApiError && e.status === 403) return;
    if (e instanceof AdminApiError && e.status === 401) {
      throw new CliError(e.code, `the server refused the token: ${e.message}`);
    }
    throw e;
  }
}

const login: Command = {
  path: ['login'],
  summary: 'Sign in to a server and save the credentials in a profile',
  details: [
    'With --email, signs in with a password and saves the session (it ends after 12 hours idle',
    'or 7 days). With --token-stdin or FLAGSHIP_TOKEN, saves an API token instead. The password',
    'comes from --password-stdin, FLAGSHIP_PASSWORD or a prompt. The config file is written',
    'with mode 0600; set FLAGSHIP_CONFIG to put it elsewhere.',
  ].join('\n'),
  options: {
    email: { type: 'string', value: 'EMAIL', description: 'Sign in as this user' },
    'password-stdin': { type: 'boolean', description: 'Read the password from standard input' },
    'token-stdin': { type: 'boolean', description: 'Read an API token from standard input' },
  },
  async run(ctx, values) {
    const name = checkProfileName(ctx.profileName);
    const server = ctx.server();
    const email = str(values, 'email');
    const tokenStdin = bool(values, 'token-stdin');
    if (email !== undefined && tokenStdin) {
      throw new UsageError('use either --email or --token-stdin, not both');
    }
    const profile: Profile = { ...ctx.profile, server };
    delete profile.token;
    delete profile.session;
    delete profile.user;
    for (const field of ['project', 'environment'] as const) {
      const v = str(ctx.globals, field);
      if (v !== undefined) profile[field] = v;
    }

    let user: string | null = null;
    if (email === undefined) {
      const token = tokenStdin ? await secretFromStdin(ctx, 'token') : ctx.io.env.FLAGSHIP_TOKEN;
      if (token === undefined || token === '') {
        throw new UsageError('pass --email EMAIL, --token-stdin, or set FLAGSHIP_TOKEN');
      }
      await verifyToken(ctx, server, token);
      profile.token = token;
    } else {
      let password: string;
      if (bool(values, 'password-stdin')) password = await secretFromStdin(ctx, 'password');
      else if (ctx.io.env.FLAGSHIP_PASSWORD) password = ctx.io.env.FLAGSHIP_PASSWORD;
      else if (ctx.io.promptSecret) password = await ctx.io.promptSecret(`Password for ${email}: `);
      else {
        throw new UsageError(
          'no password: pass --password-stdin, set FLAGSHIP_PASSWORD, or run in a terminal',
        );
      }
      const client = await AdminClient.login(
        { ...ctx.clientOptions(), baseUrl: server },
        email,
        password,
      );
      const session = client.session;
      if (session === undefined) throw new CliError('internal', 'sign-in returned no session');
      const body = (await client.getSession()) as SessionBody;
      profile.session = session;
      profile.user = body.user.email;
      user = body.user.email;
    }
    await ctx.saveProfile(name, profile);
    const shown = redact(name, profile, ctx.config.current);
    return {
      json: shown,
      text: `Signed in to ${server}${user ? ` as ${user}` : ' with a token'}; saved as profile "${name}"${
        shown.current ? '' : ` (use it with --profile ${name} or flagship profile use ${name})`
      }.`,
    };
  },
};

const logout: Command = {
  path: ['logout'],
  summary: "End the profile's session and forget its credentials",
  details: 'A token is only forgotten here; revoke it in the admin UI or API to end it.',
  async run(ctx) {
    const p = profileOf(ctx.config, ctx.profileName);
    if (p === undefined || (p.token === undefined && p.session === undefined)) {
      return {
        json: { profile: ctx.profileName, signedOut: false },
        text: `Profile "${ctx.profileName}" is not signed in.`,
      };
    }
    let ended = false;
    if (p.session !== undefined && p.token === undefined && p.server !== undefined) {
      try {
        await new AdminClient({
          ...ctx.clientOptions(),
          baseUrl: p.server,
          session: p.session,
        }).signOut();
        ended = true;
      } catch (e) {
        // An expired or revoked session is already over; anything else is worth reporting.
        if (!(e instanceof AdminApiError && e.status === 401)) throw e;
      }
    }
    delete p.token;
    delete p.session;
    delete p.user;
    await ctx.saveConfig();
    return {
      json: { profile: ctx.profileName, signedOut: true, sessionEnded: ended },
      text: `Signed out of profile "${ctx.profileName}".`,
    };
  },
};

const whoami: Command = {
  path: ['whoami'],
  summary: 'Show who the current profile acts as',
  async run(ctx) {
    const server = ctx.server();
    const creds = ctx.credentials();
    if ('token' in creds) {
      return {
        json: { profile: ctx.profileName, server, auth: 'token', user: null },
        text: fields([
          ['profile', ctx.profileName],
          ['server', server],
          ['auth', 'API token'],
        ]),
      };
    }
    const body = await ctx.call<SessionBody>((c) => c.getSession());
    return {
      json: { profile: ctx.profileName, server, auth: 'session', user: body.user },
      text: fields([
        ['profile', ctx.profileName],
        ['server', server],
        ['user', `${body.user.name} <${body.user.email}>`],
        ['role', body.user.role],
      ]),
    };
  },
};

const profileList: Command = {
  path: ['profile', 'list'],
  summary: 'List the profiles in the config file',
  async run(ctx) {
    const rows = Object.entries(ctx.config.profiles).map(([n, p]) =>
      redact(n, p, ctx.config.current),
    );
    return {
      json: { current: ctx.config.current, profiles: rows },
      text:
        rows.length === 0
          ? 'No profiles yet: run flagship login --server URL.'
          : table(
              ['', 'PROFILE', 'SERVER', 'PROJECT', 'ENVIRONMENT', 'AUTH'],
              rows.map((r) => [
                r.current ? '*' : '',
                r.name,
                r.server ?? '-',
                r.project ?? '-',
                r.environment ?? '-',
                r.auth === null ? 'signed out' : r.user ? `${r.auth} (${r.user})` : r.auth,
              ]),
            ),
    };
  },
};

function existing(ctx: Context, name: string): Profile {
  const p = profileOf(ctx.config, name);
  if (p === undefined) throw new UsageError(`no profile "${name}": see flagship profile list`);
  return p;
}

const profileShow: Command = {
  path: ['profile', 'show'],
  summary: 'Show one profile (the current one by default)',
  args: '[name]',
  arity: [0, 1],
  async run(ctx, _values, [name = ctx.profileName]) {
    const shown = redact(name, existing(ctx, name), ctx.config.current);
    return {
      json: shown,
      text: fields([
        ['profile', `${shown.name}${shown.current ? ' (current)' : ''}`],
        ['server', shown.server ?? '-'],
        ['project', shown.project ?? '-'],
        ['environment', shown.environment ?? '-'],
        ['auth', shown.auth === null ? 'signed out' : shown.auth],
        ['user', shown.user ?? '-'],
      ]),
    };
  },
};

const profileUse: Command = {
  path: ['profile', 'use'],
  summary: 'Make a profile the current one',
  args: '<name>',
  arity: [1, 1],
  async run(ctx, _values, [name = '']) {
    existing(ctx, name);
    ctx.config.current = name;
    await ctx.saveConfig();
    return { json: { current: name }, text: `Now using profile "${name}".` };
  },
};

const profileSet: Command = {
  path: ['profile', 'set'],
  summary: "Set a profile's server, project or environment (creates the profile if needed)",
  details:
    'Takes the global --server, --project and --environment; an empty value removes the default.',
  async run(ctx) {
    const name = checkProfileName(ctx.profileName);
    const p: Profile = { ...profileOf(ctx.config, name) };
    let changed = false;
    for (const field of ['server', 'project', 'environment'] as const) {
      const v = str(ctx.globals, field);
      if (v === undefined) continue;
      changed = true;
      if (v === '') Reflect.deleteProperty(p, field);
      else p[field] = field === 'server' ? normalizeServer(v) : v;
    }
    if (!changed) throw new UsageError('pass --server, --project or --environment to set');
    await ctx.saveProfile(name, p);
    const shown = redact(name, p, ctx.config.current);
    return { json: shown, text: `Updated profile "${name}".` };
  },
};

const profileRemove: Command = {
  path: ['profile', 'remove'],
  summary: 'Delete a profile and its saved credentials',
  args: '<name>',
  arity: [1, 1],
  async run(ctx, _values, [name = '']) {
    existing(ctx, name);
    ctx.config.profiles = Object.fromEntries(
      Object.entries(ctx.config.profiles).filter(([n]) => n !== name),
    );
    if (ctx.config.current === name) {
      ctx.config.current = Object.keys(ctx.config.profiles)[0] ?? 'default';
    }
    await ctx.saveConfig();
    return {
      json: { removed: name, current: ctx.config.current },
      text: `Removed profile "${name}".`,
    };
  },
};

export const authCommands: Command[] = [
  login,
  logout,
  whoami,
  profileList,
  profileShow,
  profileUse,
  profileSet,
  profileRemove,
];
