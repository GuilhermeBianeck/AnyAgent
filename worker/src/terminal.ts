import * as pty from 'node-pty';
import { homedir } from 'os';

export interface TerminalSession {
  pid: number;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  write: (data: string) => void;
}

export function spawnTerminal(
  binary: string,
  args: string[],
  onData: (data: Buffer) => void,
  onExit: (code: number) => void
): TerminalSession {
  const ptyProcess = pty.spawn(binary, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME ?? homedir(),
    env: process.env as Record<string, string>,
  });

  ptyProcess.onData((data: string) => {
    onData(Buffer.from(data));
  });

  ptyProcess.onExit(({ exitCode }) => {
    onExit(exitCode ?? 0);
  });

  return {
    pid: ptyProcess.pid,
    resize: (cols: number, rows: number) => ptyProcess.resize(cols, rows),
    kill: () => ptyProcess.kill(),
    write: (data: string) => ptyProcess.write(data),
  };
}
