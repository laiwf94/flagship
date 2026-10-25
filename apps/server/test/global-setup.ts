import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer | undefined;

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('flagship')
    .withUsername('flagship')
    .withPassword('flagship')
    .withCommand(['postgres', '-c', 'max_connections=500', '-c', 'fsync=off'])
    .start();
  project.provide('postgresUrl', container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
