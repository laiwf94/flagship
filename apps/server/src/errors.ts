import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

export const ERROR_STATUS = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  already_exists: 409,
  version_conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  resource_exhausted: 429,
  internal: 500,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);

export interface FieldIssue {
  path: string;
  message: string;
}

/** Parses untrusted input or throws invalid_argument with one entry per problem. */
export function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what = 'request',
): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details: FieldIssue[] = result.error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  throw new AppError('invalid_argument', `invalid ${what}`, details);
}

function fromFastify(err: FastifyError): AppError | undefined {
  switch (err.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError('payload_too_large', 'request body is too large');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError(
        'unsupported_media_type',
        'send JSON with Content-Type: application/json',
      );
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return new AppError('invalid_argument', 'request body is not valid JSON');
    default:
      break;
  }
  if (err instanceof SyntaxError && err.statusCode === 400) {
    return new AppError('invalid_argument', 'request body is not valid JSON');
  }
  if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
    return new AppError('invalid_argument', err.message);
  }
  return undefined;
}

export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  err: AppError,
): FastifyReply {
  for (const [name, value] of Object.entries(err.headers ?? {})) void reply.header(name, value);
  const body: Record<string, unknown> = {
    code: err.code,
    message: err.message,
    request_id: request.id,
  };
  if (err.details !== undefined) body.details = err.details;
  return reply.status(err.status).send({ error: body });
}

/** Maps anything thrown by a handler to the stable error body. Internals never leak. */
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const known = err instanceof AppError ? err : fromFastify(err as FastifyError);
  if (known !== undefined) {
    if (known.status >= 500) request.log.error({ err }, known.message);
    return sendError(reply, request, known);
  }
  request.log.error({ err }, 'unhandled error');
  return sendError(reply, request, new AppError('internal', 'internal error'));
}
