/** The seven MCP tools, shared by Streamable HTTP and STDIO transports.

Rules for this module: never write to stdout (STDIO JSON-RPC would break), never
log secrets, and keep the tool surface small enough that any agent can use it.
Diagnostics go through console.error only.
*/

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  planLesson,
  type GrammarMistake,
  type LessonPlan,
  type LessonRecord,
  type LessonReport,
  type LexicalTip,
  type MemoryNote,
  type PartMode,
  type PlanQuestion,
  type TurnFeedback,
} from '@ielts/shared';
import {
  deleteMemory,
  getLesson,
  latestLessonWithTurns,
  listLessons,
  listMemory,
  patchLesson,
  upsertLesson,
  upsertMemory,
} from './store';

/** Repo root: server/src/mcp-core.ts -> server/src -> server -> repo root. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'src', 'index.ts');
const AUTOSTART_WAIT_MS = 8000;

export interface CreateMcpServerOptions {
  /** STDIO transport only: allows the zero-manual-restart background web server. */
  stdio?: boolean;
}

// ---------------------------------------------------------------------------
// zod schemas (strict: every field is typed; unknown nested keys are stripped)
// ---------------------------------------------------------------------------

// Inbound payloads come from another LLM (豆包 / dsh / Codex), which often adds
// harmless extra keys. Keep the known fields strictly typed, but strip unknown
// keys instead of failing the whole write-back: a rejected save would silently
// lose the learner's review. Limits only guard against absurd payload sizes.
const grammarMistakeSchema = z.object({
  original: z.string().default(''),
  corrected: z.string().default(''),
  category: z.string().default('other'),
  explanation_zh: z.string().default(''),
});

const lexicalTipSchema = z.object({
  basic: z.string().default(''),
  upgraded: z.string().default(''),
  usage_zh: z.string().default(''),
});

const turnFeedbackSchema = z.object({
  corrected_text: z.string().default(''),
  upgraded_text: z.string().default(''),
  grammar_mistakes: z.array(grammarMistakeSchema).max(10).default([]),
  lexical_tips: z.array(lexicalTipSchema).max(10).default([]),
  coach_note_zh: z.string().default(''),
});

const memoryKindSchema = z.enum(['weakness', 'fact', 'phrase']);

const memoryUpdateSchema = z.object({
  id: z.string().optional(),
  kind: memoryKindSchema.default('weakness'),
  title: z.string().min(1),
  content: z.string().min(1),
});

const bandScoresSchema = z.object({
  overall: z.number().min(0).max(9),
  fc: z.number().min(0).max(9),
  lr: z.number().min(0).max(9),
  gra: z.number().min(0).max(9),
  pr: z.number().min(0).max(9),
});

const lessonReportSchema = z.object({
  bands: bandScoresSchema,
  summary_zh: z.string().default(''),
  top_mistakes: z.array(grammarMistakeSchema).max(10).default([]),
  upgraded_sentences: z.array(z.string()).max(10).default([]),
  memory_updates: z.array(memoryUpdateSchema).max(10).default([]),
});

// ---------------------------------------------------------------------------
// Helpers: browser / local web-server probe (zero-manual-restart)
// ---------------------------------------------------------------------------

function serverPort(): number {
  const port = Number(process.env.PORT || 3000);
  return Number.isFinite(port) && port > 0 ? port : 3000;
}

function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:' + String(serverPort())).replace(/\/$/, '');
}

