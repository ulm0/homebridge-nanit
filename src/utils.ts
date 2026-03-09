import { spawn, type ChildProcess } from 'node:child_process';
import type { Logging } from 'homebridge';

export class FfmpegProcess {
  private process: ChildProcess | null = null;
  private _killed = false;

  constructor(
    private readonly log: Logging,
    private readonly name: string,
    private readonly videoProcessor: string,
    private readonly debug: boolean,
  ) {}

  start(args: string, onClose?: (code: number | null) => void): ChildProcess {
    this.log.debug(`[${this.name}] ffmpeg ${args}`);

    const ffmpegArgs = args.split(/\s+/).filter(a => a.length > 0);
    this.process = spawn(this.videoProcessor, ffmpegArgs, {
      env: process.env,
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      if (this.debug) {
        const lines = data.toString().split('\n').filter((l: string) => l.length > 0);
        for (const line of lines) {
          this.log.debug(`[${this.name}] ${line}`);
        }
      }
    });

    this.process.on('error', (err) => {
      this.log.error(`[${this.name}] ffmpeg error: ${err.message}`);
    });

    this.process.on('close', (code) => {
      if (!this._killed && code !== 0) {
        this.log.warn(`[${this.name}] ffmpeg exited with code ${code}`);
      }
      onClose?.(code);
    });

    return this.process;
  }

  get stdin() {
    return this.process?.stdin ?? null;
  }

  stop(): void {
    if (this.process && !this._killed) {
      this._killed = true;
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }

  get killed(): boolean {
    return this._killed;
  }
}

export function findFfmpeg(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}
