import type { Logging } from 'homebridge';
import type { StreamMode } from '../settings.js';
import type { NanitApiClient } from '../nanit/api.js';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import { LocalRtmpServer } from './local.js';
import { getCloudStreamUrl } from './cloud.js';
import type { StreamInfo } from '../nanit/types.js';
import { networkInterfaces } from 'node:os';

export class StreamResolver {
  private rtmpServer: LocalRtmpServer;

  constructor(
    private readonly log: Logging,
    private readonly api: NanitApiClient,
    private readonly mode: StreamMode,
    rtmpPort?: number,
  ) {
    this.rtmpServer = new LocalRtmpServer(log, rtmpPort);
  }

  async initialize(): Promise<void> {
    if (this.mode === 'local' || this.mode === 'auto') {
      await this.rtmpServer.start();
    }
  }

  async getStreamSource(
    babyUid: string,
    wsClient: NanitWebSocketClient,
  ): Promise<StreamInfo> {
    if (this.mode === 'cloud') {
      return this.getCloudStream(babyUid);
    }

    if (this.mode === 'local') {
      return this.getLocalStream(babyUid, wsClient);
    }

    // auto mode: try local first, fall back to cloud
    if (wsClient.isConnected) {
      try {
        return await this.getLocalStream(babyUid, wsClient);
      } catch (err) {
        this.log.warn('Local stream failed, falling back to cloud:', err);
      }
    }

    return this.getCloudStream(babyUid);
  }

  private getCloudStream(babyUid: string): StreamInfo {
    const url = getCloudStreamUrl(this.api, babyUid);
    this.log.debug(`Using cloud stream: ${url.replace(/\.[^.]+$/, '.<token>')}`);
    return { url, type: 'cloud' };
  }

  private async getLocalStream(
    babyUid: string,
    wsClient: NanitWebSocketClient,
  ): Promise<StreamInfo> {
    if (!this.rtmpServer.isRunning) {
      await this.rtmpServer.start();
    }

    const localAddress = this.getLocalAddress();
    const streamKey = babyUid;
    const rtmpUrl = this.rtmpServer.getLocalRtmpUrl(streamKey, localAddress);

    await wsClient.startStreaming(rtmpUrl);

    this.log.debug(`Using local stream: ${rtmpUrl}`);
    return { url: rtmpUrl, type: 'local' };
  }

  async stopLocalStream(babyUid: string, wsClient: NanitWebSocketClient): Promise<void> {
    if (!this.rtmpServer.isRunning) return;
    const localAddress = this.getLocalAddress();
    const rtmpUrl = this.rtmpServer.getLocalRtmpUrl(babyUid, localAddress);
    await wsClient.stopStreaming(rtmpUrl);
  }

  private getLocalAddress(): string {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  shutdown(): void {
    this.rtmpServer.stop();
  }
}
