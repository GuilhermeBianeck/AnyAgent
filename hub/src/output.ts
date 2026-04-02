// Strip ANSI escape sequences from TTY output for clean Telegram rendering.
// Matches CSI sequences, OSC sequences, and other common control codes.
const ANSI_RE =
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\x1B\].*?(?:\x07|\x1B\\)|\x1B[()][AB012]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
