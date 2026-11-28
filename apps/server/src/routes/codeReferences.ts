import { codeReferencesUploadSchema, keySchema } from '@flagship/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Context } from '../context.js';
import { parse } from '../errors.js';
import { operations } from '../openapi.js';
import {
  deleteCodeBranch,
  flagCodeReferences,
  listCodeBranches,
  uploadCodeReferences,
} from '../services/codeReferences.js';
import { getProject } from '../services/projects.js';
import { actorOf } from './note.js';

const projectParams = z.object({ project: keySchema });
const flagParams = z.object({ project: keySchema, flag: keySchema });
const branchQuery = z.object({
  repository: z.string().min(1).max(200),
  branch: z.string().min(1).max(255),
});

/** Uploads carry source lines, so they may be larger than the API's usual 1 MiB. */
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

const op = operations('code-references');

export function codeReferenceRoutes(ctx: Context) {
  return async (api: FastifyInstance): Promise<void> => {
    api.get(
      '/projects/:project/code-references',
      {
        config: {
          scope: 'flags:read',
          openapi: op(
            'listCodeReferenceBranches',
            'Branches with uploaded code references, and every flag key a scan should look for',
            { params: projectParams },
          ),
        },
      },
      async (request) => {
        const { project } = parse(projectParams, request.params, 'path');
        return listCodeBranches(ctx.db, await getProject(ctx.db, project));
      },
    );

    api.put(
      '/projects/:project/code-references',
      {
        bodyLimit: UPLOAD_MAX_BYTES,
        config: {
          role: 'editor',
          scope: 'code-references:write',
          openapi: op('uploadCodeReferences', "Replace one branch's code references with a scan", {
            params: projectParams,
            body: codeReferencesUploadSchema,
          }),
        },
      },
      async (request) => {
        const { project } = parse(projectParams, request.params, 'path');
        const body = parse(codeReferencesUploadSchema, request.body, 'codeReferences');
        return uploadCodeReferences(
          ctx.db,
          await getProject(ctx.db, project),
          actorOf(request),
          body,
        );
      },
    );

    api.delete(
      '/projects/:project/code-references',
      {
        config: {
          role: 'editor',
          scope: 'code-references:write',
          openapi: op('deleteCodeReferenceBranch', "Forget one branch's code references", {
            params: projectParams,
            query: branchQuery,
            status: [204],
          }),
        },
      },
      async (request, reply) => {
        const { project } = parse(projectParams, request.params, 'path');
        const q = parse(branchQuery, request.query, 'query');
        await deleteCodeBranch(ctx.db, await getProject(ctx.db, project), q.repository, q.branch);
        return reply.status(204).send();
      },
    );

    api.get(
      '/projects/:project/flags/:flag/code-references',
      {
        config: {
          scope: 'flags:read',
          openapi: op('getFlagCodeReferences', 'Where a flag is referenced in code, per branch', {
            params: flagParams,
          }),
        },
      },
      async (request) => {
        const { project, flag } = parse(flagParams, request.params, 'path');
        return flagCodeReferences(ctx.db, await getProject(ctx.db, project), flag);
      },
    );
  };
}
