export { createWorker } from './worker.js';
export type { WorkerClient, WorkerEvents, SpawnHandler, KillHandler, ResizeHandler, InputHandler } from './worker.js';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  AgentDef,
  WorkerConfig,
  DeclareParams,
  PairParams,
  PairResult,
  AuthRequestParams,
  AuthChallengeParams,
  AuthResponseParams,
  AuthResult,
  SpawnParams,
  SpawnResult,
  OutputParams,
  OutputType,
  StatusPayload,
  ProgressPayload,
  ResultPayload,
  ErrorPayload,
  ResizeParams,
  ExitParams,
} from './types.js';
export { PROTOCOL_VERSION } from './types.js';
