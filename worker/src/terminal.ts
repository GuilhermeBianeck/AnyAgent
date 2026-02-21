import * as pty from 'node-pty';
import { WebSocket } from 'ws';

export interface TerminalSession {
  pid: number;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  write: (data: string) => void;
}

export function spawnTerminal(
  binary: string,
  args: string[],
  ws: WebSocket,
  onExit: (code: number) => void
): TerminalSession {
  const ptyProcess = pty.spawn(binary, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME ?? process.cwd(),
    env: process.env as Record<string, string>,
  });

  // PTY stdout → binary WebSocket frames
  ptyProcess.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(data), { binary: true });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    onExit(exitCode ?? 0);
  });

  return {
    pid: ptyProcess.pid,
    resize: (cols: number, rows: number) => {
      ptyProcess.resize(cols, rows);
    },
    kill: () => {
      ptyProcess.kill();
    },
    write: (data: string) => {
      ptyProcess.write(data);
    },
  };
}
