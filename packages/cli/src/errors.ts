/** Bad arguments: exit status 2 and a pointer to --help. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A failure with a stable code for --json output: exit status 1. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
