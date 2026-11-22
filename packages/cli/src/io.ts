import { stdin, stderr, stdout } from 'node:process';
import type { Io } from './command.js';

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads a line from the terminal in raw mode without echoing it. Backspace
 * edits, Ctrl-C and Ctrl-D give up.
 */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stderr.write(question);
    const chars: string[] = [];
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error);
      else resolve(chars.join(''));
    };
    const onData = (data: Buffer) => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish();
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          finish(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') chars.pop();
        else if (ch >= ' ') chars.push(ch);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** The real terminal, environment and network. */
export function nodeIo(): Io {
  return {
    stdout: (text) => stdout.write(`${text}\n`),
    stderr: (text) => stderr.write(`${text}\n`),
    readStdin: readAll,
    promptSecret: stdin.isTTY ? promptSecret : undefined,
    env: process.env,
    cwd: process.cwd(),
  };
}
