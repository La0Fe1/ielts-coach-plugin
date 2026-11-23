import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LessonRecord, MemoryNote, TurnFeedback } from '@ielts/shared';
import {
  dataDir,
  deleteMemory,
  getLesson,
  latestLessonWithTurns,
  listLessons,
  listMemory,
  patchLesson,
  readStore,
  setLessonStatus,
  storePath,
  syncLesson,
  updateStore,
  upsertLesson,
  upsertMemory,
} from '../src/store';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-store-'));
  vi.stubEnv('IELTS_COACH_DATA_DIR', dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeLesson(id: string, overrides: Partial<LessonRecord> = {}): LessonRecord {
  return {
    id,
    startedAt: Date.now(),
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
    ...overrides,
  };
}

function makeFeedback(text: string): TurnFeedback {
  return {
    corrected_text: text,
    upgraded_text: text,
    grammar_mistakes: [],
    lexical_tips: [],
    coach_note_zh: '很好',
  };
}

function makeMemory(id: string, createdAt = Date.now()): MemoryNote {
  return { id, kind: 'weakness', title: '过去式 ' + id, content: 'go -> went', createdAt };
}

describe('store paths', () => {
  it('honours IELTS_COACH_DATA_DIR and defaults into ~/.ielts-coach', () => {
    expect(dataDir()).toBe(dir);
    expect(storePath()).toBe(path.join(dir, 'store.json'));
    vi.stubEnv('IELTS_COACH_DATA_DIR', '');
    expect(dataDir()).toBe(path.join(os.homedir(), '.ielts-coach'));
  });
});

describe('lessons', () => {
  it('creates a lesson and reads it back newest-first', () => {
    const older = makeLesson('l-old', { startedAt: 1000 });
    const newer = makeLesson('l-new', { startedAt: 2000 });
    upsertLesson(older);
    upsertLesson(newer);

    expect(getLesson('l-new')?.id).toBe('l-new');
    expect(getLesson('missing')).toBeNull();
    expect(listLessons().map((item) => item.id)).toEqual(['l-new', 'l-old']);
    expect(listLessons(1)).toHaveLength(1);
    expect(readStore().lessons).toHaveLength(2);
  });

  it('syncs transcript lines + feedback idempotently', () => {
    upsertLesson(makeLesson('l-sync', { feedback: { existing: makeFeedback('A') } }));
    const line = { id: 'line-1', role: 'user' as const, text: 'I go there yesterday', final: true, at: 1 };
    const first = syncLesson({
      ...makeLesson('l-sync'),
      lines: [line],
      feedback: { 'line-1': makeFeedback('B') },
      status: 'live',
    });
    const second = syncLesson({
      ...makeLesson('l-sync'),
      lines: [line],
      feedback: { 'line-1': makeFeedback('B') },
      status: 'live',
    });

    expect(first.id).toBe('l-sync');
    expect(second.id).toBe('l-sync');
    const stored = readStore().lessons;
    expect(stored).toHaveLength(1);
    expect(stored[0].lines).toHaveLength(1);
    expect(Object.keys(stored[0].feedback).sort()).toEqual(['existing', 'line-1']);
    expect(latestLessonWithTurns()?.id).toBe('l-sync');
  });

  it('patches feedback/report/status atomically', () => {
    upsertLesson(makeLesson('l-patch'));
    const patched = patchLesson('l-patch', { feedback: { 'line-1': makeFeedback('X') } });
    expect(patched?.feedback['line-1'].corrected_text).toBe('X');
    expect(patchLesson('missing', { status: 'live' })).toBeNull();

    const reportLesson = setLessonStatus('l-patch', 'completed');
    expect(reportLesson?.status).toBe('completed');
    const withReport = patchLesson('l-patch', {
      report: {
        bands: { overall: 6.5, fc: 6.5, lr: 6, gra: 6.5, pr: 6 },
        summary_zh: '稳',
        top_mistakes: [],
        upgraded_sentences: [],
        memory_updates: [],
      },
      endedAt: 1234,
    });
    expect(withReport?.report?.bands.overall).toBe(6.5);
    const persisted = getLesson('l-patch');
    expect(persisted?.status).toBe('completed');
    expect(persisted?.endedAt).toBe(1234);
    expect(persisted?.feedback['line-1'].corrected_text).toBe('X');
  });

  it('writes atomically: no temp files left and store.json is valid JSON', () => {
    upsertLesson(makeLesson('l-atomic'));
    const files = fs.readdirSync(dir);
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(files).toContain('store.json');
    const raw = fs.readFileSync(path.join(dir, 'store.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { lessons?: Array<{ id?: string }> };
    expect(parsed.lessons?.[0]?.id).toBe('l-atomic');
  });

  it('caps lessons at 60, keeping the newest ones', () => {
    for (let index = 0; index < 65; index += 1) {
      upsertLesson(makeLesson('l-' + String(index), { startedAt: 1000 + index }));
    }
    const stored = readStore().lessons;
    expect(stored).toHaveLength(60);
    const ids = stored.map((item) => item.id);
    expect(ids).toContain('l-64');
    expect(ids).not.toContain('l-0');
    expect(listLessons(60)).toHaveLength(60);
  });
});

describe('memory', () => {
  it('writes, reads, updates and deletes notes', () => {
    upsertMemory([makeMemory('m-a', 1000), makeMemory('m-b', 2000)]);
    expect(listMemory().map((item) => item.id)).toEqual(['m-b', 'm-a']);

    upsertMemory([{ ...makeMemory('m-a', 1000), title: 'updated' }]);
    expect(listMemory()).toHaveLength(2);
    expect(listMemory().find((item) => item.id === 'm-a')?.title).toBe('updated');

    expect(deleteMemory(['m-a', 'missing'])).toBe(1);
    expect(listMemory().map((item) => item.id)).toEqual(['m-b']);
  });

  it('caps memory at 200, keeping the newest notes', () => {
    const notes: MemoryNote[] = [];
    for (let index = 0; index < 205; index += 1) notes.push(makeMemory('m-' + String(index), 1000 + index));
    upsertMemory(notes);
    const stored = readStore().memory;
    expect(stored).toHaveLength(200);
    const ids = stored.map((item) => item.id);
    expect(ids).toContain('m-204');
    expect(ids).not.toContain('m-0');
    expect(listMemory()).toHaveLength(200);
  });
});

describe('corruption handling', () => {
  it('returns an empty store and quarantines a corrupt file', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(storePath(), '{ this is not json', 'utf-8');
    expect(readStore()).toEqual({ lessons: [], memory: [] });
    expect(fs.readdirSync(dir).some((name) => name.startsWith('store.json.corrupt-'))).toBe(true);
    // A later write recreates a healthy file.
    updateStore((store) => {
      store.lessons.push(makeLesson('l-recovered'));
    });
    expect(getLesson('l-recovered')).toBeTruthy();
    expect(() => JSON.parse(fs.readFileSync(storePath(), 'utf-8'))).not.toThrow();
  });
});
