import type {
  Accent,
  Bootstrap,
  CreateSessionInput,
  CreateSessionResult,
  LearnerContext,
  LessonReport,
  LlmTestInput,
  LlmTestResult,
  PracticeResult,
  Profile,
  Session,
  Turn,
  TurnReply,
} from './types'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail: unknown = response.statusText
    try {
      const body = (await response.json()) as Record<string, unknown>
      detail = body.detail ?? body.error ?? body.message ?? detail
    } catch {
      // Keep the HTTP status text when the daemon did not return JSON.
    }
    throw new ApiError(typeof detail === 'string' ? detail : JSON.stringify(detail), response.status)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : {}) as T
}

export async function getJSON<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { headers: { Accept: 'application/json' } }))
}

export async function postJSON<T>(path: string, body: unknown = {}): Promise<T> {
  return parse<T>(await fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }))
}

export async function patchJSON<T>(path: string, body: unknown = {}): Promise<T> {
  return parse<T>(await fetch(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }))
}

export const api = {
  health: () => getJSON<Record<string, unknown>>('/health'),
  profile: () => getJSON<Profile>('/api/profile'),
  bootstrap: (sessionId: number) => getJSON<Bootstrap>(`/api/sessions/${sessionId}/bootstrap`),
  sessions: () => getJSON<{ sessions: Session[] }>('/api/sessions?limit=20'),
  sessionDetail: (sessionId: number) =>
    getJSON<{ session: Session; report: LessonReport | null }>(`/api/sessions/${sessionId}`),
  createSession: (body: CreateSessionInput) => postJSON<CreateSessionResult>('/api/sessions', body),
  turns: (sessionId: number) => getJSON<{ turns: Turn[] }>(`/api/sessions/${sessionId}/turns`),
  context: () => getJSON<LearnerContext>('/api/learner/context'),
  report: (sessionId: number) => getJSON<LessonReport>(`/api/sessions/${sessionId}/report`),
  recordingStart: (sessionId: number) => postJSON(`/api/sessions/${sessionId}/recording_start`),
  recordingCancel: (sessionId: number) => postJSON(`/api/sessions/${sessionId}/recording_cancel`),
  endLesson: (sessionId: number, reason = 'user_clicked_end') =>
    postJSON(`/api/sessions/${sessionId}/end`, { reason }),
  updateProfile: (body: Record<string, unknown>) => patchJSON<Profile>('/api/profile', body),
  testLlm: (body: LlmTestInput) => postJSON<LlmTestResult>('/api/llm/test', body),
  ttsWord: (text: string, accent: Accent) =>
    getJSON<{ url: string; duration_sec?: number }>(
      `/api/tts/word?text=${encodeURIComponent(text)}&accent=${accent}`,
    ),
  ttsSay: (text: string, accent: Accent) =>
    getJSON<{ url: string; duration_sec?: number }>(
      `/api/tts/say?text=${encodeURIComponent(text)}&accent=${accent}`,
    ),
  uploadAudio: async (sessionId: number, blob: Blob, probeId?: string): Promise<TurnReply> => {
    const form = new FormData()
    form.append('file', blob, 'turn.wav')
    if (probeId) form.append('probe_id', probeId)
    const response = await fetch(`/api/sessions/${sessionId}/audio`, { method: 'POST', body: form })
    return parse<TurnReply>(response)
  },
  practiceSentence: async (
    sessionId: number,
    blob: Blob,
    targetText: string,
    accent: Accent,
  ): Promise<PracticeResult> => {
    const form = new FormData()
    form.append('file', blob, 'shadowing.wav')
    form.append('target_text', targetText)
    form.append('accent', accent)
    const response = await fetch(`/api/sessions/${sessionId}/practice_sentence`, { method: 'POST', body: form })
    return parse<PracticeResult>(response)
  },
}
