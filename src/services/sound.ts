import type { CharacteristicValue, Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

export class SoundMachineService {
  private readonly service: Service;
  private isPlaying = false;

  constructor(
    private readonly accessory: NanitCameraAccessory,
    private readonly log: Logging,
    private readonly wsClient: NanitWebSocketClient,
  ) {
    const { Service, Characteristic } = accessory.platform;

    this.service = accessory.accessory.getService('Sound Machine')
      || accessory.accessory.addService(Service.Switch, 'Sound Machine', 'nanit-sound-machine');

    this.service.setCharacteristic(Characteristic.Name, 'Sound Machine');

    this.service.getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    wsClient.onStateChange((state) => {
      if (state.soundPlaying !== undefined) {
        this.isPlaying = state.soundPlaying;
        this.service.updateCharacteristic(Characteristic.On, this.isPlaying);
      }
    });
  }

  getService(): Service {
    return this.service;
  }

  private async getOn(): Promise<CharacteristicValue> {
    return this.isPlaying;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.log.debug(`Setting sound machine: ${on}`);
    try {
      if (on) {
        await this.wsClient.startPlayback();
      } else {
        await this.wsClient.stopPlayback();
      }
      this.isPlaying = on;
    } catch (err) {
      this.log.error('Failed to set sound machine:', err);
      throw err;
    }
  }
}
