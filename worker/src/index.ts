/**
 * Standalone worker entrypoint — `node dist/index.js`.
 *
 * The business logic lives in `run.ts` so the unified SEA binary (`anyagent
 * worker`) can call into the same code. This file is just a thin dispatcher
 * that handles `--doctor` first and then delegates to runWorker().
 */

// --doctor flag — self-check and exit
if (process.argv.includes('--doctor')) {
  const { runDoctor } = await import('./doctor.js');
  const code = await runDoctor();
  process.exit(code);
}

const { runWorker } = await import('./run.js');
await runWorker();
