#!/usr/bin/env node
// SEA binaries can't accept --no-warnings at the node invocation layer (the
// user runs `anyagent hub`, not `node --no-warnings anyagent`). Filter
// harmless warnings here instead. node:sqlite is stable since 22.5 — the
// `ExperimentalWarning` it emits is a category flag, not an actual warning.
process.removeAllListeners('warning');
process.on('warning', (w: NodeJS.ErrnoException) => {
  if (w.name === 'ExperimentalWarning') return;
  if (w.name === 'DeprecationWarning' && w.code === 'DEP0040') return;
  // eslint-disable-next-line no-console
  console.warn(`(${w.name}) ${w.message}`);
});

/**
 * anyagent — unified CLI entrypoint, bundled into a single-file SEA binary.
 *
 * Subcommands:
 *   hub         Start the hub (replaces: cd hub && npm start)
 *   pair        Print a fresh pair code without starting the hub
 *   wire-mcp    Inject the anyagent entry into an MCP client config
 *   quickstart  Hub-side quickstart (starts hub + writes MCP config)
 *   doctor      Validate a worker .env without starting it
 *   --help
 *
 * This file is the ONLY direct entrypoint when packaged. It imports from the
 * hub/worker source trees directly (relative paths), so esbuild bundles the
 * whole repo into one JS file for SEA embedding.
 *
 * The hub's normal entrypoint hub/src/index.ts has top-level side effects that
 * start servers. To avoid starting the hub at import time when the user runs,
 * say, `anyagent pair`, each subcommand is lazy-loaded with dynamic import.
 */

const argv = process.argv.slice(2);
const cmd = argv[0] ?? '--help';
const rest = argv.slice(1);

async function main(): Promise<number> {
  switch (cmd) {
    case 'hub': {
      const { runHub } = await import('./commands/hub.js');
      return await runHub();
    }

    case 'worker': {
      const { runWorkerCommand } = await import('./commands/worker.js');
      return await runWorkerCommand(rest);
    }

    case 'pair': {
      const { runPair } = await import('./commands/pair.js');
      return await runPair(rest);
    }

    case 'wire-mcp': {
      const { runWireMcp } = await import('./commands/wire-mcp.js');
      return await runWireMcp(rest);
    }

    case 'quickstart': {
      const { runQuickstart } = await import('./commands/quickstart.js');
      return await runQuickstart(rest);
    }

    case 'doctor': {
      const { runDoctor } = await import('./commands/doctor.js');
      return await runDoctor(rest);
    }

    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`anyagent ${VERSION}\n`);
      return 0;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return 0;

    default:
      console.error(`anyagent: unknown command '${cmd}'. Run 'anyagent --help'.`);
      return 1;
  }
}

// Injected by bundler via esbuild define
declare const __ANYAGENT_VERSION__: string;
const VERSION =
  typeof __ANYAGENT_VERSION__ === 'string' && __ANYAGENT_VERSION__.length > 0
    ? __ANYAGENT_VERSION__
    : 'dev';

function printHelp(): void {
  process.stdout.write(`anyagent ${VERSION} — MCP bridge for distributed agents

USAGE
  anyagent <command> [options]

COMMANDS
  hub                  Start the hub server (ws on :8080, MCP on :3000)
  worker               Start the worker (connects to a hub)
  quickstart           Start hub + wire MCP client config (hub-side only)
  pair                 Print a fresh pair code and exit
  wire-mcp             Inject the anyagent entry into ~/.claude.json (or --config <file>)
  doctor               Check a worker .env for common problems
  version              Print version
  help                 Show this help

ENVIRONMENT
  Hub reads ./.env in the current directory (or \$ANYAGENT_HUB_DIR/.env).
  Worker reads ./.env (HUB_URL, PAIR_CODE, WORKER_AGENTS, ...).
  Every env var documented in the README is honored.

EXAMPLES
  anyagent quickstart                        # hub + wire Claude Code
  anyagent hub                               # start a paired hub
  anyagent worker --hub ws://HUB:8080 --pair CODE
  anyagent pair                              # generate a code to hand a worker
  anyagent wire-mcp --url http://HUB:3000 --token \$MCP_TOKEN
`);
}

main()
  .then(code => { process.exit(code); })
  .catch(err => {
    console.error('[anyagent]', err instanceof Error ? err.message : err);
    process.exit(1);
  });
