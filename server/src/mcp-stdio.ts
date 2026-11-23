#!/usr/bin/env node
/**
 * STDIO transport. Standard output belongs to JSON-RPC: every log must go to
 * stderr, otherwise Codex / 豆包 / dsh lose the connection.
 *
 * `stdio: true` enables the zero-manual-restart path in create_lesson: probe the
 * local web server, start it in the background if needed, then open the browser.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-core';

async function main(): Promise<void> {
  const server = createMcpServer({ stdio: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[ielts-mcp] ready (stdio)');
}

main().catch((error) => {
  console.error('[ielts-mcp] fatal:', String((error as Error)?.message || error));
  process.exit(1);
});
