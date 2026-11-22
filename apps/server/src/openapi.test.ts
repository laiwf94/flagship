import { readFile, writeFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testApp, type TestApp } from '../test/app.js';
import { API_VERSION, ApiCatalog, operations, type OpenApiDocument } from './openapi.js';

const SNAPSHOT = new URL('../../../packages/admin-client/openapi.json', import.meta.url);

let t: TestApp;
let doc: OpenApiDocument;

beforeAll(async () => {
  t = await testApp();
  const res = await t.app.server.inject({ method: 'GET', url: '/api/openapi.json' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('no-cache');
  doc = res.json();
});

afterAll(async () => {
  await t.close();
});

function operation(
  path: string,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
): Record<string, any> {
  const op = doc.paths[path]?.[method];
  if (op === undefined) throw new Error(`no ${method} ${path}`);
  return op;
}

describe('GET /api/openapi.json', () => {
  it('is an OpenAPI 3.1 document served without signing in', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: '/api' }]);
    expect(doc.info.version).toBe(API_VERSION);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      'csrf',
      'session',
      'token',
    ]);
  });

  it('documents every /api route, and only routes that exist', () => {
    const documented: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        documented.push(`${method.toUpperCase()} ${path}`);
        const url = '/api' + path.replace(/\{([^}]+)\}/g, ':$1');
        expect(t.app.server.hasRoute({ method: method.toUpperCase(), url })).toBe(true);
      }
    }
    const registered = t.app.api.operations();
    expect(documented.sort()).toEqual([...registered].sort());
    // A sample from each route module, so an emptied catalog cannot pass.
    for (const op of [
      'GET /openapi.json',
      'POST /session',
      'POST /tokens',
      'PATCH /users/{id}',
      'POST /projects/import',
      'PUT /projects/{project}/flags/{flag}/environments/{environment}',
      'POST /projects/{project}/change-requests/{id}/apply',
      'GET /projects/{project}/experiments/{experiment}/results',
      'POST /projects/{project}/webhooks/{id}/replay',
      'GET /projects/{project}/audit',
    ]) {
      expect(documented).toContain(op);
    }
    expect(registered.length).toBeGreaterThanOrEqual(70);
  });

  it('gives every operation a unique id, a tag and an error response', () => {
    const ids = new Set<string>();
    for (const item of Object.values(doc.paths)) {
      for (const op of Object.values(item) as Record<string, any>[]) {
        expect(ids.has(op.operationId)).toBe(false);
        ids.add(op.operationId);
        expect(op.summary.length).toBeGreaterThan(0);
        expect(doc.tags.map((t) => t.name)).toContain(op.tags[0]);
        expect(op.responses.default).toEqual({ $ref: '#/components/responses/Error' });
      }
    }
  });

  it('turns path and query schemas into parameters with their constraints', () => {
    const list = operation('/projects/{project}/flags', 'get');
    const byName = Object.fromEntries(list.parameters.map((p: any) => [p.name, p]));
    expect(byName.project).toMatchObject({
      in: 'path',
      required: true,
      schema: { $ref: '#/components/schemas/Key' },
    });
    expect(byName.environment).toMatchObject({ in: 'query', required: true });
    expect(byName.limit).toMatchObject({
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    });
    expect(byName.status.schema.enum).toEqual(['on', 'off', 'rollout', 'archived']);
    const audit = operation('/projects/{project}/audit', 'get');
    const from = audit.parameters.find((p: any) => p.name === 'from');
    expect(from.schema).toMatchObject({ type: 'string', format: 'date-time' });
  });

  it('describes request bodies as named components that share the model schemas', () => {
    const create = operation('/projects/{project}/flags', 'post');
    expect(create.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateFlagBody' } } },
    });
    const body = doc.components.schemas.CreateFlagBody as Record<string, any>;
    expect(body.type).toBe('object');
    expect(body.additionalProperties).toBe(false);
    expect([...body.required].sort()).toEqual(['key', 'name', 'type']);
    expect(body.properties.variants.items).toEqual({ $ref: '#/components/schemas/Variant' });

    const targeting = doc.components.schemas.UpdateTargetingBody as Record<string, any>;
    expect(targeting.properties.rules.items).toEqual({ $ref: '#/components/schemas/Rule' });
    expect(targeting.properties.fallthrough).toEqual({ $ref: '#/components/schemas/Serve' });
    for (const name of ['Key', 'Rule', 'Serve', 'RolloutPlan', 'ProjectExport', 'Error']) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
    // Parameter objects are inlined, never left behind as components.
    expect(Object.keys(doc.components.schemas).filter((k) => /(Params|Query)$/.test(k))).toEqual(
      [],
    );
    const close = operation('/projects/{project}/change-requests/{id}/close', 'post');
    expect(close.requestBody.required).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('$schema');
    expect(JSON.stringify(doc)).not.toContain('$id');
  });

  it('states how each operation authenticates, with the token scope and role', () => {
    expect(operation('/session', 'post').security).toEqual([]);
    expect(operation('/session', 'post')['x-flagship-role']).toBe('none');
    expect(operation('/tokens', 'get').security).toEqual([{ session: [] }]);
    expect(operation('/tokens', 'post').security).toEqual([{ session: [], csrf: [] }]);
    expect(operation('/projects/{project}/flags', 'get').security).toEqual([
      { session: [] },
      { token: ['flags:read'] },
    ]);
    const create = operation('/projects/{project}/flags', 'post');
    expect(create.security).toEqual([{ session: [], csrf: [] }, { token: ['flags:write'] }]);
    expect(create['x-flagship-scope']).toBe('flags:write');
    expect(create['x-flagship-role']).toBe('editor');
    expect(operation('/users', 'get')['x-flagship-role']).toBe('admin');
  });

  it('lists the success statuses each operation can return', () => {
    expect(Object.keys(operation('/projects/{project}/flags', 'post').responses)).toEqual([
      '201',
      'default',
    ]);
    const revoke = operation('/tokens/{id}', 'delete').responses;
    expect(revoke['204']).toEqual({ description: 'No content' });
    const restore = operation('/projects/{project}/audit/{id}/restore', 'post').responses;
    expect(Object.keys(restore)).toEqual(['200', '201', 'default']);
    const exported = operation('/projects/{project}/export', 'get').responses['200'];
    expect(exported.headers['content-disposition']).toBeDefined();
  });

  it('matches the committed copy the admin client is generated from', async () => {
    const filepath = fileURLToPath(SNAPSHOT);
    const options = await resolveConfig(filepath);
    const text = await format(JSON.stringify(doc), { ...options, filepath });
    if (process.env.FLAGSHIP_UPDATE_OPENAPI === '1') {
      await writeFile(SNAPSHOT, text);
    }
    const committed = await readFile(SNAPSHOT, 'utf8');
    expect(committed, 'run `pnpm openapi` to regenerate the admin client').toBe(text);
  });

  it('keeps the API version equal to the server package version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(API_VERSION).toBe(pkg.version);
  });
});

