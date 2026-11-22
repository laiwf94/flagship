/**
 * Turns the admin API's OpenAPI 3.1 document into src/operations.ts: one
 * TypeScript type per component schema, path, query and body types per
 * operation, and an abstract class with one method per operation that the
 * runtime client in src/client.ts implements.
 *
 * It covers the JSON Schema subset that Zod's converter emits ($ref, anyOf,
 * oneOf, allOf, const, enum, type and type arrays, object properties with
 * additionalProperties, arrays with items or prefixItems) and refuses
 * anything else, so a new construct fails loudly instead of becoming `any`.
 */

export type Schema = Record<string, unknown>;

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Schema;
}

interface Operation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
  responses: Record<string, unknown>;
  'x-flagship-scope'?: string;
}

export interface Document {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const KNOWN = new Set([
  '$ref',
  'anyOf',
  'oneOf',
  'allOf',
  'const',
  'enum',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  // Constraints and annotations: they narrow values but not their TypeScript type.
  'description',
  'default',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'examples',
  'title',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

function pascal(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function refName(ref: string): string {
  const match = /^#\/components\/schemas\/([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(ref);
  if (match?.[1] === undefined) throw new Error(`unsupported $ref ${ref}`);
  return match[1];
}

function propertyKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function doc(text: unknown, indent: string): string {
  if (typeof text !== 'string' || text.trim() === '') return '';
  const lines = text.replace(/\*\//g, '*\\/').split('\n');
  if (lines.length === 1) return `${indent}/** ${lines[0] ?? ''} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.trimEnd()).join('\n')}\n${indent} */\n`;
}

function union(parts: string[]): string {
  const unique = [...new Set(parts)];
  if (unique.includes('unknown')) return 'unknown';
  return unique.length === 0 ? 'never' : unique.join(' | ');
}

function wrap(type: string): string {
  return /^[A-Za-z0-9_$.]+$|^".*"$|^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(type) && !type.includes(' | ')
    ? type
    : `(${type})`;
}

/** The TypeScript type for a schema, written for input (what a caller may send). */
export function typeOf(schema: unknown, indent = ''): string {
  if (schema === true || schema === undefined) return 'unknown';
  if (schema === false) return 'never';
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`not a schema: ${JSON.stringify(schema)}`);
  }
  const s = schema as Schema;
  for (const key of Object.keys(s)) {
    if (!KNOWN.has(key)) throw new Error(`unsupported schema keyword "${key}"`);
  }
  const parts: string[] = [];
  if (typeof s.$ref === 'string') parts.push(refName(s.$ref));
  if ('const' in s) {
    parts.push(JSON.stringify(s.const));
  } else if (Array.isArray(s.enum)) {
    parts.push(union(s.enum.map((v) => JSON.stringify(v))));
  } else if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as unknown[]) : [s.type];
    parts.push(union(types.map((t) => primitive(String(t), s, indent))));
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = s[key];
    if (Array.isArray(options)) parts.push(union(options.map((o) => typeOf(o, indent))));
  }
  if (Array.isArray(s.allOf)) {
    parts.push(s.allOf.map((o) => wrap(typeOf(o, indent))).join(' & '));
  }
  if (parts.length === 0) return 'unknown';
  return parts.length === 1 ? (parts[0] ?? 'unknown') : parts.map(wrap).join(' & ');
}

function primitive(type: string, s: Schema, indent: string): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      if (Array.isArray(s.prefixItems)) {
        return `[${s.prefixItems.map((i) => typeOf(i, indent)).join(', ')}]`;
      }
      return `${wrap(typeOf(s.items, indent))}[]`;
    }
    case 'object':
      return objectType(s, indent);
    default:
      throw new Error(`unsupported type "${type}"`);
  }
}

function objectType(s: Schema, indent: string): string {
  const properties = (s.properties ?? {}) as Record<string, Schema>;
  const required = new Set((s.required ?? []) as string[]);
  const extra = s.additionalProperties;
  const names = Object.keys(properties);
  const inner = `${indent}  `;
  const body = names
    .map((name) => {
      const p = properties[name];
      const optional = required.has(name) ? '' : '?';
      return `${doc(p?.description, inner)}${inner}${propertyKey(name)}${optional}: ${typeOf(p, inner)};\n`;
    })
    .join('');
  const fixed = names.length === 0 ? undefined : `{\n${body}${indent}}`;
  const open =
    extra === false
      ? undefined
      : `{ [key: string]: ${extra === undefined || extra === true ? 'unknown' : typeOf(extra, indent)} }`;
  if (fixed === undefined) return open ?? 'Record<string, never>';
  return open === undefined ? fixed : `${fixed} & ${open}`;
}

/**
 * An optional parameter also takes `undefined`, which is left out of the URL,
 * so callers can pass through values they may not have.
 */
function parametersType(params: Parameter[], indent: string): string {
  const inner = `${indent}  `;
  const lines = params.map((p) => {
    const type = typeOf(p.schema, inner);
    const field = p.required === true ? `: ${type}` : `?: ${union([type, 'undefined'])}`;
    return `${doc(p.description, inner)}${inner}${propertyKey(p.name)}${field};\n`;
  });
  return `{\n${lines.join('')}${indent}}`;
}

