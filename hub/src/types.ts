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

// Control message param types
export interface PairParams {
  code: string;
  publicKey: string; // hex-encoded Ed25519 public key (SPKI DER)
  name?: string;
  description?: string;
}

export interface PairResult {
  nodeId: string;
  success: boolean;
  error?: string;
}

export interface AuthRequestParams {
  nodeId: string;
}

export interface AuthChallengeParams {
  challenge: string; // hex-encoded random bytes
}

export interface AuthResponseParams {
  nodeId: string;
  challenge: string;
  signature: string; // hex-encoded signature
}

export interface AuthResult {
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

// DB row types
export interface NodeRow {
  id: number;
  node_id: string;
  public_key: string;
  name: string;
  description: string;
  approved: number; // 0 or 1
  created_at: string;
}

export interface PairCodeRow {
  code: string;
  created_at: string;
  expires_at: string;
  ws_id: string;
}

// Agent registry row
export interface AgentRow {
  id: number;
  name: string;
  node_id: string;
  binary: string;
  args_json: string; // JSON-encoded string[]
  description: string;
  created_at: string;
}

// Active session (in-memory)
export interface ActiveSession {
  nodeId: string;
  chatId: number;
  agentName?: string;
}

// Pending pair state (in-memory)
export interface PendingPair {
  wsId: string;
  code: string;
  publicKey: string;
  name?: string;
  description?: string;
}

// Worker self-declaration payload
export interface DeclareParams {
  name: string;
  description: string;
  agents: Array<{ name: string; binary: string; args: string[]; description: string }>;
}
