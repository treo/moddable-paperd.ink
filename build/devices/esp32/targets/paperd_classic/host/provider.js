/*
 * Copyright (c) 2026  Moddable Tech, Inc.
 *
 *   This file is part of the Moddable SDK Runtime.
 *
 *   The Moddable SDK Runtime is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU Lesser General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   The Moddable SDK Runtime is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU Lesser General Public License for more details.
 *
 *   You should have received a copy of the GNU Lesser General Public License
 *   along with the Moddable SDK Runtime.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

/*
	paperd.ink classic (ESP32-WROOM-32 with 4.2 inch UC8176C e-paper panel)

	https://docs.paperd.ink/docs/hardware/hardware/
*/

import Analog from "embedded:io/analog";
import Digital from "embedded:io/digital";
import DigitalBank from "embedded:io/digitalbank";
import I2C from "embedded:io/i2c";
import PulseCount from "embedded:io/pulsecount";
import PWM from "embedded:io/pwm";
import Serial from "embedded:io/serial";
import SMBus from "embedded:io/smbus";
import SPI from "embedded:io/spi";

import Timer from "timer";

import Button from "button";

class Tone {
	#io;
	#timer;

	constructor() {
		this.#io = new PWM({pin: device.pin.buzzer});
	}
	close() {
		this.#io?.close();
		if (this.#timer)
			Timer.clear(this.#timer);
		this.#io = this.#timer = undefined;
	}
	tone(hz, duration) {
		const io = this.#io = new PWM({from: this.#io, hz});
		io.write(512);

		if (duration) {
			if (this.#timer)
				Timer.schedule(this.#timer, duration);
			else
				this.#timer = Timer.set(() => {
					this.#timer = undefined;
					this.mute();
				}, duration);
		}
		else if (this.#timer) {
			Timer.clear(this.#timer);
			this.#timer = undefined;
		}
	}
	mute() {
		this.#io.write(0);
	}
}

class Button1 {
	constructor(options) {
		return new Button({
			...options,
			io: Digital,
			pin: device.pin.button1,
			mode: Digital.InputPullUp,
			activeLow: true
		});
	}
}

class Button2 {
	constructor(options) {
		return new Button({
			...options,
			io: Digital,
			pin: device.pin.button2,
			mode: Digital.InputPullUp,
			activeLow: true
		});
	}
}

class Button3 {
	constructor(options) {
		return new Button({
			...options,
			io: Digital,
			pin: device.pin.button3,
			mode: Digital.InputPullUp,
			activeLow: true
		});
	}
}

class Button4 {
	constructor(options) {
		return new Button({
			...options,
			io: Digital,
			pin: device.pin.button4,
			mode: Digital.InputPullUp,
			activeLow: true
		});
	}
}

// Sweep knob: SPI clock for the brokered panel+SD bus. 400 kHz is the SD
// init spec ceiling; the panel's LUT downloads latch here (verified) and the
// open question is the module's true write edge. The clock canary: partial
// refresh duration. Register waveforms latched -> ~0.5-1 s; missed -> the OTP
// waveform returns at ~4 s, impossible to mistake. Sweep upward with
// examples/drivers/paperd-clock: 1M, 2M, 5M... the flash that trips the
// canary (or an SD init failure) names the ceiling, and the step below it
// ships.
// Shared SPI bus clock - the sweep table, measured on this board (panel
// LUT-latch canary = partial duration; SD verdict from init + write/verify
// round-trip):
//
//   400 kHz  panel green (2204/1244/1684 ms)   SD green        (spec ceiling)
//   1 MHz    panel green (partial 884 ms)      SD green, incl. write test
//   2 MHz    panel green (partial 764 ms)      SD green, incl. write test
//   5 MHz    panel green (partial 691 ms)      SD FAILS (verify read gets no
//                                              data token - cliff between 2 and 5)
//
// 2 MHz ships: the last rung with both tenants clean and margin on both
// edges (the panel's own edge is above 5; the SD's is between 2 and 5 - and
// 2 is still 5x above the SD init spec, a population-tested tolerance, so
// apps moving this value re-run the write test on their own cards first).
// Shared SPI bus clock - FINAL sweep table, all results with the SD pins
// parked by the panel driver (rail off, CS deselected - see uc8176.js):
//
//   400 kHz  PANEL: gray/BW full/partial all clean (2204/1244/~1684 ms),
//            ghosting at its documented baseline.   SD: green - init, reads,
//            MBR signature intact, write round-trip verified, two samples,
//            repeatedly.   => SHIPPED: the only clock both tenants pass.
//   1 MHz    PANEL: clean (full 1844, partial ~884 ms).   SD: FAILS -
//            readBlock came back "read token 55": card data desynced into
//            the token slot. Panel-only apps could live here; card users,
//            no.
//   2 MHz    PANEL: fully clean (full 1723, partial 763 ms, ghosting at
//            400 kHz norms - the old hello-vs-clock asymmetry is closed as
//            the zombie-card artifact).   SD: silently corrupt (completed
//            reads missing block-0's boot signature) - the dangerous class.
//
// The panel's register-write blackout at 10 MHz (era-defining, see docs)
// was real but is no longer the binding edge: with healthy pins the module
// latches configs to 2 MHz, and it is the SD card's read path that pins this
// bus to 400 kHz. Panel-only builds wanting the ~480 ms/partial may raise
// EPD_BUS_HZ themselves; anything touching the card should not.
const EPD_BUS_HZ = 400_000;

// The panel and the SD slot share the VSPI signals (18/23/19), and the
// embedded:io SPI implementation claims each pin for the lifetime of an
// instance - two drivers cannot both own the bus. The provider brokers the
// one instance; drivers take device.SPI.bus. It runs at 400 kHz, the SD-init
// ceiling: the panel's transfers grow to ~0.5 s, which hides entirely under
// its ~4 s BUSY-bound refresh, and the card gets a spec-legal clock without
// any reopen dance.
//
// Lazy, not module-scope: this provider is preloaded, and the linker runs
// preloaded module bodies ON THE BUILD MACHINE where io natives are
// unavailable - constructing the bus here would fail at xsl with
// "link: unavailable function". The getter defers creation to the first
// runtime access by a driver.
let spiBus;

const device = {
	I2C: {
		default: {
			io: I2C,
			data: 16,
			clock: 17
		}
	},
	SPI: {
		get bus() {
			if (!spiBus)
				trace("provider: building shared SPI bus at", EPD_BUS_HZ, "Hz\n");
			return spiBus ??= new SPI({
				clock: 18,
				out: 23,
				in: 19,
				port: 2,		// VSPI_HOST
				hz: EPD_BUS_HZ,
				mode: 0
			});
		},
		default: {
			io: SPI,
			clock: 18,
			out: 23,
			in: 19,
			port: 2		// VSPI_HOST
		}
	},
	io: {Analog, Digital, DigitalBank, I2C, PulseCount, PWM, Serial, SMBus, SPI},
	epd: {
		// readback experiment: REV/STATUS/ROTP over the SPI data line after the
		// first update each boot - distinguishes content from a pinned line,
		// and on a connected MISO maps the OTP (command defaults, LUT banks)
		readProbe: false,
		// band protocol: DEAD ON THIS CONTROLLER, tested at 400 kHz so the
		// verdict is the silicon's, not the bus's. The 0x90 window shrinks the
		// transfer (partial: 1244 -> 738/959/1199 ms for 44/154/274-row strips -
		// the timing model held to ~10%) but neither positions the write cursor
		// (windowed rows landed at RAM row 0, corrupting whatever lived there)
		// nor bounds the scan (DRF time never moved). The UC8176C has no RAM
		// write-address command at all - rows-only transfers for y0 > 0 are
		// structurally impossible; do not re-litigate this ladder
		bands: false
	},

	pin: {
		// e-paper panel; the panel is power-switched (active low) by EPD_EN
		epdSelect: 22,
		epdDC: 15,
		epdReset: 13,
		epdBusy: 34,
		epdPower: 12,

		// buttons, top to bottom
		button: 14,
		button1: 14,
		button2: 27,
		button3: 4,
		button4: 2,

		buzzer: 26,

		// microSD card on the shared VSPI bus
		sdSelect: 21,
		sdPower: 5,

		// LiPo
		batteryEnable: 25,
		batteryVoltage: 39,
		charging: 36,

		// PCF8574 IO expander (extension header, SD card detect)
		pcfInterrupt: 35,

		i2cSDA: 16,
		i2cSCL: 17
	},
	sensor: {
	},
	peripheral: {
		button: {
			Default: Button1,
			One: Button1,
			Two: Button2,
			Three: Button3,
			Four: Button4
		},
		tone: {
			Default: Tone
		},
		battery: {
			Default: class {
				#analog;
				#enable;
				constructor() {
					const Digital = device.io.Digital;
					if (undefined !== device.pin.batteryEnable)
						this.#enable = new Digital({
							pin: device.pin.batteryEnable,
							mode: Digital.Output,
							initialValue: 0		// active low; sense divider on
						});
					this.#analog = new Analog({
						pin: device.pin.batteryVoltage,
						attenuation: 3		// 11.2 dB: full-scale ~3.3V
					});
				}
				close() {
					this.#analog?.close();
					this.#enable?.close();
					this.#analog = this.#enable = undefined;
				}
				// millivolts at the battery; the sense divider is 1:1
				read() {
					let value = 0;
					for (let i = 0; i < 100; i++) {
						let voltage = (this.#analog.read() / (1 << this.#analog.resolution)) * 3300 * 2;
						value += Math.max(3000, Math.min(4300, voltage));
					}
					return Math.idiv(value, 100);
				}
			}
		}
	}
};

export default device;
