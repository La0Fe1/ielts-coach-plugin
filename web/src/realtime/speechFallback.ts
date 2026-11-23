/**
 * Draft captions while the server has not sent a delta yet.
 *
 * Some third-party gateways only send .completed, which leaves the learner
 * staring at an empty bubble while they talk. The browser's SpeechRecognition
 * fills that gap as grey preview text; the server transcript replaces it.
 */

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

export class DraftCaption {
  private recognition: RecognitionLike | null = null;
  private active = false;
  private readonly Ctor: RecognitionCtor | null;

  constructor(onDraft: (text: string) => void) {
    const win = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    this.Ctor = win.SpeechRecognition || win.webkitSpeechRecognition || null;
    if (!this.Ctor) return;
    const recognition = new this.Ctor();
    recognition.lang = 'en-GB';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result && result[0]) text += result[0].transcript;
      }
      onDraft(text.trim());
    };
    recognition.onerror = () => undefined;
    this.recognition = recognition;
  }

  get supported(): boolean {
    return Boolean(this.recognition);
  }

  start(): void {
    if (!this.recognition || this.active) return;
    try {
      this.recognition.start();
      this.active = true;
    } catch {
      /* already started */
    }
  }

  stop(): void {
    if (!this.recognition || !this.active) return;
    try {
      this.recognition.stop();
    } catch {
      /* already stopped */
    }
    this.active = false;
  }
}
