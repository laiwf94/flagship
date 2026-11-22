import { stdin, stderr, stdout } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeIo, promptSecret } from './io.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeTerminal() {
  const raw: boolean[] = [];
  const input = stdin as unknown as { setRawMode: ((on: boolean) => void) | undefined };
  const original = input.setRawMode;
  input.setRawMode = (on: boolean) => {
    raw.push(on);
  };
  vi.spyOn(stdin, 'resume').mockReturnValue(stdin);
  vi.spyOn(stdin, 'pause').mockReturnValue(stdin);
  const written: string[] = [];
  vi.spyOn(stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    written.push(String(s));
    return true;
  });
  return {
    raw,
    written,
    type: (s: string) => stdin.emit('data', Buffer.from(s, 'utf8')),
    restore: () => {
      input.setRawMode = original;
    },
  };
}

describe('promptSecret', () => {
  it('reads a line without echo, with backspace, and leaves raw mode', async () => {
    const t = fakeTerminal();
    try {
      const answer = promptSecret('Password: ');
      t.type('pa');
      t.type('x\u007fss wörd🔑');
      t.type('\r');
      expect(await answer).toBe('pass wörd🔑');
      expect(t.raw).toEqual([true, false]);
      expect(t.written).toEqual(['Password: ', '\n']);
      expect(stdin.listenerCount('data')).toBe(0);
    } finally {
      t.restore();
    }
  });

  it('gives up on Ctrl-C', async () => {
    const t = fakeTerminal();
    try {
      const answer = promptSecret('Password: ');
      t.type('ab\u0003');
      await expect(answer).rejects.toThrow('cancelled');
      expect(t.raw).toEqual([true, false]);
    } finally {
      t.restore();
    }
  });
});

describe('nodeIo', () => {
  it('writes lines to stdout and stderr and passes the environment', () => {
    const out = vi.spyOn(stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(stderr, 'write').mockReturnValue(true);
    const io = nodeIo();
    io.stdout('hello');
    io.stderr('oops');
    expect(out).toHaveBeenCalledWith('hello\n');
    expect(err).toHaveBeenCalledWith('oops\n');
    expect(io.env).toBe(process.env);
    expect(io.cwd).toBe(process.cwd());
    expect(io.promptSecret === undefined).toBe(!stdin.isTTY);
  });
});
