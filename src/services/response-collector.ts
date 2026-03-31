export class ResponseCollector {
  private messages: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private resolvePromise: ((text: string | null) => void) | null = null;
  private silenceMs: number;

  constructor(silenceMs = 120_000) {
    this.silenceMs = silenceMs;
  }

  collect(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;

      // Overall timeout
      setTimeout(() => {
        this.finish();
      }, timeoutMs);
    });
  }

  addMessage(text: string): void {
    this.messages.push(text);

    // Reset silence timer
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.finish();
    }, this.silenceMs);
  }

  get isCollecting(): boolean {
    return this.resolvePromise !== null;
  }

  private finish(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.resolvePromise) {
      const text = this.messages.length > 0 ? this.messages.join('\n\n') : null;
      this.resolvePromise(text);
      this.resolvePromise = null;
      this.messages = [];
    }
  }
}
