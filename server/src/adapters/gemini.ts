/** Google Gemini Live API adapter. */

import WebSocket from 'ws';
import type { ServerEvent } from '@ielts/shared';
import {
  type AdapterHandle,
  type AdapterHooks,
  type RealtimeAdapter,
  type StartSettings,
  decodeBase64Audio,
  safeJsonParse,
} from './base';

function liveUrl(settings: StartSettings): string {
  if (settings.endpointUrl) return settings.endpointUrl;
  // model belongs in setup.model only; extra query params make Gemini reject it.
  return (
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' +
    encodeURIComponent(settings.apiKey)
  );
}

export class GeminiAdapter implements RealtimeAdapter {
  readonly outputSampleRate = 24000;

  async start(settings: StartSettings, hooks: AdapterHooks): Promise<AdapterHandle> {
    const socket = new WebSocket(liveUrl(settings));
    const model = settings.model.startsWith('models/') ? settings.model : 'models/' + settings.model;

    let ready = false;
    let userTranscript = '';
    let examinerTranscript = '';
    const pending: string[] = [];

    const rawSend = (payload: Record<string, unknown>): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    const send = (payload: Record<string, unknown>): void => {
      if (ready && socket.readyState === WebSocket.OPEN) rawSend(payload);
      else if (!ready) pending.push(JSON.stringify(payload));
    };
    const flush = (): void => {
      while (pending.length > 0) {
        const message = pending.shift();
        if (message && socket.readyState === WebSocket.OPEN) socket.send(message);
      }
    };

    const emit = hooks.emit as (value: ServerEvent) => void;
    const flushUser = (): void => {
      if (!userTranscript.trim()) return;
      emit({ type: 'user_transcript_final', itemId: 'user', text: userTranscript.trim() });
      userTranscript = '';
    };
    const flushExaminer = (): void => {
      const text = examinerTranscript.trim();
      examinerTranscript = '';
      if (text) emit({ type: 'examiner_transcript_final', itemId: 'examiner', text });
    };

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gemini 握手超时')), 12000);
      socket.once('open', () => {
        clearTimeout(timer);
        const setup: Record<string, unknown> = {
          model,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice || 'Aoede' } },
            },
          },
          systemInstruction: { parts: [{ text: settings.systemPrompt }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        };
        if (settings.turnMode === 'manual') {
          setup.realtimeInputConfig = { automaticActivityDetection: { disabled: true } };
        }
        rawSend({ setup });
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error('Gemini 连接失败: ' + String((error as Error)?.message || error)));
      });
    });

    socket.on('message', (raw) => {
      const event = safeJsonParse(raw.toString());
      if (!event) return;
      if (event.setupComplete) {
        ready = true;
        emit({ type: 'session_ready', provider: 'gemini', model: settings.model, outputSampleRate: this.outputSampleRate });
        flush();
        return;
      }
      const serverContent = event.serverContent as Record<string, unknown> | undefined;
      if (serverContent) {
        if (serverContent.interrupted === true) {
          emit({ type: 'user_speech_started' });
          flushExaminer();
          return;
        }
        const inputTranscription = serverContent.inputTranscription as { text?: unknown } | undefined;
        if (inputTranscription && typeof inputTranscription.text === 'string') {
          userTranscript += inputTranscription.text;
          emit({ type: 'user_transcript_delta', itemId: 'user', text: userTranscript, mode: 'replace' });
        }
        const outputTranscription = serverContent.outputTranscription as { text?: unknown } | undefined;
        if (outputTranscription && typeof outputTranscription.text === 'string') {
          // The examiner started answering: the learner's turn is over, so finalize
          // the user line FIRST to keep "you speak -> examiner replies" ordering.
          flushUser();
          examinerTranscript += outputTranscription.text;
          emit({ type: 'examiner_transcript_delta', itemId: 'examiner', delta: outputTranscription.text });
        }
        const modelTurn = serverContent.modelTurn as { parts?: Array<Record<string, unknown>> } | undefined;
        for (const part of modelTurn?.parts || []) {
          const inline = part.inlineData as { data?: unknown } | undefined;
          if (!inline) continue;
          flushUser();
          const pcm = decodeBase64Audio(inline.data);
          if (pcm) hooks.audio(pcm, this.outputSampleRate);
        }
        if (serverContent.turnComplete === true) {
          flushUser();
          flushExaminer();
          emit({ type: 'examiner_turn_done', itemId: 'examiner' });
        }
        return;
      }
      if (event.error) {
        const info = event.error as { message?: string } | undefined;
        hooks.failed(String(info?.message || 'Gemini error'), true);
      }
    });

    socket.on('close', () => hooks.failed('Gemini 连接已断开', true));
    socket.on('error', (error) => hooks.failed('Gemini 连接失败: ' + String((error as Error)?.message || error), true));

    return {
      sendAudio(pcm: Buffer) {
        if (pcm.length === 0) return;
        send({
          realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: pcm.toString('base64') } },
        });
      },
      setTurnMode() {
        // Gemini Live rejects mid-session top-level realtimeInputConfig (1007).
        // Manual control is expressed through commit() (activityEnd + turnComplete).
      },
      commit() {
        send({ realtimeInput: { activityEnd: {} } });
        send({ clientContent: { turns: [{ role: 'user', parts: [{ text: ' ' }] }], turnComplete: true } });
      },
      interrupt() {
        send({ realtimeInput: { activityStart: {} } });
      },
      greet(text: string) {
        send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
      },
      close() {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
}
