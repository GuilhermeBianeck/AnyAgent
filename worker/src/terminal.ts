import * as pty from 'node-pty';
import { homedir } from 'os';

export interface TerminalSession {
  pid: number;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  write: (data: string) => void;
}

// Secrets that must NEVER reach child processes
const SECRET_ENV_KEYS = ['PRIVATE_KEY_HEX', 'PAIR_CODE', 'NODE_ID', 'HUB_URL', 'WS_SECRET'];

function sanitizeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_ENV_KEYS.includes(key)) {
      env[key] = value;
    }
  }
  return env;
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
    env: sanitizeEnv(),
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
