import Button from 'button';
import Control from 'control';
import { Battery } from 'peripherals';

globalThis.device = {
	pin: {
		epdSelect: 22,
		epdDC: 15,
		epdReset: 13,
		epdBusy: 34,
		epdPower: 12,

		button: 14,
		button1: 14,
		button2: 27,
		button3: 4,
		button4: 2,

		buzzer: 26,

		sdSelect: 21,
		sdPower: 5,

		batteryEnable: 25,
		batteryVoltage: 39,
		charging: 36,

		pcfInterrupt: 35,

		i2cSDA: 16,
		i2cSCL: 17
	},
	peripheral: {
		button: {
			Default: class {
				constructor(options) {
					return new device.peripheral.button.One(options);
				}
			},
			One: class {
				constructor(options) {
					return new Button({
						...options,
						buttonKey: 'button1',
					});
				}
			},
			Two: class {
				constructor(options) {
					return new Button({
						...options,
						buttonKey: 'button2',
					});
				}
			},
			Three: class {
				constructor(options) {
					return new Button({
						...options,
						buttonKey: 'button3',
					});
				}
			},
			Four: class {
				constructor(options) {
					return new Button({
						...options,
						buttonKey: 'button4',
					});
				}
			},
		},
		tone: {
			Default: class extends Control {
				tone(hz, duration) {
					this.postJSON({ buzzer: { hz, duration } });
				}
				mute() {
					this.postJSON({ buzzer: { hz: 0 } });
				}
			}
		},
		battery: {
			Default: class {
				#battery;
				constructor() {
					this.#battery = new Battery();
				}
				close() {
					this.#battery?.close();
					this.#battery = undefined;
				}
				// millivolts, matching the hardware provider
				read() {
					return Math.round(3300 + this.#battery.read() * 1000);
				}
			}
		}
	}
};
