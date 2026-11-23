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
  const model = settings.model.startsWith('models/') ? settings.model : 'models/' + settings.model;
  return (
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' +
    encodeURIComponent(settings.apiKey) +
    '&model=' +
    encodeURIComponent(model)
  );
}

export class GeminiAdapter implements RealtimeAdapter {
  readonly outputSampleRate = 24000;

  async start(settings: StartSettings, hooks: AdapterHooks): Promise<AdapterHandle> {
    const socket = new WebSocket(liveUrl(settings));
    const model = settings.model.startsWith('models/') ? settings.model : 'models/' + settings.model;
    let userTranscript = '';

    const send = (payload: Record<string, unknown>): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };

    socket.on('open', () => {
      // Gemini Live rejects the connection (1007) if responseModalities contains
      // TEXT, and the two transcription flags must sit at setup top level.
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
      send({ setup });
      hooks.emit({
        type: 'session_ready',
        provider: 'gemini',
        model: settings.model,
        outputSampleRate: this.outputSampleRate,
      });
    });

    socket.on('message', (raw) => {
      const event = safeJsonParse(raw.toString());
      if (!event) return;
      const emit = hooks.emit as (value: ServerEvent) => void;
      const serverContent = event.serverContent as Record<string, unknown> | undefined;
      if (serverContent) {
        if (serverContent.interrupted === true) {
          emit({ type: 'user_speech_started' });
          return;
        }
        const inputTranscription = serverContent.inputTranscription as { text?: unknown } | undefined;
        if (inputTranscription && typeof inputTranscription.text === 'string') {
          userTranscript += inputTranscription.text;
          emit({ type: 'user_transcript_delta', itemId: 'user', text: userTranscript, mode: 'replace' });
        }
        const outputTranscription = serverContent.outputTranscription as { text?: unknown } | undefined;
        if (outputTranscription && typeof outputTranscription.text === 'string') {
          emit({ type: 'examiner_transcript_delta', itemId: 'examiner', delta: outputTranscription.text });
        }
        const modelTurn = serverContent.modelTurn as { parts?: Array<Record<string, unknown>> } | undefined;
        for (const part of modelTurn?.parts || []) {
          const inline = part.inlineData as { data?: unknown; mimeType?: unknown } | undefined;
          if (!inline) continue;
          const pcm = decodeBase64Audio(inline.data);
          if (pcm) hooks.audio(pcm, this.outputSampleRate);
        }
        if (serverContent.turnComplete === true) {
          if (userTranscript.trim()) {
            emit({ type: 'user_transcript_final', itemId: 'user', text: userTranscript.trim() });
            userTranscript = '';
          }
          emit({ type: 'examiner_transcript_final', itemId: 'examiner', text: '' });
          emit({ type: 'examiner_turn_done', itemId: 'examiner' });
        }
        return;
      }
      if (event.setupComplete) {
        emit({ type: 'session_ready', provider: 'gemini', model: settings.model, outputSampleRate: this.outputSampleRate });
        return;
      }
      if (event.error) {
        hooks.failed(String((event.error as { message?: unknown }).message || 'Gemini error'), true);
      }
    });

    socket.on('close', () => hooks.failed('Gemini 连接已断开', true));
    socket.on('error', (error) => hooks.failed('Gemini 连接失败: ' + String(error?.message || error), true));

    return {
      sendAudio(pcm: Buffer) {
        if (pcm.length === 0) return;
        send({
          realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: pcm.toString('base64') } },
        });
      },
      setTurnMode(mode) {
        send({
          realtimeInputConfig: { automaticActivityDetection: { disabled: mode === 'manual' } },
        });
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
