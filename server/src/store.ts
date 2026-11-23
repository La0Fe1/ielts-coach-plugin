/** Tiny shared JSON store that the web app and the MCP server both read.

Why a file: MCP clients cannot read the browser's IndexedDB. A local JSON file is
the bridge. Writes go to a temp file, are fsync'ed and renamed, so a concurrent
STDIO and HTTP process can never leave a half-written file behind.
*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LessonRecord, MemoryNote } from '@ielts/shared';

export interface StoreShape {
  lessons: LessonRecord[];
  memory: MemoryNote[];
}

/** Newest-first caps so a long-lived install cannot grow the JSON file forever. */
export const MAX_LESSONS = 60;
export const MAX_MEMORY = 200;

export function dataDir(): string {
  const custom = (process.env.IELTS_COACH_DATA_DIR || '').trim();
  return custom || path.join(os.homedir(), '.ielts-coach');
}

export function storePath(): string {
  return path.join(dataDir(), 'store.json');
}

function emptyStore(): StoreShape {
  return { lessons: [], memory: [] };
}

function normalized(raw: string): StoreShape {
  const parsed = JSON.parse(raw) as Partial<StoreShape> | null;
  if (!parsed || typeof parsed !== 'object') return emptyStore();
  return {
    lessons: Array.isArray(parsed.lessons) ? parsed.lessons.filter(Boolean) : [],
    memory: Array.isArray(parsed.memory) ? parsed.memory.filter(Boolean) : [],
  };
}

/** A broken file is quarantined instead of being silently overwritten forever. */
function quarantineCorruptStore(): void {
  try {
    fs.renameSync(storePath(), storePath() + '.corrupt-' + String(Date.now()));
  } catch {
    /* best effort */
  }
}

export function readStore(): StoreShape {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath(), 'utf-8');
  } catch {
    return emptyStore();
  }
  try {
    return normalized(raw);
  } catch {
    quarantineCorruptStore();
    return emptyStore();
  }
}

function writeAtomic(store: StoreShape): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, 'store.json.' + String(process.pid) + '.' + Math.random().toString(36).slice(2, 8) + '.tmp');
  const payload = JSON.stringify(store, null, 2);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, payload, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, storePath());
  } catch (error) {
    // Never leave a stray temp file behind if the rename failed.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function byNewest<T>(list: T[], timeOf: (item: T) => number): T[] {
  return list.slice().sort((a, b) => timeOf(b) - timeOf(a));
}

function trimStore(store: StoreShape): void {
  if (store.lessons.length > MAX_LESSONS) {
    store.lessons = byNewest(store.lessons, (item) => Number(item.startedAt) || 0).slice(0, MAX_LESSONS);
  }
  if (store.memory.length > MAX_MEMORY) {
    store.memory = byNewest(store.memory, (item) => Number(item.createdAt) || 0).slice(0, MAX_MEMORY);
  }
}

/** Read-modify-write; the temp-file + rename keeps it safe across processes. */
export function updateStore(mutator: (store: StoreShape) => void): StoreShape {
  const store = readStore();
  mutator(store);
  trimStore(store);
  writeAtomic(store);
  return store;
}

function mergeFeedback(existing: LessonRecord | undefined, incoming: LessonRecord): LessonRecord['feedback'] {
  return { ...(existing?.feedback || {}), ...(incoming.feedback || {}) };
}

export function upsertLesson(lesson: LessonRecord): LessonRecord {
  updateStore((store) => {
    const index = store.lessons.findIndex((item) => item.id === lesson.id);
    if (index === -1) {
      store.lessons.unshift(lesson);
      return;
    }
    const merged: LessonRecord = {
      ...store.lessons[index],
      ...lesson,
      feedback: mergeFeedback(store.lessons[index], lesson),
    };
    store.lessons[index] = merged;
  });
  return lesson;
}

export function getLesson(id: string): LessonRecord | null {
  return readStore().lessons.find((item) => item.id === id) || null;
}

export function listLessons(limit = 20): LessonRecord[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  return byNewest(readStore().lessons, (item) => Number(item.startedAt) || 0).slice(0, safeLimit);
}

export function latestLessonWithTurns(): LessonRecord | null {
  const lessons = listLessons(MAX_LESSONS).filter((item) => (item.lines || []).some((line) => line.role === 'user'));
  return lessons[0] || null;
}

/** Atomic read-modify-write patch used by the MCP tools (feedback, report, status). */
export function patchLesson(id: string, patch: Partial<LessonRecord>): LessonRecord | null {
  let result: LessonRecord | undefined;
  updateStore((store) => {
    const index = store.lessons.findIndex((item) => item.id === id);
    if (index === -1) return;
    const next: LessonRecord = {
      ...store.lessons[index],
      ...patch,
      feedback: mergeFeedback(store.lessons[index], patch as LessonRecord),
    };
    store.lessons[index] = next;
    result = next;
  });
  return result || null;
}

export function setLessonStatus(id: string, status: NonNullable<LessonRecord['status']>): LessonRecord | null {
  return patchLesson(id, { status });
}

export function upsertMemory(notes: MemoryNote[]): MemoryNote[] {
  updateStore((store) => {
    for (const note of notes) {
      const index = store.memory.findIndex((item) => item.id === note.id);
      if (index === -1) store.memory.unshift(note);
      else store.memory[index] = { ...store.memory[index], ...note };
    }
  });
  return notes;
}

export function deleteMemory(ids: string[]): number {
  let removed = 0;
  updateStore((store) => {
    store.memory = store.memory.filter((item) => {
      const drop = ids.includes(item.id);
      if (drop) removed += 1;
      return !drop;
    });
  });
  return removed;
}

export function listMemory(): MemoryNote[] {
  return byNewest(readStore().memory, (item) => Number(item.createdAt) || 0);
}

/** Merge the browser's copy of a lesson into the shared store (idempotent). */
export function syncLesson(lesson: LessonRecord): LessonRecord {
  const existing = getLesson(lesson.id);
  const merged: LessonRecord = {
    ...(existing || {}),
    ...lesson,
    feedback: mergeFeedback(existing || undefined, lesson),
  };
  updateStore((store) => {
    const index = store.lessons.findIndex((item) => item.id === lesson.id);
    if (index === -1) store.lessons.unshift(merged);
    else store.lessons[index] = merged;
  });
  return merged;
}
