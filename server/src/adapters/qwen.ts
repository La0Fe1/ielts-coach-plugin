/** Alibaba DashScope Qwen-Omni-Realtime adapter. */

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

function realtimeUrl(settings: StartSettings): string {
  if (settings.endpointUrl) return settings.endpointUrl;
  const model = encodeURIComponent(settings.model);
  if (settings.workspaceId) {
    return 'wss://' + settings.workspaceId + '.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=' + model;
  }
  return 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=' + model;
}

export class QwenAdapter implements RealtimeAdapter {
  readonly outputSampleRate = 24000;

  async start(settings: StartSettings, hooks: AdapterHooks): Promise<AdapterHandle> {
    const socket = new WebSocket(realtimeUrl(settings), {
      headers: { Authorization: 'Bearer ' + settings.apiKey },
    });

    let opened = false;
    const pending: string[] = [];
    const send = (payload: Record<string, unknown>): void => {
      const message = JSON.stringify(payload);
      if (opened && socket.readyState === WebSocket.OPEN) socket.send(message);
      else if (!opened) pending.push(message);
    };
    const flush = (): void => {
      while (pending.length > 0) {
        const message = pending.shift();
        if (message && socket.readyState === WebSocket.OPEN) socket.send(message);
      }
    };

    const sessionUpdate = (turnMode: 'auto' | 'manual'): void => {
      send({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: settings.systemPrompt,
          voice: settings.voice || 'Cherry',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
          turn_detection:
            turnMode === 'manual'
              ? null
              : { type: 'server_vad', threshold: 0.5, silence_duration_ms: 900 },
        },
      });
    };

    let mode: 'auto' | 'manual' = settings.turnMode;
    let closed = false;

    socket.on('open', () => {
      opened = true;
      sessionUpdate(mode);
      flush();
      hooks.emit({
        type: 'session_ready',
        provider: 'qwen',
        model: settings.model,
        outputSampleRate: this.outputSampleRate,
      });
    });

    socket.on('message', (raw) => {
      const event = safeJsonParse(raw.toString());
      if (!event) return;
      const type = String(event.type || '');
      const emit = hooks.emit as (value: ServerEvent) => void;
      if (type === 'input_audio_buffer.speech_started') {
        emit({ type: 'user_speech_started' });
        return;
      }
      if (type === 'input_audio_buffer.speech_stopped') {
        emit({ type: 'user_speech_stopped' });
        return;
      }
      if (type === 'conversation.item.input_audio_transcription.delta') {
        // DashScope sends stable prefix (text) + pending suffix (stash): the pair
        // is the WHOLE current sentence, so this must be a replace, not append.
        const text = String(event.text || '') + String(event.stash || '');
        emit({ type: 'user_transcript_delta', itemId: String(event.item_id || 'user'), text, mode: 'replace' });
        return;
      }
      if (type === 'conversation.item.input_audio_transcription.completed') {
        emit({
          type: 'user_transcript_final',
          itemId: String(event.item_id || 'user'),
          text: String(event.transcript || ''),
        });
        return;
      }
      if (type === 'response.audio_transcript.delta') {
        emit({
          type: 'examiner_transcript_delta',
          itemId: String(event.response_id || 'examiner'),
          delta: String(event.delta || ''),
        });
        return;
      }
      if (type === 'response.audio_transcript.done') {
        emit({
          type: 'examiner_transcript_final',
          itemId: String(event.response_id || 'examiner'),
          text: String(event.transcript || ''),
        });
        return;
      }
      if (type === 'response.audio.delta') {
        const pcm = decodeBase64Audio(event.delta);
        if (pcm) hooks.audio(pcm, this.outputSampleRate);
        return;
      }
      if (type === 'response.done') {
        const done = event.response as { id?: string } | undefined;
        emit({ type: 'examiner_turn_done', itemId: String(done?.id || 'examiner') });
        return;
      }
      if (type === 'error') {
        const info = event.error as { message?: string } | undefined;
        const message = String(info?.message || event.message || 'Qwen realtime error');
        hooks.failed(message, true);
      }
    });

    // Do not hand back a handle before the upstream socket is really usable:
    // otherwise the opening greeting is dropped on slow real networks.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Qwen 握手超时')), 12000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error('Qwen 连接失败: ' + String((error as Error)?.message || error)));
      });
    });

    socket.on('close', () => {
      if (!closed) hooks.failed('Qwen 连接已断开', true);
    });
    socket.on('error', (error) => {
      hooks.failed('Qwen 连接失败: ' + String(error?.message || error), true);
    });

    return {
      sendAudio(pcm: Buffer) {
        if (pcm.length === 0) return;
        send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
      },
      setTurnMode(next) {
        mode = next;
        sessionUpdate(next);
      },
      commit() {
        if (mode !== 'manual') return;
        send({ type: 'input_audio_buffer.commit' });
        send({ type: 'response.create' });
      },
      interrupt() {
        send({ type: 'response.cancel' });
        send({ type: 'input_audio_buffer.clear' });
      },
      greet(text: string) {
        send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
        send({ type: 'response.create' });
      },
      close() {
        closed = true;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
}
