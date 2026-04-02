// JSON-RPC 2.0 base types
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string };
  id?: string | number;
}

// Agent definition declared by workers
export interface AgentDef {
  name: string;
  binary: string;
  args: string[];
  description: string;
  capabilities: string[];
}

// Worker configuration
export interface WorkerConfig {
  name: string;
  description: string;
  agents: AgentDef[];
}

// Declare RPC (worker → hub after auth)
export interface DeclareParams {
  name: string;
  description: string;
  protocolVersion: number; // 1 = v1 (TTY only), 2 = v2 (structured output + capabilities)
  agents: AgentDef[];
}

// Pairing
export interface PairParams {
  code: string;
  publicKey: string;
  name?: string;
  description?: string;
}

export interface PairResult {
  nodeId: string;
  success: boolean;
  error?: string;
}

// Auth
export interface AuthRequestParams {
  nodeId: string;
}

export interface AuthChallengeParams {
  challenge: string;
}

export interface AuthResponseParams {
  nodeId: string;
  challenge: string;
  signature: string;
}

export interface AuthResult {
  success: boolean;
  error?: string;
}

// Spawn (hub → worker)
export interface SpawnParams {
  binary: string;
  args?: string[];
  taskId?: string; // v2: task identifier for structured output
  context?: string; // v2: injected context from prior tasks
}

export interface SpawnResult {
  success: boolean;
  pid?: number;
  error?: string;
}

// Structured output (worker → hub, v2)
export type OutputType = 'status' | 'progress' | 'result' | 'error';

export interface OutputParams {
  taskId: string;
  type: OutputType;
  payload: StatusPayload | ProgressPayload | ResultPayload | ErrorPayload;
}

export interface StatusPayload {
  text: string;
}

export interface ProgressPayload {
  current: number;
  total: number;
  label?: string;
}

export interface ResultPayload {
  text: string; // markdown
}

export interface ErrorPayload {
  message: string;
}

// Terminal control
export interface ResizeParams {
  cols: number;
  rows: number;
}

export interface ExitParams {
  code: number;
}

// Protocol version constant
export const PROTOCOL_VERSION = 2;
