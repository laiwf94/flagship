import {
  keySchema,
  prerequisiteSchema,
  rolloutPlanSchema,
  ruleSchema,
  segmentRuleSchema,
  serveSchema,
  variantSchema,
} from '@flagship/core';
import { z } from 'zod';
import type { Scope } from './auth/scopes.js';
import { SESSION_COOKIE } from './auth/sessions.js';
import type { Role } from './db/schema.js';
import { ERROR_STATUS } from './errors.js';
import { changeSchema } from './services/schedules.js';
import { exportDocumentSchema } from './services/transfer.js';

/** What a route declares about itself for the OpenAPI document. */
export interface OperationDoc {
  /** Stable camelCase name; the generated client's method name. */
  id: string;
  summary: string;
  tag: string;
  description?: string;
  /** Path parameters; its keys must match the route's `:params` exactly. */
  params?: z.ZodType;
  /** Query string parameters, as one object schema. */
  query?: z.ZodType;
  /** JSON request body. */
  body?: z.ZodType;
  /** The body may be left out entirely. */
  bodyOptional?: boolean;
  /** Success statuses, the usual one first. 204 has no body. Defaults to 200. */
  status?: readonly SuccessStatus[];
  /** The JSON response is sent as a file download. */
  download?: boolean;
}

export type SuccessStatus = 200 | 201 | 202 | 204;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** How the route appears in GET /api/openapi.json. Required on every /api route. */
    openapi?: OperationDoc;
  }
}

/** Builds operation declarations for one tag: `op('listFlags', 'List flags', { query })`. */
export function operations(tag: string) {
  return (
    id: string,
    summary: string,
    rest: Omit<OperationDoc, 'id' | 'summary' | 'tag'> = {},
  ): OperationDoc => ({ id, summary, tag, ...rest });
}

/**
 * Model schemas from @flagship/core that many bodies share. They become named
 * components (and named types in the generated client) instead of being
 * repeated inline in every operation.
 */
const SHARED: readonly [z.ZodType, string][] = [
  [exportDocumentSchema, 'ProjectExport'],
  [keySchema, 'Key'],
  // Recursive, so it can only be described by reference.
  [variantSchema.shape.value, 'JsonValue'],
  [variantSchema, 'Variant'],
  [prerequisiteSchema, 'Prerequisite'],
  [ruleSchema, 'Rule'],
  [serveSchema, 'Serve'],
  [segmentRuleSchema, 'SegmentRule'],
  [rolloutPlanSchema, 'RolloutPlan'],
  [changeSchema, 'ScheduledChange'],
];

/** The admin API's version; kept equal to apps/server/package.json by a test. */
export const API_VERSION = '0.1.0';

const ID = /^[a-z][A-Za-z0-9]*$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PATH_PARAM = /:([A-Za-z0-9_]+)/g;
const STATUS_TEXT: Record<SuccessStatus, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
};

export type JsonSchema = Record<string, unknown>;

interface CatalogRoute {
  method: string;
  /** OpenAPI path relative to the server URL, e.g. /projects/{project}/flags. */
  path: string;
  doc: OperationDoc;
  public: boolean;
  sessionOnly: boolean;
  scope: Scope | undefined;
  role: Role | undefined;
}

interface RouteLike {
  method: string | string[];
  url: string;
  config?: unknown;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string }[];
  paths: Record<string, Record<string, JsonSchema>>;
  components: {
    schemas: Record<string, JsonSchema>;
    responses: Record<string, JsonSchema>;
    securitySchemes: Record<string, JsonSchema>;
  };
}

function pascal(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Removes `$schema` markers, which OpenAPI schemas do not carry. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '$schema') continue;
    out[k] = strip(v);
  }
  return out;
}

/**
 * Collects the /api routes as they register and turns their declared Zod
 * schemas into an OpenAPI 3.1 document. Registration fails for a route that
 * declares no operation, reuses an operation id, or whose path parameter
 * schema does not match its URL, so the document cannot silently fall behind
 * the routes.
 */
export class ApiCatalog {
  private readonly routes: CatalogRoute[] = [];
  private readonly ids = new Set<string>();
  private cached: OpenApiDocument | undefined;

