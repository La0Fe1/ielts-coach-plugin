import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway, syncAccessAllowed } from '../src/index';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-sync-'));
  vi.stubEnv('IELTS_COACH_DATA_DIR', dir);
  return dir;
}

async function startGateway() {
  const { server } = createGateway();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    httpUrl: 'http://127.0.0.1:' + String(port),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const PUBLIC_REQUEST = { remoteAddress: '203.0.113.9', authorization: undefined, token: undefined };

describe('syncAccessAllowed: MULTI_USER_MODE gating', () => {
  it('allows everything in the default single-user local mode', () => {
    vi.stubEnv('MULTI_USER_MODE', '');
    expect(syncAccessAllowed(PUBLIC_REQUEST, 'global')).toBe(true);
    expect(syncAccessAllowed(PUBLIC_REQUEST, 'lesson')).toBe(true);
  });

  it('always allows loopback and valid tokens in multi-user mode', () => {
    vi.stubEnv('MULTI_USER_MODE', 'true');
    vi.stubEnv('MCP_TOKEN', 'secret-token');
    expect(syncAccessAllowed({ remoteAddress: '127.0.0.1' }, 'global')).toBe(true);
    expect(syncAccessAllowed({ remoteAddress: '::1' }, 'global')).toBe(true);
    expect(syncAccessAllowed({ remoteAddress: '::ffff:127.0.0.1' }, 'global')).toBe(true);
    expect(syncAccessAllowed({ remoteAddress: '203.0.113.9', authorization: 'Bearer secret-token' }, 'global')).toBe(
      true,
    );
    expect(syncAccessAllowed({ remoteAddress: '203.0.113.9', token: 'secret-token' }, 'global')).toBe(true);
  });

  it('denies public listing/memory but keeps the per-lesson capability link', () => {
    vi.stubEnv('MULTI_USER_MODE', 'true');
    vi.stubEnv('MCP_TOKEN', 'secret-token');
    expect(syncAccessAllowed(PUBLIC_REQUEST, 'global')).toBe(false);
    expect(syncAccessAllowed(PUBLIC_REQUEST, 'lesson')).toBe(true);
    // A wrong token is still a tokenless visitor for single-lesson capability links.
    expect(syncAccessAllowed({ ...PUBLIC_REQUEST, authorization: 'Bearer wrong' }, 'global')).toBe(false);
    expect(syncAccessAllowed({ ...PUBLIC_REQUEST, authorization: 'Bearer wrong' }, 'lesson')).toBe(true);
  });
});

describe('gateway sync API over loopback', () => {
  it('keeps /health public and syncs lessons + memory in multi-user mode from localhost', async () => {
    tempDataDir();
    vi.stubEnv('MULTI_USER_MODE', 'true');
    vi.stubEnv('MCP_TOKEN', '');
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const health = await fetch(gateway.httpUrl + '/health');
    expect(health.status).toBe(200);
    const healthData = (await health.json()) as Record<string, unknown>;
    expect(healthData.ok).toBe(true);
    expect(healthData.version).toBe('2.2.5');
    expect(healthData.multiUserMode).toBe(true);

    const status = await fetch(gateway.httpUrl + '/api/status');
    expect(status.status).toBe(200);
    const statusData = (await status.json()) as Record<string, unknown>;
    expect(statusData.hasMcpToken).toBe(false);

    const createResponse = await fetch(gateway.httpUrl + '/api/lessons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'l-loop',
        startedAt: 1000,
        endedAt: null,
        partMode: 'part1',
        topic: 'Hometown',
        provider: 'qwen',
        lines: [],
        feedback: {},
        report: null,
        status: 'planned',
        plan: null,
        reviewFocus: '',
      }),
    });
    expect(createResponse.status).toBe(200);

    const list = await fetch(gateway.httpUrl + '/api/lessons');
    expect(list.status).toBe(200);
    const listData = (await list.json()) as { lessons?: Array<{ id?: string }> };
    expect(listData.lessons?.[0]?.id).toBe('l-loop');

    const one = await fetch(gateway.httpUrl + '/api/lessons/l-loop');
    expect(one.status).toBe(200);

    const synced = await fetch(gateway.httpUrl + '/api/lessons/l-loop/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lines: [{ id: 'line-1', role: 'user', text: 'I live in Shanghai.', final: true, at: 1001 }],
        status: 'live',
      }),
    });
    expect(synced.status).toBe(200);
    const syncedData = (await synced.json()) as { lesson?: { lines?: unknown[]; status?: string } };
    expect(syncedData.lesson?.lines).toHaveLength(1);
    expect(syncedData.lesson?.status).toBe('live');

    const memoryWrite = await fetch(gateway.httpUrl + '/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'm-1', kind: 'weakness', title: '时态', content: 'go -> went', createdAt: 1 }] }),
    });
    expect(memoryWrite.status).toBe(200);
    const memoryList = await fetch(gateway.httpUrl + '/api/memory');
    const memoryData = (await memoryList.json()) as { memory?: Array<{ id?: string }> };
    expect(memoryData.memory?.[0]?.id).toBe('m-1');

    const memoryDelete = await fetch(gateway.httpUrl + '/api/memory/m-1', { method: 'DELETE' });
    expect(memoryDelete.status).toBe(200);
    expect(((await memoryDelete.json()) as { removed?: number }).removed).toBe(1);
  });

  it('reports hasMcpToken when a token is configured', async () => {
    tempDataDir();
    vi.stubEnv('MCP_TOKEN', 'secret-token');
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const status = await fetch(gateway.httpUrl + '/api/status');
    expect(status.status).toBe(200);
    const data = (await status.json()) as Record<string, unknown>;
    expect(data.hasMcpToken).toBe(true);
    expect(String(JSON.stringify(data))).not.toContain('secret-token');
  });

  it('defaults to local mode where the browser sync calls keep working', async () => {
    tempDataDir();
    vi.stubEnv('MULTI_USER_MODE', '');
    const gateway = await startGateway();
    cleanups.push(gateway.close);

    const list = await fetch(gateway.httpUrl + '/api/lessons?limit=20');
    expect(list.status).toBe(200);
    const create = await fetch(gateway.httpUrl + '/api/lessons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'l-local', startedAt: 1, lines: [], feedback: {}, report: null, status: 'planned' }),
    });
    expect(create.status).toBe(200);
    const synced = await fetch(gateway.httpUrl + '/api/lessons/l-local/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [] }),
    });
    expect(synced.status).toBe(200);
  });
});
