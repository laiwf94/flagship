import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import { generateClient, typeOf, type Document } from '../codegen/generate.js';

const DOCUMENT = new URL('../openapi.json', import.meta.url);
const GENERATED = new URL('../src/operations.ts', import.meta.url);

async function formatted(document: Document): Promise<string> {
  const filepath = fileURLToPath(GENERATED);
  const options = await resolveConfig(filepath);
  return format(generateClient(document), { ...options, filepath });
}

describe('src/operations.ts', () => {
  it('is generated from the committed openapi.json', async () => {
    const document = JSON.parse(await readFile(DOCUMENT, 'utf8')) as Document;
    const text = await formatted(document);
    if (process.env.FLAGSHIP_UPDATE_OPENAPI === '1') await writeFile(GENERATED, text);
    expect(await readFile(GENERATED, 'utf8'), 'run `pnpm openapi`').toBe(text);
  });
});

describe('typeOf', () => {
  it('maps scalar types, consts and enums', () => {
    expect(typeOf({ type: 'string', maxLength: 5 })).toBe('string');
    expect(typeOf({ type: 'integer', minimum: 0 })).toBe('number');
    expect(typeOf({ type: ['string', 'null'] })).toBe('string | null');
    expect(typeOf({ type: 'string', const: 'fallthrough' })).toBe('"fallthrough"');
    expect(typeOf({ type: 'string', enum: ['on', 'off'] })).toBe('"on" | "off"');
    expect(typeOf({})).toBe('unknown');
    expect(typeOf(true)).toBe('unknown');
    expect(typeOf(false)).toBe('never');
  });

  it('maps references, unions and intersections', () => {
    expect(typeOf({ $ref: '#/components/schemas/Key' })).toBe('Key');
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number');
    expect(typeOf({ oneOf: [{ $ref: '#/components/schemas/A' }, { type: 'null' }] })).toBe(
      'A | null',
    );
    expect(typeOf({ anyOf: [{ type: 'string' }, {}] })).toBe('unknown');
    expect(
      typeOf({ allOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }] }),
    ).toBe('A & B');
  });

  it('maps arrays and tuples', () => {
    expect(typeOf({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(
      typeOf({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } }),
    ).toBe('(string | null)[]');
    expect(typeOf({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] })).toBe(
      '[string, number]',
    );
  });

  it('maps objects with required, optional and quoted properties', () => {
    const type = typeOf({
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key' },
        'x-y': { type: 'number' },
      },
      required: ['key'],
      additionalProperties: false,
    });
    expect(type).toBe('{\n  /** The key */\n  key: string;\n  "x-y"?: number;\n}');
    expect(typeOf({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      '{ [key: string]: number }',
    );
    expect(typeOf({ type: 'object' })).toBe('{ [key: string]: unknown }');
    expect(typeOf({ type: 'object', additionalProperties: false })).toBe('Record<string, never>');
    expect(typeOf({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toBe(
      '{\n  a: string;\n} & { [key: string]: unknown }',
    );
  });

  it('refuses what it cannot express rather than widening it', () => {
    expect(() => typeOf({ type: 'string', if: {} })).toThrow('unsupported schema keyword "if"');
    expect(() => typeOf({ $ref: 'https://example.com/x.json' })).toThrow('unsupported $ref');
    expect(() => typeOf({ type: 'date' })).toThrow('unsupported type "date"');
    expect(() => typeOf('string')).toThrow('not a schema');
  });
});

describe('generateClient', () => {
  const base: Document = {
    openapi: '3.1.0',
    paths: {
      '/things/{id}': {
        get: {
          operationId: 'getThing',
          summary: 'A thing',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'full', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          ],
          responses: { '200': {}, default: {} },
          'x-flagship-scope': 'things:read',
        },
        delete: {
          operationId: 'deleteThing',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': {} },
        },
      },
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
          },
          responses: { '201': {} },
        },
        get: { operationId: 'listThings', responses: { '200': {} } },
      },
    },
    components: {
      schemas: {
        Thing: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
  };

  it('emits component types, parameter types and one method per operation', () => {
    const out = generateClient(base);
    expect(out).toContain('export type Thing = {\n  name: string;\n};');
    expect(out).toContain(
      'export type GetThingQuery = {\n  full?: "true" | "false" | undefined;\n};',
    );
    expect(out).toContain(
      'getThing(args: { path: GetThingPath; query?: GetThingQuery }): Promise<unknown>',
    );
    expect(out).toContain('createThing(args: { body: Thing }): Promise<unknown>');
    expect(out).toContain('deleteThing(args: { path: DeleteThingPath }): Promise<void>');
    expect(out).toContain('listThings(): Promise<unknown>');
    expect(out).toContain('Token scope: things:read.');
    expect(out).toContain(
      "getThing: { method: 'GET', path: '/things/{id}', params: ['id'], empty: false },",
    );
    // Operations are sorted by id, so the output does not depend on path order.
    expect(out.indexOf('  createThing(')).toBeLessThan(out.indexOf('  deleteThing('));
  });

  it('makes the whole argument optional when nothing in it is required', () => {
    const doc: Document = {
      openapi: '3.1.0',
      paths: {
        '/close': {
          post: {
            operationId: 'close',
            requestBody: {
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            responses: { '200': {} },
          },
        },
      },
    };
    expect(generateClient(doc)).toContain(
      'close(args: { body?: { [key: string]: unknown } } = {}): Promise<unknown>',
    );
  });

  it('refuses documents it cannot generate a faithful client for', () => {
    expect(() => generateClient({ ...base, openapi: '3.0.3' })).toThrow('expected OpenAPI 3.1');
    const header: Document = {
      openapi: '3.1.0',
      paths: {
        '/h': {
          get: {
            operationId: 'h',
            parameters: [{ name: 'x', in: 'header', schema: { type: 'string' } }],
            responses: {},
          },
        },
      },
    };
    expect(() => generateClient(header)).toThrow('header parameters are not supported');
    const form: Document = {
      openapi: '3.1.0',
      paths: {
        '/f': {
          post: {
            operationId: 'f',
            requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
            responses: {},
          },
        },
      },
    };
    expect(() => generateClient(form)).toThrow('only JSON request bodies');
    expect(() =>
      generateClient({
        openapi: '3.1.0',
        paths: { '/x': { get: { operationId: 'a-b', responses: {} } } },
      }),
    ).toThrow('bad operationId');
  });
});