  constructor(
    private readonly prefix: string,
    private readonly version: string,
  ) {}

  /** onRoute hook for the /api plugin. */
  readonly onRoute = (route: RouteLike): void => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter(
      (m) => m !== 'HEAD',
    );
    if (methods.length === 0) return;
    const config = (route.config ?? {}) as {
      openapi?: OperationDoc;
      public?: boolean;
      sessionOnly?: boolean;
      scope?: Scope;
      role?: Role;
    };
    const label = `${methods.join(',')} ${route.url}`;
    const doc = config.openapi;
    if (doc === undefined) throw new Error(`${label} must declare an openapi operation`);
    if (methods.length !== 1) throw new Error(`${label} must register one method per operation`);
    if (!ID.test(doc.id)) throw new Error(`${label}: operation id "${doc.id}" is not camelCase`);
    if (this.ids.has(doc.id)) throw new Error(`${label}: operation id "${doc.id}" is taken`);
    if (!route.url.startsWith(this.prefix)) {
      throw new Error(`${label} is outside ${this.prefix}`);
    }
    const names = [...route.url.matchAll(PATH_PARAM)].map((m) => m[1] ?? '');
    const declared = doc.params === undefined ? [] : objectKeys(doc.params);
    if (names.slice().sort().join(',') !== declared.slice().sort().join(',')) {
      throw new Error(
        `${label}: path parameters [${names.join(', ')}] do not match the declared ` +
          `params [${declared.join(', ')}]`,
      );
    }
    this.ids.add(doc.id);
    this.cached = undefined;
    this.routes.push({
      method: methods[0] ?? 'GET',
      path: route.url.slice(this.prefix.length).replace(PATH_PARAM, '{$1}') || '/',
      doc,
      public: config.public === true,
      sessionOnly: config.sessionOnly === true,
      scope: config.scope,
      role: config.role,
    });
  };

  /** Every registered operation as `METHOD /path`, for coverage checks. */
  operations(): string[] {
    return this.routes.map((r) => `${r.method} ${r.path}`);
  }

  document(): OpenApiDocument {
    this.cached ??= this.build();
    return this.cached;
  }

  private build(): OpenApiDocument {
    const registry = z.registry<{ id: string }>();
    const idOf = (schema: z.ZodType, id: string): string => {
      const existing = registry.get(schema)?.id;
      if (existing !== undefined) return existing;
      registry.add(schema, { id });
      return id;
    };
    for (const [schema, id] of SHARED) idOf(schema, id);
    // Parameter objects are registered only so they share one conversion
    // with the bodies; they are split into parameters and then dropped.
    const inlined = new Set<string>();
    const refs = this.routes.map((r) => {
      const name = pascal(r.doc.id);
      const params = r.doc.params === undefined ? undefined : idOf(r.doc.params, `${name}Params`);
      const query = r.doc.query === undefined ? undefined : idOf(r.doc.query, `${name}Query`);
      const body = r.doc.body === undefined ? undefined : idOf(r.doc.body, `${name}Body`);
      if (params !== undefined) inlined.add(params);
      if (query !== undefined) inlined.add(query);
      return { params, query, body };
    });
    for (const ref of refs) if (ref.body !== undefined) inlined.delete(ref.body);

    const converted = z.toJSONSchema(registry, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
      uri: (id) => `#/components/schemas/${id}`,
    });
    const all = strip(converted.schemas) as Record<string, JsonSchema>;
    // Components are addressed by their key; the converter's $id repeats it.
    for (const schema of Object.values(all)) delete schema.$id;

    const paths: OpenApiDocument['paths'] = {};
    const tags = new Set<string>();
    this.routes.forEach((r, i) => {
      const ref = refs[i] ?? { params: undefined, query: undefined, body: undefined };
      tags.add(r.doc.tag);
      const parameters = [
        ...parametersOf(all, ref.params, 'path'),
        ...parametersOf(all, ref.query, 'query'),
      ];
      const operation: JsonSchema = {
        operationId: r.doc.id,
        summary: r.doc.summary,
        ...(r.doc.description === undefined ? {} : { description: r.doc.description }),
        tags: [r.doc.tag],
        ...(parameters.length === 0 ? {} : { parameters }),
        ...(ref.body === undefined
          ? {}
          : {
              requestBody: {
                required: r.doc.bodyOptional !== true,
                content: {
                  'application/json': { schema: { $ref: `#/components/schemas/${ref.body}` } },
                },
              },
            }),
        responses: responsesOf(r.doc),
        security: securityOf(r),
        ...(r.scope === undefined ? {} : { 'x-flagship-scope': r.scope }),
        'x-flagship-role': r.public ? 'none' : (r.role ?? 'viewer'),
      };
      (paths[r.path] ??= {})[r.method.toLowerCase()] = operation;
    });

    const schemas: Record<string, JsonSchema> = {};
    for (const id of Object.keys(all).sort()) {
      const schema = all[id];
      if (schema !== undefined && !inlined.has(id)) schemas[id] = schema;
    }
    schemas.Error = errorSchema();
    const document: OpenApiDocument = {
      openapi: '3.1.0',
      info: {
        title: 'flagship admin API',
        version: this.version,
        description:
          'Manage projects, flags, segments, change requests, experiments and webhooks. ' +
          'Authenticate with an API token (Authorization: Bearer fst_...) or a session cookie ' +
          'plus its CSRF token on state-changing requests. Errors share one body: ' +
          '{"error": {"code", "message", "request_id", "details"}}.',
      },
      servers: [{ url: this.prefix }],
      tags: [...tags].sort().map((name) => ({ name })),
      paths: sortKeys(paths),
      components: {
        schemas,
        responses: {
          Error: {
            description: 'The request failed; see error.code.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
          csrf: { type: 'apiKey', in: 'header', name: 'x-csrf-token' },
          token: { type: 'http', scheme: 'bearer', bearerFormat: 'fst_...' },
        },
      },
    };
    // A dangling reference means a component was dropped that a body uses.
    const text = JSON.stringify(document);
    for (const m of text.matchAll(/"#\/components\/schemas\/([^"]+)"/g)) {
      const id = m[1] ?? '';
      if (!(id in schemas)) throw new Error(`dangling reference to ${id}`);
    }
    return document;
  }
}

