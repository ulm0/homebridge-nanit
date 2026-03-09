import type {
  API,
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  HAP,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import {
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  StreamRequestTypes,
} from 'homebridge';
import { createSocket, type Socket } from 'node:dgram';
import { pickPort } from 'pick-port';
import { FfmpegProcess, findFfmpeg } from './utils.js';
import type { StreamResolver } from './stream/resolver.js';
import type { NanitWebSocketClient } from './nanit/websocket.js';
import type { NanitApiClient } from './nanit/api.js';
import type { NanitPlatformConfig } from './settings.js';

interface SessionInfo {
  address: string;
  ipv6: boolean;
  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: number;
  videoSRTP: Buffer;
  videoSSRC: number;
  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: number;
  audioSRTP: Buffer;
  audioSSRC: number;
}

interface ActiveSession {
  mainProcess?: FfmpegProcess;
  returnProcess?: FfmpegProcess;
  timeout?: ReturnType<typeof setTimeout>;
  socket?: Socket;
}

export class NanitStreamingDelegate implements CameraStreamingDelegate {
  readonly controller: CameraController;
  private readonly videoProcessor: string;
  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly ongoingSessions = new Map<string, ActiveSession>();

  private readonly maxWidth: number;
  private readonly maxHeight: number;
  private readonly maxFPS: number;
  private readonly maxBitrate: number;
  private readonly enableAudio: boolean;
  private readonly debug: boolean;

  constructor(
    private readonly log: Logging,
    private readonly hap: HAP,
    private readonly api: API,
    private readonly cameraName: string,
    private readonly babyUid: string,
    private readonly streamResolver: StreamResolver,
    private readonly wsClient: NanitWebSocketClient,
    private readonly nanitApi: NanitApiClient,
    config: NanitPlatformConfig,
  ) {
    this.videoProcessor = findFfmpeg();
    this.maxWidth = config.videoConfig?.maxWidth ?? 1280;
    this.maxHeight = config.videoConfig?.maxHeight ?? 720;
    this.maxFPS = config.videoConfig?.maxFPS ?? 30;
    this.maxBitrate = config.videoConfig?.maxBitrate ?? 2000;
    this.enableAudio = config.videoConfig?.audio ?? true;
    this.debug = config.videoConfig?.debug ?? false;

    api.on(APIEvent.SHUTDOWN, () => {
      for (const sessionId of this.ongoingSessions.keys()) {
        this.stopStream(sessionId);
      }
    });

    const options: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15],
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio: this.enableAudio,
          codecs: [
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: AudioStreamingSamplerate.KHZ_16,
            },
          ],
        },
      },
    };

    this.controller = new hap.CameraController(options);
  }

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    try {
      const snapshot = await this.nanitApi.getSnapshot(this.babyUid);
      callback(undefined, snapshot);
    } catch (err) {
      this.log.error(`[${this.cameraName}] Snapshot failed:`, err);

      try {
        const streamInfo = await this.streamResolver.getStreamSource(this.babyUid, this.wsClient);
        const ffmpeg = new FfmpegProcess(this.log, `${this.cameraName} Snapshot`, this.videoProcessor, this.debug);

        const snapshotBuffer = await new Promise<Buffer>((resolve, reject) => {
          const args = `-i ${streamInfo.url} -frames:v 1 -f image2 -vf scale=${request.width}:${request.height} -hide_banner -loglevel error pipe:1`;
          const proc = ffmpeg.start(args, (code) => {
            if (code !== 0 && !ffmpeg.killed) reject(new Error(`ffmpeg exited ${code}`));
          });

          let buffer = Buffer.alloc(0);
          proc.stdout?.on('data', (data: Buffer) => {
            buffer = Buffer.concat([buffer, data]);
          });
          proc.stdout?.on('end', () => resolve(buffer));

          setTimeout(() => {
            ffmpeg.stop();
            reject(new Error('Snapshot timeout'));
          }, 15_000);
        });

        callback(undefined, snapshotBuffer);
      } catch (fallbackErr) {
        this.log.error(`[${this.cameraName}] Snapshot fallback failed:`, fallbackErr);
        callback(fallbackErr as Error);
      }
    }
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const ipv6 = request.addressVersion === 'ipv6';
    const portOptions = { type: 'udp' as const, ip: ipv6 ? '::' : '0.0.0.0', reserveTimeout: 15 };

    const videoReturnPort = await pickPort(portOptions);
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioReturnPort = await pickPort(portOptions);
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      ipv6,
      videoPort: request.video.port,
      videoReturnPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC,
      audioPort: request.audio.port,
      audioReturnPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC,
    };

    const response: PrepareStreamResponse = {
      video: {
        port: videoReturnPort,
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: audioReturnPort,
        ssrc: audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);
    callback(undefined, response);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.debug(`[${this.cameraName}] Reconfigure request (ignored)`);
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
    const sessionInfo = this.pendingSessions.get(request.sessionID);
    if (!sessionInfo) {
      this.log.error(`[${this.cameraName}] No session info found`);
      callback(new Error('No session info'));
      return;
    }

    let streamInfo;
    try {
      streamInfo = await this.streamResolver.getStreamSource(this.babyUid, this.wsClient);
    } catch (err) {
      this.log.error(`[${this.cameraName}] Failed to get stream source:`, err);
      callback(err as Error);
      return;
    }

    const vcodec = 'libx264';
    const mtu = 1316;

    const width = Math.min(request.video.width, this.maxWidth);
    const height = Math.min(request.video.height, this.maxHeight);
    const fps = Math.min(request.video.fps, this.maxFPS);
    const videoBitrate = Math.min(request.video.max_bit_rate, this.maxBitrate);

    this.log.info(`[${this.cameraName}] Starting ${streamInfo.type} stream: ${width}x${height}@${fps}fps ${videoBitrate}kbps`);

    let ffmpegArgs = `-i ${streamInfo.url}`;

    // Video encoding
    ffmpegArgs += ` -an -sn -dn`;
    ffmpegArgs += ` -codec:v ${vcodec}`;
    ffmpegArgs += ` -pix_fmt yuv420p`;
    ffmpegArgs += ` -color_range mpeg`;
    ffmpegArgs += ` -r ${fps}`;
    ffmpegArgs += ` -f rawvideo`;
    ffmpegArgs += ` -preset ultrafast -tune zerolatency`;
    ffmpegArgs += ` -filter:v scale=${width}:${height}`;
    ffmpegArgs += ` -b:v ${videoBitrate}k`;
    ffmpegArgs += ` -payload_type ${request.video.pt}`;

    // Video SRTP output
    ffmpegArgs += ` -ssrc ${sessionInfo.videoSSRC}`;
    ffmpegArgs += ` -f rtp`;
    ffmpegArgs += ` -srtp_out_suite AES_CM_128_HMAC_SHA1_80`;
    ffmpegArgs += ` -srtp_out_params ${sessionInfo.videoSRTP.toString('base64')}`;
    ffmpegArgs += ` srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`;

    // Audio encoding
    if (this.enableAudio) {
      ffmpegArgs += ` -vn -sn -dn`;
      ffmpegArgs += ` -codec:a libfdk_aac`;
      ffmpegArgs += ` -profile:a aac_eld`;
      ffmpegArgs += ` -flags +global_header`;
      ffmpegArgs += ` -f null`;
      ffmpegArgs += ` -ar ${request.audio.sample_rate}k`;
      ffmpegArgs += ` -b:a ${request.audio.max_bit_rate}k`;
      ffmpegArgs += ` -ac ${request.audio.channel}`;
      ffmpegArgs += ` -payload_type ${request.audio.pt}`;

      // Audio SRTP output
      ffmpegArgs += ` -ssrc ${sessionInfo.audioSSRC}`;
      ffmpegArgs += ` -f rtp`;
      ffmpegArgs += ` -srtp_out_suite AES_CM_128_HMAC_SHA1_80`;
      ffmpegArgs += ` -srtp_out_params ${sessionInfo.audioSRTP.toString('base64')}`;
      ffmpegArgs += ` srtp://${sessionInfo.address}:${sessionInfo.audioPort}?rtcpport=${sessionInfo.audioPort}&pkt_size=188`;
    }

    ffmpegArgs += ` -loglevel level${this.debug ? '+verbose' : ''}`;
    ffmpegArgs += ` -progress pipe:1`;

    const activeSession: ActiveSession = {};

    // RTCP feedback socket for stream health monitoring
    activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
    activeSession.socket.on('error', (err) => {
      this.log.error(`[${this.cameraName}] Socket error: ${err.message}`);
      this.stopStream(request.sessionID);
    });
    activeSession.socket.on('message', () => {
      if (activeSession.timeout) clearTimeout(activeSession.timeout);
      activeSession.timeout = setTimeout(() => {
        this.log.info(`[${this.cameraName}] Stream inactive, stopping`);
        this.controller.forceStopStreamingSession(request.sessionID);
        this.stopStream(request.sessionID);
      }, 30_000);
    });
    activeSession.socket.bind(sessionInfo.videoReturnPort);

    activeSession.timeout = setTimeout(() => {
      this.log.info(`[${this.cameraName}] Stream timeout, stopping`);
      this.controller.forceStopStreamingSession(request.sessionID);
      this.stopStream(request.sessionID);
    }, 30_000);

    const mainProcess = new FfmpegProcess(this.log, this.cameraName, this.videoProcessor, this.debug);
    mainProcess.start(ffmpegArgs, () => {
      // Stream ended
    });
    activeSession.mainProcess = mainProcess;

    // Two-way audio (return channel)
    if (this.enableAudio) {
      this.setupReturnAudio(request, sessionInfo, activeSession);
    }

    this.ongoingSessions.set(request.sessionID, activeSession);
    this.pendingSessions.delete(request.sessionID);
    callback();
  }

  private setupReturnAudio(
    request: StartStreamRequest,
    sessionInfo: SessionInfo,
    activeSession: ActiveSession,
  ): void {
    const ipVer = sessionInfo.ipv6 ? 'IP6' : 'IP4';

    const sdp = [
      'v=0',
      `o=- 0 0 IN ${ipVer} ${sessionInfo.address}`,
      's=Talk',
      `c=IN ${ipVer} ${sessionInfo.address}`,
      't=0 0',
      `m=audio ${sessionInfo.audioReturnPort} RTP/AVP 110`,
      'b=AS:24',
      'a=rtpmap:110 MPEG4-GENERIC/16000/1',
      'a=rtcp-mux',
      'a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00',
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${sessionInfo.audioSRTP.toString('base64')}`,
    ].join('\r\n');

    const returnArgs = [
      '-hide_banner',
      '-protocol_whitelist pipe,udp,rtp,file,crypto',
      '-f sdp',
      '-c:a libfdk_aac',
      '-i pipe:',
      '-f flv rtmp://localhost/nanit-return',
      `-loglevel level${this.debug ? '+verbose' : ''}`,
    ].join(' ');

    const returnProcess = new FfmpegProcess(
      this.log,
      `${this.cameraName} Two-way`,
      this.videoProcessor,
      this.debug,
    );
    const proc = returnProcess.start(returnArgs);
    proc.stdin?.end(sdp);
    activeSession.returnProcess = returnProcess;
  }

  private stopStream(sessionId: string): void {
    const session = this.ongoingSessions.get(sessionId);
    if (session) {
      if (session.timeout) clearTimeout(session.timeout);
      try { session.socket?.close(); } catch { /* ignore */ }
      try { session.mainProcess?.stop(); } catch { /* ignore */ }
      try { session.returnProcess?.stop(); } catch { /* ignore */ }
    }
    this.ongoingSessions.delete(sessionId);
    this.log.info(`[${this.cameraName}] Stream stopped`);
  }
}
