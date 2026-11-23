/** Every provider adapter speaks this interface; the gateway speaks the protocol. */

import type { ServerEvent } from '@ielts/shared';

export interface StartSettings {
  provider: 'qwen' | 'gemini' | 'openai';
  model: string;
  voice?: string;
  endpointUrl?: string;
  workspaceId?: string;
  apiKey: string;
  systemPrompt: string;
  turnMode: 'auto' | 'manual';
}

export interface AdapterHandle {
  sendAudio(pcm: Buffer): void;
  setTurnMode(mode: 'auto' | 'manual'): void;
  commit(): void;
  interrupt(): void;
  greet(text: string): void;
  close(): void;
}

export interface AdapterHooks {
  emit: (event: ServerEvent) => void;
  /** Decoded PCM16 from the examiner, ready to forward as a binary frame. */
  audio: (pcm: Buffer, sampleRate: number) => void;
  /** Upstream closed or failed; the gateway reports it to the browser. */
  failed: (message: string, retryable: boolean) => void;
}

export interface RealtimeAdapter {
  readonly outputSampleRate: number;
  start(settings: StartSettings, hooks: AdapterHooks): Promise<AdapterHandle>;
}

export function decodeBase64Audio(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

/** 16 kHz -> 24 kHz linear interpolation (OpenAI wants 24 kHz PCM16). */
export function upsample16to24(input: Buffer): Buffer {
  const samples = Math.floor(input.length / 2);
  if (samples === 0) return Buffer.alloc(0);
  const source = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) source[i] = input.readInt16LE(i * 2);
  const outputSamples = Math.floor((samples * 3) / 2);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i += 1) {
    const position = (i * 2) / 3;
    const left = Math.floor(position);
    const right = Math.min(samples - 1, left + 1);
    const weight = position - left;
    const value = Math.round(source[left] * (1 - weight) + source[right] * weight);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return output;
}

export function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