function objectKeys(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return Object.keys(json.properties ?? {});
}

function parametersOf(
  all: Record<string, JsonSchema>,
  id: string | undefined,
  where: 'path' | 'query',
): JsonSchema[] {
  if (id === undefined) return [];
  const schema = all[id];
  if (schema?.type !== 'object') throw new Error(`${id} must be an object schema`);
  const required = new Set((schema.required ?? []) as string[]);
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: where,
      required: where === 'path' || required.has(name),
      ...(typeof description === 'string' ? { description } : {}),
      schema: rest,
    };
  });
}

function responsesOf(doc: OperationDoc): JsonSchema {
  const responses: JsonSchema = {};
  for (const status of doc.status ?? [200]) {
    responses[String(status)] =
      status === 204
        ? { description: STATUS_TEXT[status] }
        : {
            description: STATUS_TEXT[status],
            ...(doc.download === true
              ? {
                  headers: {
                    'content-disposition': {
                      description: 'attachment; filename="<project>-<date>.flagship.json"',
                      schema: { type: 'string' },
                    },
                  },
                }
              : {}),
            content: { 'application/json': { schema: { type: 'object' } } },
          };
  }
  responses.default = { $ref: '#/components/responses/Error' };
  return responses;
}

function securityOf(r: CatalogRoute): JsonSchema[] {
  if (r.public) return [];
  const session: JsonSchema = SAFE_METHODS.has(r.method)
    ? { session: [] }
    : { session: [], csrf: [] };
  if (r.sessionOnly || r.scope === undefined) return [session];
  return [session, { token: [r.scope] }];
}

function errorSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', enum: Object.keys(ERROR_STATUS) },
          message: { type: 'string' },
          request_id: { type: 'string' },
          details: {
            description:
              'For invalid_argument, one {path, message} entry per problem; ' +
              'other codes may carry an object describing the conflict.',
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { path: { type: 'string' }, message: { type: 'string' } },
                  required: ['path', 'message'],
                },
              },
              { type: 'object' },
            ],
          },
        },
        required: ['code', 'message', 'request_id'],
      },
    },
    required: ['error'],
  };
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}
