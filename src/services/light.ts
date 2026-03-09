import type { CharacteristicValue, Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

export class NightLightService {
  private readonly service: Service;
  private isOn = false;

  constructor(
    private readonly accessory: NanitCameraAccessory,
    private readonly log: Logging,
    private readonly wsClient: NanitWebSocketClient,
  ) {
    const { Service, Characteristic } = accessory.platform;

    this.service = accessory.accessory.getService('Night Light')
      || accessory.accessory.addService(Service.Lightbulb, 'Night Light', 'nanit-night-light');

    this.service.setCharacteristic(Characteristic.Name, 'Night Light');

    this.service.getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    wsClient.onStateChange((state) => {
      if (state.nightLightOn !== undefined) {
        this.isOn = state.nightLightOn;
        this.service.updateCharacteristic(Characteristic.On, this.isOn);
      }
    });
  }

  getService(): Service {
    return this.service;
  }

  private async getOn(): Promise<CharacteristicValue> {
    return this.isOn;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.log.debug(`Setting night light: ${on}`);
    try {
      await this.wsClient.setNightLight(on);
      this.isOn = on;
    } catch (err) {
      this.log.error('Failed to set night light:', err);
      throw err;
    }
  }
}