export function isLoopbackHost(hostname: string): boolean {
  const clean = (hostname || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/, '').toLowerCase();
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHealth(url: string, timeoutMs = 600): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Local web-server status for get_learner_context / create_lesson return values. */
async function localServerStatus(): Promise<{ running: boolean; url: string; port: number }> {
  const url = baseUrl();
  const port = serverPort();
  const running = await probeHealth(url + '/health', 800);
  return { running, url, port };
}

/**
 * Last-resort auto start: `node node_modules/tsx/dist/cli.mjs server/src/index.ts`
 * from the repo root, detached, stdio ignored so STDIO JSON-RPC is never polluted.
 */
function spawnBackgroundServer(port: number): boolean {
  try {
    if (!fs.existsSync(TSX_CLI) || !fs.existsSync(SERVER_ENTRY)) {
      console.error('[ielts-mcp] auto-start skipped: tsx or server entry missing');
      return false;
    }
    const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PORT: String(port) },
    });
    child.on('error', (error) => {
      console.error('[ielts-mcp] background web server failed:', String((error as Error).message || error));
    });
    child.unref();
    console.error('[ielts-mcp] started background web server on port ' + String(port));
    return true;
  } catch (error) {
    console.error('[ielts-mcp] background web server spawn failed:', String((error as Error).message || error));
    return false;
  }
}

async function ensureWebServer(
  url: string,
  allowSpawn: boolean,
): Promise<{ running: boolean; spawned: boolean }> {
  let port = serverPort();
  try {
    const parsed = new URL(url);
    if (parsed.port) port = Number(parsed.port);
  } catch {
    /* keep the PORT fallback */
  }
  const healthUrl = 'http://127.0.0.1:' + String(port) + '/health';
  if (await probeHealth(healthUrl)) return { running: true, spawned: false };
  if (!allowSpawn) return { running: false, spawned: false };

  const spawned = spawnBackgroundServer(port);
  if (!spawned) return { running: false, spawned: false };
  const deadline = Date.now() + AUTOSTART_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    if (await probeHealth(healthUrl, 500)) return { running: true, spawned: true };
  }
  return { running: false, spawned: true };
}

