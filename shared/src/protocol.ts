/** One protocol for every provider; the browser only ever speaks this. */

export type ClientEvent =
  | {
      type: 'start_session';
      provider: 'qwen' | 'gemini' | 'openai';
      model: string;
      voice?: string;
      endpointUrl?: string;
      workspaceId?: string;
      apiKey?: string;
      accessCode?: string;
      systemPrompt: string;
      turnMode: 'auto' | 'manual';
      inputSampleRate: 16000;
    }
  | { type: 'update_turn_mode'; turnMode: 'auto' | 'manual' }
  | { type: 'commit_turn' }
  | { type: 'interrupt' }
  | { type: 'trigger_greeting'; text: string }
  | { type: 'end_session' };

export type ServerEvent =
  | { type: 'session_ready'; provider: string; model: string; outputSampleRate: number }
  | { type: 'user_speech_started' }
  | { type: 'user_speech_stopped' }
  | { type: 'user_transcript_delta'; itemId: string; text: string; mode: 'replace' | 'append' }
  | { type: 'user_transcript_final'; itemId: string; text: string }
  | { type: 'examiner_transcript_delta'; itemId: string; delta: string }
  | { type: 'examiner_transcript_final'; itemId: string; text: string }
  | { type: 'examiner_turn_done'; itemId: string }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export function isClientEvent(value: unknown): value is ClientEvent {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string');
}
