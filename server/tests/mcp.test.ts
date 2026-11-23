import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGateway } from '../src/index';
import { MCP_TOOL_NAMES, isLoopbackHost } from '../src/mcp-core';

/**
 * vitest runs with cwd=server, so every child process path must be resolved from
 * this test file (repo root), never from process.cwd().
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const STDIO_ENTRY = path.join(REPO_ROOT, 'server', 'src', 'mcp-stdio.ts');
const CONNECT_AGENT = path.join(REPO_ROOT, 'scripts', 'connect-agent.mjs');

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

async function startGateway() {
  const { server } = createGateway();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    httpUrl: 'http://127.0.0.1:' + String(port),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-mcp-'));
  vi.stubEnv('IELTS_COACH_DATA_DIR', dir);
  return dir;
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content || [];
  return JSON.parse(content[0]?.text || '{}') as Record<string, unknown>;
}

async function connectClient(url: string, init?: RequestInit): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), init ? { requestInit: init } : undefined);
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1.0.0' },
    },
  };
}

async function postMcp(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initializeBody()),
  });
}

describe('MCP over Streamable HTTP', () => {
  it('lists tools and runs the whole lesson lifecycle', async () => {
    tempDataDir();
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const client = await connectClient(gateway.httpUrl + '/mcp');

    const list = await client.listTools();
    expect(list.tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());

    const created = textOf(
      await client.callTool({
        name: 'create_lesson',
        arguments: { partMode: 'part1', reviewFocus: '过去式', openBrowser: false },
      }),
    );
    expect(String(created.lessonId)).toMatch(/^l-/);
    expect(String(created.url)).toContain('/?lesson=');
    expect(created.plan).toBeTruthy();
    // Truthful zero-manual-restart status fields (booleans even when skipped).
    expect(typeof created.serverRunning).toBe('boolean');
    expect(typeof created.browserOpened).toBe('boolean');

    const transcript = textOf(
      await client.callTool({ name: 'get_lesson_transcript', arguments: { lessonId: created.lessonId } }),
    );
    expect(transcript.id).toBe(created.lessonId);
    expect(transcript.status).toBe('planned');

    const saved = textOf(
      await client.callTool({
        name: 'save_turn_feedback',
        arguments: {
          lessonId: created.lessonId,
          items: [
            {
              lineId: 'line-1',
              feedback: { corrected_text: 'I went there.', grammar_mistakes: [], lexical_tips: [] },
            },
          ],
        },
      }),
    );
    expect(saved.saved).toBe(1);

    const reported = textOf(
      await client.callTool({
        name: 'save_lesson_report',
        arguments: {
          lessonId: created.lessonId,
          report: {
            bands: { overall: 6.5, fc: 6.5, lr: 6, gra: 6.5, pr: 6 },
            summary_zh: '稳',
            top_mistakes: [],
            upgraded_sentences: [],
            memory_updates: [],
          },
        },
      }),
    );
    expect(reported.ok).toBe(true);
    expect(reported.status).toBe('completed');

    await client.callTool({
      name: 'upsert_memory',
      arguments: { items: [{ kind: 'weakness', title: '过去式', content: 'go -> went' }] },
    });

    const context = textOf(await client.callTool({ name: 'get_learner_context', arguments: {} }));
    const memory = context.memory as Array<{ title?: string }>;
    expect(memory.some((item) => item.title === '过去式')).toBe(true);
    const lessons = context.lessons as Array<{ lessonId?: string; status?: string }>;
    expect(lessons.some((item) => item.lessonId === created.lessonId && item.status === 'completed')).toBe(true);
    const server = context.server as { running?: unknown; url?: unknown; port?: unknown };
    expect(typeof server.running).toBe('boolean');
    expect(typeof server.url).toBe('string');
    expect(typeof server.port).toBe('number');
  });

  it('maps custom questions: Describe + You should say becomes a cue_card', async () => {
    tempDataDir();
    const gateway = await startGateway();
    cleanups.push(gateway.close);
    const client = await connectClient(gateway.httpUrl + '/mcp');

    const created = textOf(
      await client.callTool({
        name: 'create_lesson',
        arguments: {
          partMode: 'full_mock',
          customQuestions: [
            'Do you like reading?',
            'Describe a book you enjoyed. You should say: what it was about and why you liked it.',
            'Why do some people prefer paper books?',
          ],
          openBrowser: false,
        },
      }),
    );
    const plan = created.plan as { questions?: Array<{ kind?: string; part?: string; text?: string }> };
    const questions = plan.questions || [];
    expect(questions).toHaveLength(3);
    expect(questions[0].kind).toBe('question');
    expect(questions[1].kind).toBe('cue_card');
    expect(questions[1].part).toBe('part2');
    expect(questions[2].kind).toBe('question');
    expect(questions[2].part).toBe('part3');
  });

  it('does not probe or open a browser when the lesson URL is remote', async () => {
    tempDataDir();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://coach.example.com');
    const gateway = await startGateway();
    cleanups.push(gateway.close);
    const client = await connectClient(gateway.httpUrl + '/mcp');

    const created = textOf(await client.callTool({ name: 'create_lesson', arguments: {} }));
    expect(String(created.url)).toContain('https://coach.example.com/?lesson=');
    expect(created.serverRunning).toBe(false);
    expect(created.browserOpened).toBe(false);
  });

  it('classifies loopback hostnames for the zero-restart path', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('coach.example.com')).toBe(false);
  });

  it('requires a bearer token when MCP_TOKEN is configured', async () => {
    tempDataDir();
    vi.stubEnv('MCP_TOKEN', 'secret-token');
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const unauthorized = await postMcp(gateway.httpUrl + '/mcp');
    expect(unauthorized.status).toBe(401);
    await unauthorized.body?.cancel().catch(() => undefined);

    const wrongToken = await postMcp(gateway.httpUrl + '/mcp', { Authorization: 'Bearer wrong-token' });
    expect(wrongToken.status).toBe(401);
    await wrongToken.body?.cancel().catch(() => undefined);
  });

  it('accepts an authorized bearer token and the ?token= fallback', async () => {
    tempDataDir();
    vi.stubEnv('MCP_TOKEN', 'secret-token');
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const withHeader = await connectClient(gateway.httpUrl + '/mcp', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect((await withHeader.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);

    const withQuery = await connectClient(gateway.httpUrl + '/mcp?token=secret-token');
    expect((await withQuery.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);
  });

  it('allows loopback requests when no token is configured', async () => {
    tempDataDir();
    vi.stubEnv('MCP_TOKEN', '');
    vi.stubEnv('ACCESS_CODE', '');
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const response = await postMcp(gateway.httpUrl + '/mcp');
    expect(response.status).toBe(200);
    await response.body?.cancel().catch(() => undefined);
  });

  it('keeps /health and /api/status public and reports v2.2.4', async () => {
    tempDataDir();
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    for (const route of ['/health', '/api/status']) {
      const response = await fetch(gateway.httpUrl + route);
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.version).toBe('2.2.4');
      expect(typeof data.hasMcpToken).toBe('boolean');
      expect(typeof data.port).toBe('number');
      expect(typeof data.uptime).toBe('number');
    }
  });

  it('accepts extra outer item fields in save_turn_feedback (external LLM write-back)', async () => {
    tempDataDir();
    const gateway = await startGateway();
    cleanups.push(gateway.close);
    const client = await connectClient(gateway.httpUrl + '/mcp');

    const created = textOf(await client.callTool({ name: 'create_lesson', arguments: { openBrowser: false } }));
    const saved = textOf(
      await client.callTool({
        name: 'save_turn_feedback',
        arguments: {
          lessonId: created.lessonId,
          items: [
            {
              lineId: 'line-extra',
              // 豆包 / Codex / dsh often add outer fields such as turnIndex;
              // these must be stripped, never reject the whole write-back.
              turnIndex: 2,
              note: 'extra field from an external agent',
              feedback: {
                corrected_text: 'I went there.',
                upgraded_text: 'I paid a visit there.',
                grammar_mistakes: [],
                lexical_tips: [],
              },
            },
          ],
        },
      }),
    );
    expect(saved.saved).toBe(1);

    const transcript = textOf(
      await client.callTool({ name: 'get_lesson_transcript', arguments: { lessonId: created.lessonId } }),
    );
    const feedback = transcript.feedback as Record<string, { corrected_text?: string }>;
    expect(feedback['line-extra']?.corrected_text).toBe('I went there.');
  });
});

describe('MCP over STDIO', () => {
  it(
    'initializes and lists tools with a clean stdout',
    async () => {
      const dir = tempDataDir();
      const child = spawn(process.execPath, [TSX_CLI, STDIO_ENTRY], {
        cwd: REPO_ROOT,
        env: { ...process.env, IELTS_COACH_DATA_DIR: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      cleanups.push(() => {
        child.kill();
      });

      const lines: string[] = [];
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) lines.push(line);
          index = buffer.indexOf('\n');
        }
      });

      const send = (payload: unknown) => child.stdin.write(JSON.stringify(payload) + '\n');
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      const tools = await new Promise<Array<{ name: string }>>((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
              if (parsed.id === 2 && parsed.result?.tools) return resolve(parsed.result.tools);
            } catch {
              return reject(new Error('stdout 出现非 JSON 内容: ' + line.slice(0, 80)));
            }
          }
          if (Date.now() - started > 12000) return reject(new Error('STDIO 超时'));
          setTimeout(tick, 50);
        };
        tick();
      });

      expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
      // Every line collected so far must be valid JSON-RPC (no console.log noise).
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    },
    15000,
  );
});

describe('connect-agent script', () => {
  it('detects agents in dry-run mode without writing files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-home-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const result = spawnSync(process.execPath, [CONNECT_AGENT, '--dry-run', '--home', home], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('codex');
    expect(result.stdout).toContain('cursor');
    expect(result.stdout).toContain('豆包');
    expect(result.stdout).toContain('dry-run');
    // Dry run must not touch the file.
    expect(JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers).toEqual({});
  });
});