interface Planned {
  id: string;
  method: string;
  path: string;
  op: Operation;
  pathParams: Parameter[];
  queryParams: Parameter[];
  body: { type: string; required: boolean } | undefined;
  empty: boolean;
}

function plan(document: Document): Planned[] {
  const planned: Planned[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (op === undefined) continue;
      if (!IDENT.test(op.operationId)) throw new Error(`bad operationId ${op.operationId}`);
      const params = op.parameters ?? [];
      for (const p of params) {
        if (p.in !== 'path' && p.in !== 'query') {
          throw new Error(`${op.operationId}: ${p.in} parameters are not supported`);
        }
      }
      const json = op.requestBody?.content['application/json'];
      if (op.requestBody !== undefined && json === undefined) {
        throw new Error(`${op.operationId}: only JSON request bodies are supported`);
      }
      const statuses = Object.keys(op.responses).filter((s) => /^2\d\d$/.test(s));
      planned.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        op,
        pathParams: params.filter((p) => p.in === 'path'),
        queryParams: params.filter((p) => p.in === 'query'),
        body:
          json === undefined
            ? undefined
            : { type: typeOf(json.schema, '    '), required: op.requestBody?.required === true },
        empty: statuses.length > 0 && statuses.every((s) => s === '204'),
      });
    }
  }
  return planned.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The source of src/operations.ts for a document (before formatting). */
export function generateClient(document: Document): string {
  if (!document.openapi.startsWith('3.1.')) {
    throw new Error(`expected OpenAPI 3.1, got ${document.openapi}`);
  }
  const out: string[] = [
    '// Generated from openapi.json by `pnpm openapi`. Do not edit by hand.',
    '',
  ];
  const schemas = document.components?.schemas ?? {};
  for (const name of Object.keys(schemas).sort()) {
    if (!IDENT.test(name)) throw new Error(`bad component name ${name}`);
    const schema = schemas[name];
    out.push(`${doc(schema?.description, '')}export type ${name} = ${typeOf(schema)};`, '');
  }

  const operations = plan(document);
  for (const p of operations) {
    const name = pascal(p.id);
    if (p.pathParams.length > 0) {
      out.push(`export type ${name}Path = ${parametersType(p.pathParams, '')};`, '');
    }
    if (p.queryParams.length > 0) {
      out.push(`export type ${name}Query = ${parametersType(p.queryParams, '')};`, '');
    }
  }

  out.push(
    '/** How each operation is sent. */',
    'export interface OperationSpec {',
    "  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';",
    '  /** Relative to the server URL, with {name} placeholders for path parameters. */',
    '  path: string;',
    '  /** Path parameter names, in order. */',
    '  params: readonly string[];',
    '  /** The success response has no body. */',
    '  empty: boolean;',
    '}',
    '',
    'export const OPERATIONS = {',
  );
  for (const p of operations) {
    out.push(
      `  ${p.id}: { method: '${p.method}', path: '${p.path}', params: [${p.pathParams
        .map((x) => `'${x.name}'`)
        .join(', ')}], empty: ${String(p.empty)} },`,
    );
  }
  out.push(
    '} as const satisfies Record<string, OperationSpec>;',
    '',
    'export type OperationId = keyof typeof OPERATIONS;',
    '',
    '/** What one call sends; each part is left out when the operation has none. */',
    'export interface OperationArgs {',
    '  path?: Record<string, string | number>;',
    '  query?: Record<string, string | number | boolean | undefined>;',
    '  body?: unknown;',
    '}',
    '',
    '/** One method per admin API operation; AdminClient supplies the transport. */',
    'export abstract class AdminOperations {',
    '  protected abstract send(spec: OperationSpec, args: OperationArgs): Promise<unknown>;',
    '',
  );
  for (const p of operations) {
    const name = pascal(p.id);
    const fields: string[] = [];
    if (p.pathParams.length > 0) fields.push(`path: ${name}Path`);
    if (p.queryParams.length > 0) {
      const optional = p.queryParams.every((q) => q.required !== true);
      fields.push(`query${optional ? '?' : ''}: ${name}Query`);
    }
    if (p.body !== undefined) fields.push(`body${p.body.required ? '' : '?'}: ${p.body.type}`);
    const allOptional = fields.every((f) => /^\w+\?:/.test(f));
    const argument =
      fields.length === 0 ? '' : `args: { ${fields.join('; ')} }${allOptional ? ' = {}' : ''}`;
    const result = p.empty ? 'Promise<void>' : 'Promise<unknown>';
    const scope = p.op['x-flagship-scope'];
    const comment = [p.op.summary ?? p.id, `${p.method} ${p.path}`];
    if (scope !== undefined) comment.push(`Token scope: ${scope}.`);
    out.push(
      doc(comment.join('\n\n'), '  ').trimEnd(),
      `  ${p.id}(${argument}): ${result} {`,
      p.empty
        ? `    return this.send(OPERATIONS.${p.id}, ${fields.length === 0 ? '{}' : 'args'}).then(() => undefined);`
        : `    return this.send(OPERATIONS.${p.id}, ${fields.length === 0 ? '{}' : 'args'});`,
      '  }',
      '',
    );
  }
  out.push('}', '');
  return out.join('\n');
}
