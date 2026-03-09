import type { Logging, PlatformAccessory, Service } from 'homebridge';
import type { NanitPlatform } from './platform.js';
import type { NanitWebSocketClient } from './nanit/websocket.js';
import type { NanitApiClient } from './nanit/api.js';
import type { StreamResolver } from './stream/resolver.js';
import type { CameraInfo } from './nanit/types.js';
import type { NanitPlatformConfig } from './settings.js';
import { NanitStreamingDelegate } from './streaming.js';
import { NightLightService } from './services/light.js';
import { SoundMachineService } from './services/sound.js';
import { SensorServices } from './services/sensors.js';

export class NanitCameraAccessory {
  private streamingDelegate: NanitStreamingDelegate;
  private nightLightService?: NightLightService;
  private soundMachineService?: SoundMachineService;
  private sensorServices?: SensorServices;

  constructor(
    public readonly platform: NanitPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly log: Logging,
    private readonly cameraInfo: CameraInfo,
    private readonly wsClient: NanitWebSocketClient,
    private readonly nanitApi: NanitApiClient,
    private readonly streamResolver: StreamResolver,
    private readonly config: NanitPlatformConfig,
  ) {
    const { Characteristic, Service } = platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Nanit')
      .setCharacteristic(Characteristic.Model, 'Nanit Camera')
      .setCharacteristic(Characteristic.SerialNumber, cameraInfo.cameraUid);

    this.streamingDelegate = new NanitStreamingDelegate(
      log,
      platform.api.hap,
      platform.api,
      cameraInfo.babyName,
      cameraInfo.babyUid,
      streamResolver,
      wsClient,
      nanitApi,
      config,
    );

    this.accessory.configureController(this.streamingDelegate.controller);

    const cameraConfig = config.cameras?.find(c => c.babyUid === cameraInfo.babyUid);
    const enableLight = cameraConfig?.enableLight ?? true;
    const enableSound = cameraConfig?.enableSound ?? true;
    const enableSensors = cameraConfig?.enableSensors ?? true;

    if (enableLight) {
      this.nightLightService = new NightLightService(this, log, wsClient);
    }

    if (enableSound) {
      this.soundMachineService = new SoundMachineService(this, log, wsClient);
    }

    if (enableSensors) {
      this.sensorServices = new SensorServices(this, log, wsClient);
    }

    wsClient.onStateChange((state) => {
      if (state.firmwareVersion) {
        this.accessory.getService(Service.AccessoryInformation)!
          .updateCharacteristic(Characteristic.FirmwareRevision, state.firmwareVersion);
      }
    });
  }
}
