import type { Command } from '../command.js';
import { authCommands } from './auth.js';
import { changeRequestCommands } from './changeRequests.js';
import { evalCommands } from './evaluate.js';
import { flagCommands } from './flags.js';
import { segmentCommands } from './segments.js';

/** Every command, in the order help lists them. */
export const COMMANDS: readonly Command[] = [
  ...authCommands,
  ...flagCommands,
  ...segmentCommands,
  ...changeRequestCommands,
  ...evalCommands,
];

/** Short names for command groups. */
export const ALIASES: Readonly<Record<string, string>> = { cr: 'change-request' };
