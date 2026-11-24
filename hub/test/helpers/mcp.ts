import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../../src/mcp.js';

export interface McpHarness {
  url: URL;
  server: Server;
  connect(token?: string): Promise<Client>;
  close(): Promise<void>;
}

/** Start the hub's MCP HTTP server on an ephemeral port. */
export async function startMcp(adminToken = 'test-admin-token'): Promise<McpHarness> {
  const server = createMcpServer(0, adminToken);
  if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const clients: Client[] = [];
  return {
    url,
    server,
    async connect(token = adminToken) {
      const client = new Client({ name: 'anyagent-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async close() {
      for (const c of clients) await c.close().catch(() => {});
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}
