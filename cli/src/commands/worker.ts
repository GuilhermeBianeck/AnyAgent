/**
 * `anyagent worker` — spawn the worker from the unified binary.
 *
 * Dynamic-imports worker/src/run.ts (bundled alongside hub code). The
 * node-pty native module is loaded via a SEA-asset path — see
 * cli/src/node-pty-shim.cjs for the asset-extract + dlopen logic.
 *
 * We strip the leading 'worker' subcommand from argv before handing to
 * runWorker so its flag parser sees the same argv shape as the standalone
 * worker/src/index.ts entrypoint.
 */

export async function runWorkerCommand(argv: string[]): Promise<number> {
  // Mirror the original standalone --doctor shortcut.
  if (argv.includes('--doctor')) {
    // cli/src/commands/doctor.ts is the binary-friendly doctor (no node-pty
    // dependency). It reads a .env path from argv[0].
    const { runDoctor } = await import('./doctor.js');
    // Default path is worker/.env; override with first non-flag positional.
    const positional = argv.find(a => !a.startsWith('-'));
    return await runDoctor(positional ? [positional] : []);
  }

  const { runWorker } = await import('../../../worker/src/run.js');
  // Rebuild argv to match what runWorker expects: process.argv shape, which
  // is `[execPath, mainScript, ...userArgs]`. The flag parser uses indexOf
  // on the whole argv, so as long as the flag/value pairs are present in
  // order, it doesn't matter whether we prepend the two headers.
  const synthesized = [process.argv[0], process.argv[1], ...argv];
  await runWorker({ argv: synthesized });
  return 0;
}
