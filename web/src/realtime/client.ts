/** Browser side of the unified realtime protocol. */

import type { ClientEvent, ServerEvent } from '@ielts/shared';

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private outputSampleRate = 24000;
  onEvent: (event: ServerEvent) => void = () => undefined;
  onAudio: (pcm: ArrayBuffer, sampleRate: number) => void = () => undefined;
  onClose: (reason: string) => void = () => undefined;

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('无法连接本地网关'));
      ws.onclose = (event) => this.onClose(String(event.reason || 'closed'));
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') {
          this.onAudio(event.data as ArrayBuffer, this.outputSampleRate);
          return;
        }
        let payload: ServerEvent;
        try {
          payload = JSON.parse(event.data) as ServerEvent;
        } catch {
          return;
        }
        if (payload.type === 'session_ready') this.outputSampleRate = payload.outputSampleRate || 24000;
        this.onEvent(payload);
      };
    });
  }

  send(event: ClientEvent): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm);
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }
}
