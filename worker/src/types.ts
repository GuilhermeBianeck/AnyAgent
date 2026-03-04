// JSON-RPC 2.0 base
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

export interface PairParams {
  code: string;
  publicKey: string;
  name?: string;
  description?: string;
}

export interface DeclareParams {
  name: string;
  description: string;
  agents: Array<{ name: string; binary: string; args: string[]; description: string }>;
}

export interface WorkerConfig {
  name: string;
  description: string;
  agents: Array<{ name: string; binary: string; args: string[]; description: string }>;
}

export interface PairResult {
  nodeId: string;
  success: boolean;
  error?: string;
}

export interface AuthChallengeParams {
  challenge: string;
}

export interface AuthResultParams {
  success: boolean;
  error?: string;
}

export interface SpawnParams {
  binary: string;
  args?: string[];
}

export interface SpawnResult {
  success: boolean;
  pid?: number;
  error?: string;
}

export interface ResizeParams {
  cols: number;
  rows: number;
}

export interface ExitParams {
  code: number;
}