/** Open the OS default browser; never throws, resolves whether the spawn worked. */
function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    try {
      const isWindows = process.platform === 'win32';
      const command = isWindows ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = isWindows ? ['/c', 'start', '', url] : [url];
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', (error) => {
        console.error('[ielts-mcp] open browser failed:', String((error as Error).message || error));
        finish(false);
      });
      child.once('spawn', () => finish(true));
      child.unref();
      // 'spawn' always fires quickly; the timer is only a safety net.
      setTimeout(() => finish(true), 1000).unref?.();
    } catch (error) {
      console.error('[ielts-mcp] open browser failed:', String((error as Error).message || error));
      finish(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Shared mappers
// ---------------------------------------------------------------------------

function summary(lesson: LessonRecord) {
  const lines = lesson.lines || [];
  const lineCount = lines.length;
  const turnCount = lines.filter((line) => line.role === 'user').length;
  return {
    lessonId: lesson.id,
    id: lesson.id,
    status: lesson.status || (lesson.report ? 'completed' : 'live'),
    partMode: lesson.partMode,
    topic: lesson.topic,
    startedAt: lesson.startedAt,
    lineCount,
    turnCount,
    hasReport: Boolean(lesson.report),
    reviewFocus: lesson.reviewFocus || '',
  };
}

function toText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toTurnFeedback(value: z.output<typeof turnFeedbackSchema>): TurnFeedback {
  return {
    corrected_text: value.corrected_text,
    upgraded_text: value.upgraded_text,
    grammar_mistakes: value.grammar_mistakes.map(
      (item): GrammarMistake => ({
        original: item.original,
        corrected: item.corrected,
        category: item.category,
        explanation_zh: item.explanation_zh,
      }),
    ),
    lexical_tips: value.lexical_tips.map(
      (item): LexicalTip => ({ basic: item.basic, upgraded: item.upgraded, usage_zh: item.usage_zh }),
    ),
    coach_note_zh: value.coach_note_zh,
  };
}

/**
 * Map externally supplied custom questions onto plan questions. A prompt that
 * looks like a Part 2 cue card (contains "Describe" and "You should say") is
 * marked cue_card; everything else is a normal question.
 */
function mapCustomQuestions(custom: string[]): PlanQuestion[] {
  let seenCueCard = false;
  return custom.slice(0, 8).map((text) => {
    const isCue = /describe/i.test(text) && /you should say/i.test(text);
    const part: PlanQuestion['part'] = isCue ? 'part2' : seenCueCard ? 'part3' : 'part1';
    if (isCue) seenCueCard = true;
    return { part, kind: isCue ? 'cue_card' : 'question', text };
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'ielts-speaking-coach', version: '2.2.5' });

  server.tool(
    'get_learner_context',
    'Read recent lessons, all long-term memory and the local web-server status before planning a lesson.',
    {},
    async () => {
      const lessons = listLessons(5).map(summary);
      const status = await localServerStatus();
      return toText({ lessons, memory: listMemory(), server: status });
    },
  );

  server.tool(
    'create_lesson',
    'Create a lesson (custom questions or auto plan), save it, and return the browser URL to start speaking.',
    {
      partMode: z.enum(['part1', 'part2', 'part3', 'full_mock']).default('part1'),
      targetBand: z.number().min(0).max(9).optional(),
      topicHint: z.string().optional(),
      style: z.enum(['friendly', 'strict', 'coach']).optional(),
      customQuestions: z.array(z.string()).optional(),
      reviewFocus: z.string().optional(),
      openBrowser: z.boolean().optional(),
    },
    async (args) => {
      const partMode = (args.partMode || 'part1') as PartMode;
      const targetBand = typeof args.targetBand === 'number' ? args.targetBand : 7;
      let plan: LessonPlan = planLesson(partMode, targetBand, args.topicHint || '');
      const custom = (args.customQuestions || []).map((question) => question.trim()).filter(Boolean);
      if (custom.length > 0) {
        plan = { ...plan, questions: mapCustomQuestions(custom) };
      }
      const lessonId = 'l-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 6);
      const lesson: LessonRecord = {
        id: lessonId,
        startedAt: Date.now(),
        endedAt: null,
        partMode,
        topic: plan.topic,
        provider: 'qwen',
        lines: [],
        feedback: {},
        report: null,
        status: 'planned',
        plan,
        reviewFocus: args.reviewFocus || '',
      };
      upsertLesson(lesson);

      const url = baseUrl() + '/?lesson=' + encodeURIComponent(lessonId);
      const loopback = isLoopbackHost(new URL(url).hostname);
      const wantBrowser = loopback && args.openBrowser !== false;
      let serverRunning = false;
      let browserOpened = false;
      if (loopback) {
        const status = await ensureWebServer(url, Boolean(options.stdio && wantBrowser));
        serverRunning = status.running;
      }
      if (wantBrowser && serverRunning) {
        browserOpened = await openBrowser(url);
      }
      return toText({ lessonId, url, serverRunning, browserOpened, plan });
    },
  );

  server.tool(
    'list_lessons',
    'List recent lessons with status, topic, turn count and report availability.',
    { limit: z.number().min(1).max(40).optional() },
    async (args) => toText({ lessons: listLessons(args.limit || 10).map(summary) }),
  );

  server.tool(
    'get_lesson_transcript',
    'Get the full two-way transcript, plan, feedback and report of a lesson (defaults to the latest one with turns).',
    { lessonId: z.string().optional() },
    async (args) => {
      const lesson = args.lessonId ? getLesson(args.lessonId) : latestLessonWithTurns();
      if (!lesson) return toText({ error: '没有找到课程记录' });
      return toText(lesson);
    },
  );

  server.tool(
    'save_turn_feedback',
    'Write per-turn correction cards (grammar fixes + Band 8 upgrades) back into a lesson.',
    {
      lessonId: z.string().min(1),
      // Plain z.object (not strictObject): external LLMs (豆包 / Codex / dsh) often
      // add harmless extra fields such as `turnIndex`; stripping them beats
      // rejecting the whole write-back and losing the learner's review.
      items: z
        .array(z.object({ lineId: z.string().min(1), feedback: turnFeedbackSchema }))
        .min(1),
    },
    async (args) => {
      const lesson = getLesson(args.lessonId);
      if (!lesson) return toText({ error: '课程不存在' });
      const feedback: Record<string, TurnFeedback> = { ...(lesson.feedback || {}) };
      let saved = 0;
      for (const item of args.items) {
        if (!item || !item.lineId) continue;
        feedback[item.lineId] = toTurnFeedback(item.feedback);
        saved += 1;
      }
      const patched = patchLesson(args.lessonId, { feedback });
      if (!patched) return toText({ error: '课程不存在' });
      return toText({ ok: true, saved });
    },
  );

  server.tool(
    'save_lesson_report',
    'Write the four-dimension IELTS report back into a lesson and mark it completed.',
    { lessonId: z.string().min(1), report: lessonReportSchema },
    async (args) => {
      const lesson = getLesson(args.lessonId);
      if (!lesson) return toText({ error: '课程不存在' });
      const report: LessonReport = {
        bands: {
          overall: args.report.bands.overall,
          fc: args.report.bands.fc,
          lr: args.report.bands.lr,
          gra: args.report.bands.gra,
          pr: args.report.bands.pr,
        },
        summary_zh: args.report.summary_zh,
        top_mistakes: args.report.top_mistakes,
        upgraded_sentences: args.report.upgraded_sentences,
        memory_updates: args.report.memory_updates.map(
          (item): MemoryNote => ({
            id: item.id || 'm-' + Math.random().toString(36).slice(2, 10),
            kind: item.kind,
            title: item.title,
            content: item.content,
            createdAt: Date.now(),
          }),
        ),
      };
      const patched = patchLesson(args.lessonId, { report, endedAt: Date.now(), status: 'completed' });
      if (!patched) return toText({ error: '课程不存在' });
      return toText({ ok: true, lessonId: args.lessonId, status: 'completed' });
    },
  );

  server.tool(
    'upsert_memory',
    'Add or update long-term memory notes (weaknesses, facts, phrases) and optionally delete some.',
    {
      items: z.array(memoryUpdateSchema).default([]),
      deleteIds: z.array(z.string().min(1)).optional(),
    },
    async (args) => {
      const notes: MemoryNote[] = args.items.map((item) => ({
        id: item.id || 'm-' + Math.random().toString(36).slice(2, 10),
        kind: item.kind,
        title: item.title,
        content: item.content,
        createdAt: Date.now(),
      }));
      if (notes.length > 0) upsertMemory(notes);
      const removed = args.deleteIds && args.deleteIds.length > 0 ? deleteMemory(args.deleteIds) : 0;
      return toText({ ok: true, saved: notes.length, removed });
    },
  );

  return server;
}

export const MCP_TOOL_NAMES = [
  'get_learner_context',
  'create_lesson',
  'list_lessons',
  'get_lesson_transcript',
  'save_turn_feedback',
  'save_lesson_report',
  'upsert_memory',
] as const;

/** Auth helper used by the HTTP mount and the sync API. */
export function mcpToken(): string {
  return (process.env.MCP_TOKEN || process.env.ACCESS_CODE || '').trim();
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const clean = address.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

/**
 * MCP / sync token check. When a token is configured it must match (Bearer
 * header, or `?token=` for clients that cannot set headers). With no token
 * configured only loopback clients are allowed.
 */
export function allowMcpRequest(
  address: string | undefined,
  authorization: string | undefined,
  queryToken?: string | null,
): boolean {
  const token = mcpToken();
  const fromHeader = (authorization || '').replace(/^Bearer\s+/i, '').trim();
  const fromQuery = (queryToken || '').trim();
  const provided = fromHeader || fromQuery;
  if (token) return provided === token;
  return isLoopback(address);
}
