/** Stateless Streamable HTTP transport for the MCP tools.

Compatible with @modelcontextprotocol/sdk 1.32.x: one fresh server + transport per
request with `sessionIdGenerator: undefined` (stateless mode), so clients can
reconnect at will and no session state leaks between requests.

Auth: `Authorization: Bearer <token>` or `?token=<token>`. When MCP_TOKEN /
ACCESS_CODE is configured a mismatch is 401 even from loopback; with no token
configured only loopback clients are allowed.
*/

import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { allowMcpRequest, createMcpServer } from './mcp-core';

function tokenFromQuery(req: Request): string | undefined {
  const value = req.query.token;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function mountMcp(app: Express): void {
  const handler = async (req: Request, res: Response): Promise<void> => {
    if (!allowMcpRequest(req.socket.remoteAddress, req.headers.authorization, tokenFromQuery(req))) {
      res.status(401).json({ error: 'MCP 需要 Bearer Token（或 ?token=）；未配置 Token 时仅允许本机访问' });
      return;
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP 处理失败: ' + String((error as Error).message || error) });
      }
    }
  };

  // POST carries JSON-RPC, GET opens the optional SSE stream, DELETE ends a session.
  app.post('/mcp', handler);
  app.get('/mcp', handler);
  app.delete('/mcp', handler);
}
