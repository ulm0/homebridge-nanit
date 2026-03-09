import type { Logging } from 'homebridge';
import { pickPort } from 'pick-port';

export class LocalRtmpServer {
  private _port = 0;
  private _isRunning = false;
  private nms: InstanceType<typeof import('node-media-server').default> | null = null;

  constructor(
    private readonly log: Logging,
    private readonly preferredPort?: number,
  ) {}

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  async start(): Promise<number> {
    if (this._isRunning) return this._port;

    const NodeMediaServer = (await import('node-media-server')).default;

    this._port = this.preferredPort ?? await pickPort({ type: 'tcp', reserveTimeout: 5 });

    const config = {
      logType: 0,
      rtmp: {
        port: this._port,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
      },
    };

    this.nms = new NodeMediaServer(config);

    this.nms.on('prePublish', (...args: unknown[]) => {
      const streamPath = args[1] as string;
      this.log.debug(`RTMP stream publishing: ${streamPath}`);
    });

    this.nms.on('donePublish', (...args: unknown[]) => {
      const streamPath = args[1] as string;
      this.log.debug(`RTMP stream ended: ${streamPath}`);
    });

    this.nms.run();
    this._isRunning = true;
    this.log.info(`Local RTMP server started on port ${this._port}`);

    return this._port;
  }

  getLocalRtmpUrl(streamKey: string, localAddress: string): string {
    return `rtmp://${localAddress}:${this._port}/live/${streamKey}`;
  }

  stop(): void {
    if (this.nms) {
      this.nms.stop();
      this.nms = null;
    }
    this._isRunning = false;
    this.log.debug('Local RTMP server stopped');
  }
}