describe('ApiCatalog', () => {
  const op = operations('test');

  async function register(add: (api: FastifyInstance) => void): Promise<ApiCatalog> {
    const catalog = new ApiCatalog('/api', '0.0.0');
    const server = Fastify();
    await server.register(
      async (api) => {
        api.addHook('onRoute', catalog.onRoute);
        add(api);
      },
      { prefix: '/api' },
    );
    await server.ready();
    await server.close();
    return catalog;
  }

  it('refuses a route that declares no operation', async () => {
    await expect(register((api) => api.get('/new', async () => ({})))).rejects.toThrow(
      'GET /api/new must declare an openapi operation',
    );
  });

  it('refuses path parameters that differ from the declared params', async () => {
    const params = z.object({ project: z.string() });
    await expect(
      register((api) =>
        api.get(
          '/projects/:project/things/:thing',
          { config: { openapi: op('getThing', 'A thing', { params }) } },
          async () => ({}),
        ),
      ),
    ).rejects.toThrow(
      'path parameters [project, thing] do not match the declared params [project]',
    );
    await expect(
      register((api) =>
        api.get('/x/:id', { config: { openapi: op('getX', 'X') } }, async () => ({})),
      ),
    ).rejects.toThrow('do not match');
  });

  it('refuses duplicate and malformed operation ids', async () => {
    await expect(
      register((api) => {
        api.get('/a', { config: { openapi: op('same', 'A') } }, async () => ({}));
        api.get('/b', { config: { openapi: op('same', 'B') } }, async () => ({}));
      }),
    ).rejects.toThrow('operation id "same" is taken');
    await expect(
      register((api) => api.get('/a', { config: { openapi: op('Get-A', 'A') } }, async () => ({}))),
    ).rejects.toThrow('is not camelCase');
  });

  it('refuses routes that share one declaration across methods', async () => {
    await expect(
      register((api) =>
        api.route({
          method: ['GET', 'POST'],
          url: '/both',
          config: { openapi: op('both', 'Both') },
          handler: async () => ({}),
        }),
      ),
    ).rejects.toThrow('one method per operation');
  });

  it('refuses query schemas that are not objects', async () => {
    const catalog = await register((api) =>
      api.get(
        '/q',
        { config: { public: true, openapi: op('q', 'Q', { query: z.string() }) } },
        async () => ({}),
      ),
    );
    expect(() => catalog.document()).toThrow('QQuery must be an object schema');
  });

  it('builds the document once and caches it', async () => {
    const catalog = await register((api) =>
      api.post(
        '/things',
        {
          config: {
            scope: 'flags:write',
            openapi: op('createThing', 'Create a thing', {
              body: z.strictObject({ name: z.string().describe('What to call it') }),
              status: [201],
            }),
          },
        },
        async () => ({}),
      ),
    );
    const first = catalog.document();
    expect(catalog.document()).toBe(first);
    expect(first.paths['/things']?.post?.security).toEqual([
      { session: [], csrf: [] },
      { token: ['flags:write'] },
    ]);
    expect(first.components.schemas.CreateThingBody).toMatchObject({
      properties: { name: { type: 'string', description: 'What to call it' } },
    });
  });
});
