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
  taskId?: string;
  context?: string;
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

// Structured output (v2, worker → hub)
export interface OutputParams {
  taskId: string;
  type: 'status' | 'progress' | 'result' | 'error';
  payload: Record<string, unknown>;
}

// DB row types
export interface NodeRow {
  id: number;
  node_id: string;
  public_key: string;
  name: string;
  description: string;
  alias: string; // human-friendly short handle, derived from name on pair/rename (v2.1)
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
  capabilities: string; // JSON-encoded string[] (v2)
  context_aware: number; // 0 or 1, default 1 (v2)
  created_at: string;
}

// Task row (v2)
export type TaskStatus = 'submitted' | 'pending_approval' | 'queued' | 'routed' | 'running' | 'complete' | 'failed' | 'timeout';
export type TaskSource = 'telegram' | 'mcp' | 'cli';
export type RoutingMethod = 'default' | 'single' | 'matched' | 'explicit' | 'user_selected';

export interface TaskRow {
  task_id: string;
  source: TaskSource;
  chat_id: number | null;
  intent: string;
  status: TaskStatus;
  routing_method: RoutingMethod | null;
  agent_name: string | null;
  node_id: string | null;
  result_summary: string | null;
  error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
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

// Session persistence
export interface SessionRow {
  session_id: string;
  node_id: string;
  chat_id: number;
  agent_name: string | null;
  started_at: string;
  last_activity_at: string;
}

export interface DefaultAgentRow {
  chat_id: number;
  agent_name: string;
}

// Worker self-declaration payload (v2: with capabilities + protocolVersion)
export interface DeclareParams {
  name: string;
  description: string;
  protocolVersion?: number; // 1 = v1, 2 = v2 (optional for backward compat)
  agents: Array<{
    name: string;
    binary: string;
    args: string[];
    description: string;
    capabilities?: string[]; // v2
    contextAware?: boolean; // v2, default true
  }>;
}
