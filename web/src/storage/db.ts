/** Local persistence: lessons, feedback and long-term memory in IndexedDB. */

import type { LessonRecord, LessonReport, MemoryNote, TurnFeedback } from '@ielts/shared';

const DB_NAME = 'ielts-coach-v2';
const DB_VERSION = 1;
const LESSONS = 'lessons';
const MEMORY = 'memory';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LESSONS)) db.createObjectStore(LESSONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(MEMORY)) db.createObjectStore(MEMORY, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(name: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const request = fn(tx.objectStore(name));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function saveLesson(lesson: LessonRecord): Promise<void> {
  await withStore(LESSONS, 'readwrite', (store) => store.put(lesson));
}

export async function listLessons(): Promise<LessonRecord[]> {
  const all = await withStore<LessonRecord[]>(LESSONS, 'readonly', (store) => store.getAll() as IDBRequest<LessonRecord[]>);
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function saveFeedback(lessonId: string, turnId: string, feedback: TurnFeedback): Promise<void> {
  const lessons = await listLessons();
  const lesson = lessons.find((item) => item.id === lessonId);
  if (!lesson) return;
  lesson.feedback[turnId] = feedback;
  await saveLesson(lesson);
}

export async function saveMemory(notes: MemoryNote[]): Promise<void> {
  for (const note of notes) {
    await withStore(MEMORY, 'readwrite', (store) => store.put(note));
  }
}

export async function listMemory(): Promise<MemoryNote[]> {
  const all = await withStore<MemoryNote[]>(MEMORY, 'readonly', (store) => store.getAll() as IDBRequest<MemoryNote[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveReport(lessonId: string, report: LessonReport): Promise<void> {
  const lessons = await listLessons();
  const lesson = lessons.find((item) => item.id === lessonId);
  if (!lesson) return;
  lesson.report = report;
  lesson.endedAt = Date.now();
  await saveLesson(lesson);
}

export async function exportArchive(): Promise<string> {
  const [lessons, memory] = await Promise.all([listLessons(), listMemory()]);
  return JSON.stringify({ version: 2, exportedAt: Date.now(), lessons, memory }, null, 2);
}

export async function importArchive(json: string): Promise<number> {
  const data = JSON.parse(json) as { lessons?: LessonRecord[]; memory?: MemoryNote[] };
  let count = 0;
  for (const lesson of data.lessons || []) {
    await saveLesson(lesson);
    count += 1;
  }
  if (data.memory) await saveMemory(data.memory);
  return count;
}
