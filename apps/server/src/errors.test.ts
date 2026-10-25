import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, errorHandler, notFound, parse } from './errors.js';
import { createLogger } from './log.js';

const logs: string[] = [];
const app = Fastify({
  loggerInstance: createLogger('info', { write: (l: string) => void logs.push(l) }),
  bodyLimit: 64,
});
app.setErrorHandler(errorHandler);
app.post('/echo', async (req) => parse(z.object({ name: z.string().min(2) }), req.body, 'person'));
app.get('/missing', async () => {
  throw notFound('flag "x"');
});
app.get('/limited', async () => {
  throw new AppError('resource_exhausted', 'slow down', undefined, { 'retry-after': '5' });
});
app.get('/boom', async () => {
  throw new Error('connection string postgres://secret@db leaked');
});
app.get('/teapot', async () => {
  throw Object.assign(new Error('odd client error'), { statusCode: 418 });
});

beforeAll(() => app.ready());
afterAll(() => app.close());

describe('errorHandler', () => {
  it('maps validation failures to invalid_argument with field details', async () => {
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { name: 'a' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'invalid_argument',
        message: 'invalid person',
        request_id: expect.any(String),
        details: [{ path: 'name', message: 'Too small: expected string to have >=2 characters' }],
      },
    });
  });

  it('maps body parser failures', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.json().error.code).toBe('invalid_argument');
    const empty = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.json().error.code).toBe('invalid_argument');
    const big = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { name: 'x'.repeat(100) },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('payload_too_large');
    const form = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=abc',
    });
    expect(form.statusCode).toBe(415);
  });

  it('keeps status, code and headers of application errors', async () => {
    const missing = await app.inject({ url: '/missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({
      code: 'not_found',
      message: 'flag "x" not found',
    });
    const limited = await app.inject({ url: '/limited' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('5');
  });

  it('hides unexpected errors behind a generic message and logs them', async () => {
    const res = await app.inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: 'internal', message: 'internal error' });
    expect(res.body).not.toContain('secret');
    expect(logs.some((l) => l.includes('unhandled error'))).toBe(true);
  });

  it('treats other 4xx framework errors as invalid_argument', async () => {
    const res = await app.inject({ url: '/teapot' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('odd client error');
  });
});
