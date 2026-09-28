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
	Driver for 4.2 inch e-paper panels using the UltraChip UC8176C controller,
	notably the Good Display GDEW042T2 as found on the paperd.ink classic.

	Datasheet for controller: https://www.e-paper-display.com/download_detail/downloadsId=821.html
	Reference implementation: https://github.com/paperdink/PaperdInk-Library (GxEPD2_420)

	The panel is 400 x 300 pixels at 1 bit per pixel. The controller holds two
	plane buffers in its SRAM: "old" data (written with 0x10) and "new" data
	(written with 0x13). The refresh waveform is determined by the pixel pair
	(old, new), so a clean full refresh drives true transitions with the full
	LUT and a partial refresh drives true transitions with the partial LUT.
	This driver keeps both frames in host memory and writes both planes on
	every update, which makes partial updates correct regardless of what the
	panel RAM contains.

	A set bit is a white pixel in both planes.

	The driver requires a 256 Gray Poco/Piu framebuffer; gray levels are
	converted to black and white using dithering (commodetto/Dither).
*/

import Timer from "timer";
import Bitmap from "commodetto/Bitmap";
import Dither from "commodetto/Dither";

const WIDTH = 400;
const HEIGHT = 300;
const STRIDE = WIDTH >> 3;			// 50
const FRAME_BYTES = STRIDE * HEIGHT;		// 15_000

//
// waveforms (LUTs) for the GDEW042T2, as used by the Good Display demo code
//

const lut_vcom0_full = Uint8Array.of(
	0x00, 0x08, 0x00, 0x00, 0x00, 0x02,
	0x60, 0x28, 0x28, 0x00, 0x00, 0x01,
	0x00, 0x14, 0x00, 0x00, 0x00, 0x01,
	0x00, 0x12, 0x12, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00
);

const lut_ww_full = Uint8Array.of(
	0x40, 0x08, 0x00, 0x00, 0x00, 0x02,
	0x90, 0x28, 0x28, 0x00, 0x00, 0x01,
	0x40, 0x14, 0x00, 0x00, 0x00, 0x01,
	0xA0, 0x12, 0x12, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00
);

const lut_bw_full = Uint8Array.of(
	0x40, 0x08, 0x00, 0x00, 0x00, 0x02,
	0x90, 0x28, 0x28, 0x00, 0x00, 0x01,
	0x40, 0x14, 0x00, 0x00, 0x00, 0x01,
	0xA0, 0x12, 0x12, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00
);

const lut_wb_full = Uint8Array.of(
	0x80, 0x08, 0x00, 0x00, 0x00, 0x02,
	0x90, 0x28, 0x28, 0x00, 0x00, 0x01,
	0x80, 0x14, 0x00, 0x00, 0x00, 0x01,
	0x50, 0x12, 0x12, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00
);

const lut_bb_full = Uint8Array.of(
	0x80, 0x08, 0x00, 0x00, 0x00, 0x02,
	0x90, 0x28, 0x28, 0x00, 0x00, 0x01,
	0x80, 0x14, 0x00, 0x00, 0x00, 0x01,
	0x50, 0x12, 0x12, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00
);

// four-gray waveform, byte-for-byte from GxEPD2_420.cpp (GxEPD2_4G);
// {DTM1,DTM2} selects the row: 11 white, 10 light gray, 01 dark gray,
// 00 black - the mapping of the two conversion loops in writeImage_4G.
// Revived on the readback branch: every gray measurement of the earlier era
// ran at 10 MHz, where register downloads do not latch - at a clock the chip
// hears, these production-verified tables are expected to run for real
const lut_vcom0_4g = Uint8Array.of(
	0x00, 0x0A, 0x00, 0x00, 0x00, 0x01,
	0x60, 0x14, 0x14, 0x00, 0x00, 0x01,
	0x00, 0x14, 0x00, 0x00, 0x00, 0x01,
	0x00, 0x13, 0x0A, 0x01, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00
);
const lut_ww_4g = Uint8Array.of(		// white
	0x40, 0x0A, 0x00, 0x00, 0x00, 0x01,
	0x90, 0x14, 0x14, 0x00, 0x00, 0x01,
	0x10, 0x14, 0x0A, 0x00, 0x00, 0x01,
	0xA0, 0x13, 0x01, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00
);
const lut_bw_4g = Uint8Array.of(		// dark gray
	0x40, 0x0A, 0x00, 0x00, 0x00, 0x01,
	0x90, 0x14, 0x14, 0x00, 0x00, 0x01,
	0x00, 0x14, 0x0A, 0x00, 0x00, 0x01,
	0x99, 0x0C, 0x01, 0x03, 0x04, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00
);
const lut_wb_4g = Uint8Array.of(		// light gray
	0x40, 0x0A, 0x00, 0x00, 0x00, 0x01,
	0x90, 0x14, 0x14, 0x00, 0x00, 0x01,
	0x00, 0x14, 0x0A, 0x00, 0x00, 0x01,
	0x99, 0x0B, 0x04, 0x04, 0x01, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00
);
const lut_bb_4g = Uint8Array.of(		// black
	0x80, 0x0A, 0x00, 0x00, 0x00, 0x01,
	0x90, 0x14, 0x14, 0x00, 0x00, 0x01,
	0x20, 0x14, 0x0A, 0x00, 0x00, 0x01,
	0x50, 0x13, 0x01, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00
);

// partial update waveform; T1..T4 tuned for this panel (see GxEPD2)
const T1 = 25, T2 = 1, T3 = 4, T4 = 25;

function padLUT(lut, size) {
	const padded = new Uint8Array(size);
	padded.set(lut);
	return padded;
}

const lut_vcom0_partial = padLUT(Uint8Array.of(
	0x00, T1, T2, T3, T4, 1,
	0x00, 0x01, 0x00, 0x00, 0x00, 0x01
), 44);

const lut_ww_partial = padLUT(Uint8Array.of(
	0x18, T1, T2, T3, T4, 1,
	0x00, 0x01, 0x00, 0x00, 0x00, 0x01
), 42);

const lut_bw_partial = padLUT(Uint8Array.of(
	0x5A, T1, T2, T3, T4, 1,
	0x00, 0x01, 0x00, 0x00, 0x00, 0x01
), 42);

const lut_wb_partial = padLUT(Uint8Array.of(
	0xA5, T1, T2, T3, T4, 1,
	0x00, 0x01, 0x00, 0x00, 0x00, 0x01
), 42);

const lut_bb_partial = padLUT(Uint8Array.of(
	0x24, T1, T2, T3, T4, 1,
	0x00, 0x01, 0x00, 0x00, 0x00, 0x01
), 42);

class EPD {
	#onDisplayReady;
	#waitingPowerOn = false;
	#waitingDisplayDone = false;
	#waitingPowerOff = false;
	#waitingFrames;
	#hibernating = false;
	#t0 = 0;
	#mode = "full";
	#grayPath = false;
	#region;			// {y0, y1, commit} for windowed partial plane writes
	#readProbe = false;		// provider knob device.epd.readProbe
	#probed = false;

	constructor(options) {
		this.#onDisplayReady = options?.onDisplayReady;

		const Digital = device.io.Digital;
		const SPI = device.io.SPI;

		// panels wired through a power switch (paperd.ink classic: EPD_EN, active low)
		if (undefined !== device.pin.epdPower) {
			this.power = new Digital({
				pin: device.pin.epdPower,
				mode: Digital.Output,
				initialValue: 0
			});
			// power-on reset settling. The 10 ms rail number was not enough: an
			// app whose first panel transaction came within a few tens of ms of
			// the rail (paperd-hello) had its reset pulse eaten by the chip's own
			// POR - the whole retryless config sequence then landed on a chip
			// still booting, and every register/PLL/LUT write was lost (measured
			// as the OTP fallback: 4111 ms at a 2 MHz bus). An app that
			// incidentally delayed its first panel contact (SD traffic in
			// paperd-clock) latched everything on the same bus and driver - the
			// clean A/B that localized this. The vendor code's triple reset is
			// the same lesson, paid in ms at the reset instead of here; pay it
			// once, here, where every app profits
			Timer.delay(100);

			// The SD slot rail must never be left floating with a card
			// inserted: the phantom-powering mechanism (ESP32-driven MOSI/SCLK
			// injecting through the dead card's ESD diodes into its 0 V VDD)
			// half-wakes the card, loads the shared bus, corrupts plane streams
			// at fast clocks, and eats config latch margin - it explained the
			// 1 MHz ghosting, the 2 MHz hello/clock asymmetry, and probably
			// measurements older than both. The panel driver owns the rail OFF
			// for the life of the instance; SD applications borrow screen
			// .sdPower to turn it on, and hand it back when done
			if (undefined !== device.pin.sdPower)
				this.sdPower = new Digital({
					pin: device.pin.sdPower,
					mode: Digital.Output,
					initialValue: 1			// rail OFF (active low)
				});
			// ...and the rail alone does not kill the ghosting, because a card's
			// VDD pumps itself up to ~2.6 V off the panel traffic's own pulses
			// (rectified through the ESD diodes) no matter who owns the supply.
			// Such a card, with SPI CS floating (GPIO21 has no owner at boot),
			// can wake SELECTED and drive MISO into the pull-up and load the
			// shared lines. So SD_CS is owned too, parked HIGH = deselected:
			// the zombie card goes tri-state on MISO, its input loading drops,
			// and any SD app that boots finds a deselected slot to claim
			if (undefined !== device.pin.sdSelect)
				this.sdSelect = new Digital({
					pin: device.pin.sdSelect,
					mode: Digital.Output,
					initialValue: 1			// deselected
				});
		}

		this.select = new Digital({
			pin: device.pin.epdSelect,
			mode: Digital.Output,
			initialValue: 1
		});

		this.dc = new Digital({
			pin: device.pin.epdDC,
			mode: Digital.Output,
			initialValue: 1
		});

		this.reset = new Digital({
			pin: device.pin.epdReset,
			mode: Digital.Output,
			initialValue: 1
		});

		// BUSY_N; low while the controller is busy
		this.busy = new Digital({
			pin: device.pin.epdBusy,
			mode: Digital.Input,
			activeLow: true,
			edge: !this.#onDisplayReady ? 0 : Digital.Falling,
			onReadable: !this.#onDisplayReady ? undefined : () => {
				if (this.#waitingPowerOn) {
					this.#waitingPowerOn = false;
					this.#writeAndRefresh();
				}
				else if (this.#waitingDisplayDone) {
					this.#waitingDisplayDone = false;
					this.writeCMD(0x02);		// power off
					this.#waitingPowerOff = true;
				}
				else if (this.#waitingPowerOff) {
					this.#waitingPowerOff = false;
					trace("UC8176 timing: mode", this.#mode, "total", Date.now() - this.#t0, "ms\n");
					this.#onDisplayReady();
				}
				else
					throw new Error;
			}
		});

		// on boards whose provider brokers a shared bus (paperd.ink classic:
		// panel + SD on the same VSPI signals), join it; elsewhere own the pins
		// directly, as before
		this.spi = device.SPI?.bus ?? new SPI({
			...device.SPI.default,
			hz: 10_000_000,
			mode: 0
		});
		// two bytes of throwaway clocking on the shared bus: originally a
		// first-transaction theory, later attributed to the unparked SD_CS,
		// kept as cheap boot-time insurance for a device this paranoid
		this.spi.write(new Uint8Array(2));
		this.spi.byte = new Uint8Array(1);

		this.#readProbe = /^(1|true)$/i.test(String(globalThis.device?.epd?.readProbe ?? ""));
	}
	close() {
		this.sdPower?.close();
		this.sdPower = undefined;
		this.sdSelect?.close();
		this.sdSelect = undefined;
		this.select?.close();
		this.dc?.close();
		this.reset?.close();
		this.busy?.close();
		this.spi?.close();
		this.power?.close();

		// never close a bus brokered by the provider - other devices (the SD
		// slot on this board) share the instance; only the pins we own are ours
		// to release
		if (this.spi !== device.SPI?.bus)
			this.spi?.close();
		this.select = this.dc = this.reset = this.busy = this.spi = this.power = undefined;
	}

	writeCMD(cmd) {
		this.select.write(0);
		this.dc.write(0);
		this.spi.byte[0] = cmd;
		this.spi.write(this.spi.byte);
		this.select.write(1);
	}
	writeData(data) {
		this.select.write(0);
		this.dc.write(1);
		this.spi.byte[0] = data;
		this.spi.write(this.spi.byte);
		this.select.write(1);
	}
	writeDataBuffer(data) {
		this.select.write(0);
		this.dc.write(1);
		this.spi.write(data);
		this.select.write(1);
	}

	// ---- readback probe (provider knob device.epd.readProbe) ----
	// The UC8176C speaks over a single bidirectional data pad (die pin D1).
	// Whether the module routed it to the board's MISO (GPIO19) or tied it to
	// MOSI-only is a schematic question; this probe answers it electrically.
	// REV (0x70), STATUS (0x71) and ROTP (0xA2 - the OTP stream starting at
	// address 0x000: LUT revisions at 0x000/0x001, the command-default region
	// the power-on load copies at 0x020-0x033, waveform bank contents beyond)
	// either return content or a pinned line, and the difference is obvious.
	#commandRead(command, count)
	{
		this.select.write(0);
		this.dc.write(0);
		this.spi.byte[0] = command;
		this.spi.write(this.spi.byte);
		this.dc.write(1);
		const buf = new Uint8Array(count);
		this.spi.transfer(buf);					// clocks out 0xFF, captures D1
		this.select.write(1);
		return buf;
	}
	readoutProbe()
	{
		const hex = (b) => Array.from(b, v => v.toString(16).padStart(2, "0")).join(" ");
		// index where the trailing all-FF run begins: for a real device the
		// boundary is a property of ITS response; for coupled noise it tracks
		// the requested length
		const boundary = (b) =>
		{
			let i = b.length;
			while (i > 0 && 0xFF == b[i - 1])
				i--;
			return i;
		};
		trace("UC8176 probe REV    :", hex(this.#commandRead(0x70, 2)), "\n");
		trace("UC8176 probe STATUS  :", hex(this.#commandRead(0x71, 2)), "\n");
		const o1 = this.#commandRead(0xA2, 0x29);
		const o2 = this.#commandRead(0xA2, 0x89);
		trace("UC8176 probe OTP41   :", hex(o1.subarray(0, 0x18)), "bnd:", boundary(o1), "\n");
		trace("UC8176 probe OTP137  :", hex(o2.subarray(0, 0x18)), "bnd:", boundary(o2), "\n");
		// control: same clocks with the chip DESELECTED - its D1 is hi-Z, so the
		// pull-up alone should answer; anything but a clean FF field means the
		// pattern we keep seeing is not coming from the chip
		this.select.write(1);
		const idle = new Uint8Array(8).fill(0xFF);
		this.dc.write(1);
		this.spi.transfer(idle);
		trace("UC8176 probe IDLE-CShi:", hex(idle), "\n");
		// repeatability: real devices repeat, coupling depends on data sent
		const o3 = this.#commandRead(0xA2, 0x29);
		trace("UC8176 probe OTP41#2 :", hex(o3.subarray(0, 0x18)), "bnd:", boundary(o3), "\n");
	}
	probeOnce() {
		if (!this.#readProbe || this.#probed)
			return;
		this.#probed = true;				// once per boot, after the update has
		this.readoutProbe();				// left the chip powered and idle
	}
	isBusy() {
		return this.busy.read();
	}
	waitBusy(ms = 5_000) {
		ms += Date.now();
		do {
			if (!this.isBusy())
				return;
		} while (ms > Date.now());

		throw new Error("UC8176 BUSY timeout");
	}

	reset_() {
		if (this.#waitingPowerOn || this.#waitingDisplayDone || this.#waitingPowerOff) {
			this.#waitingPowerOn = false;
			this.#waitingDisplayDone = false;
			this.#waitingPowerOff = false;
			this.waitBusy();
		}

		this.reset.write(0);
		Timer.delay(10);
		this.reset.write(1);
		Timer.delay(5);
		// the chip reloads its OTP configuration after reset and holds BUSY low
		// while it does; commands issued before it releases are silently ignored.
		// 5 ms lets the pulse begin before we poll.
		this.waitBusy(1_000);
		this.#hibernating = false;
	}

	#initDisplay() {
		this.writeCMD(0x01);				// POWER_SETTING
		this.writeData(0x03);				// VDS_EN, VDG_EN internal
		this.writeData(0x00);				// VCOM_HV, VGHL_LV = 16V
		this.writeData(0x2b);				// VDH = 11V
		this.writeData(0x2b);				// VDL = 11V

		this.writeCMD(0x06);				// POWER_SOFT_START
		this.writeData(0x17);				// phase A
		this.writeData(0x17);				// phase B
		this.writeData(0x17);				// phase C

		this.writeCMD(0x00);				// PANEL_SETTING
		this.writeData(0x3f);				// 400x300, B/W mode, LUT from registers

		this.writeCMD(0x30);				// PLL_CONTROL
		// GROUND SHIFT (PLL decode, byte = M[5:3] N[2:0]): 0x3a is M7/N2 =
		// 100 Hz - the original comment was right; a mid-experiment "correction"
		// calling it 43 Hz was itself wrong, and its 0x72 = M6/N2 = 86 Hz is
		// SLOWER - which the panel then proved: writing 86 Hz lengthened full
		// DRF by ~210 ms and partial by ~100, exactly the 100/86 stretch. The
		// register frame clock is live at 400 kHz: OTP "ownership" of the clock
		// was another 10 MHz write-miss.
		// 100 Hz is the quality point, measured: at 200 Hz the partial waveform
		// (62 frames) lost too much voltage-time per phase - pale renders and
		// ghosting inherited from fulls. Across 86/100/200 Hz the model fits
		// to tens of ms: ~600 ms fixed overhead (plane stream at this SPI
		// clock), full ~160 frames, partial ~62. Faster-AND-clean is now a
		// tuning problem (scale LUT TP bytes with the clock), not a wall -
		// a knob this driver has never before possessed.
		this.writeData(0x3a);				// M7/N2 = 100 Hz

		this.writeCMD(0x61);				// RESOLUTION_SETTING
		this.writeData(0x01); this.writeData(0x90);	// 400
		this.writeData(0x01); this.writeData(0x2c);	// 300

		this.writeCMD(0x82);				// VCOM_DC_SETTING
		this.writeData(0x12);				// -1.0V (from OTP; slightly better than -0.5V)

		this.writeCMD(0x50);				// TCON_SETTING
		this.writeData(0xd7);				// border floating to avoid flashing
	}
	#writeLUT(vcom, ww, bw, wb, bb) {
		this.writeCMD(0x20); this.writeDataBuffer(vcom);
		this.writeCMD(0x21); this.writeDataBuffer(ww);
		this.writeCMD(0x22); this.writeDataBuffer(bw);
		this.writeCMD(0x23); this.writeDataBuffer(wb);
		this.writeCMD(0x24); this.writeDataBuffer(bb);
	}
	initFull(gray = false) {
		this.#mode = gray ? "gray" : "full";
		this.#grayPath = gray;
		this.reset_();
		this.#initDisplay();
		if (gray)
			this.#writeLUT(lut_vcom0_4g, lut_ww_4g, lut_bw_4g, lut_wb_4g, lut_bb_4g);
		else
			this.#writeLUT(lut_vcom0_full, lut_ww_full, lut_bw_full, lut_wb_full, lut_bb_full);
	}
	initPart() {
		this.#mode = "partial";
		this.#grayPath = false;
		this.reset_();
		this.#initDisplay();
		this.#writeLUT(lut_vcom0_partial, lut_ww_partial, lut_bw_partial, lut_wb_partial, lut_bb_partial);
	}

	// write both planes and refresh; synchronous when constructed without a
	// callback, otherwise power-on and refresh completions advance the state
	// machine in the busy callback
	display(oldFrame, newFrame, region) {
		this.#region = region;
		this.#t0 = Date.now();
		this.writeCMD(0x04);				// POWER_ON
		if (!this.#onDisplayReady) {
			Timer.delay(1);				// BUSY may not rise immediately
			this.waitBusy(2_000);
			this.#waitingFrames = [oldFrame, newFrame];
			this.#writeAndRefresh();
			Timer.delay(1);
			this.waitBusy(5_000);
			this.powerOff();
			trace("UC8176 timing: mode", this.#mode, "total", Date.now() - this.#t0, "ms\n");
			return;
		}

		this.#waitingFrames = [oldFrame, newFrame];
		this.#waitingPowerOn = true;
		// power-on completion handled in onReadable -> #writeAndRefresh
	}

	// partial update; asynchronous when constructed with onDisplayReady
	doPartial(oldFrame, newFrame, region) {
		this.initPart();
		this.display(oldFrame, newFrame, region);
	}

	powerOff() {
		this.writeCMD(0x02);				// POWER_OFF
		this.waitBusy(1_000);
	}
	deepSleep() {
		this.writeCMD(0x02);				// POWER_OFF
		this.waitBusy(1_000);
		Timer.delay(100);					// rail settling before deep sleep - Good Display
		this.writeCMD(0x07);				// DEEP_SLEEP_MODE	marks this delay as necessary
		this.writeData(0xa5);
		this.#hibernating = true;

		this.power?.write(1);				// if board switched, cut panel power
	}

	#writeAndRefresh() {
		const frames = this.#waitingFrames;
		this.#waitingFrames = undefined;
		const region = this.#region;
		this.#region = undefined;

		if (!this.#grayPath && region && (region.y0 > 0 || region.y1 < HEIGHT - 1)) {
			// PARTIAL_IN / PARTIAL_WINDOW over the dirty rows, rows-only plane
			// transfer, PARTIAL_OUT. VERDICT (tested at 400 kHz, honest clock):
			// the window trims the SPI transfer but the write cursor still
			// starts at RAM 0 (windowed rows for y0>0 land on the wrong gates,
			// corrupting other rows' SRAM) and the scan is not bounded (DRF
			// duration is frame-count only). This controller exposes no RAM
			// write-address command - the branch is inert behind
			// device.epd.bands=false and kept only so the next reader can
			// measure what we measured instead of rediscovering it
			this.writeCMD(0x91);
			this.writeCMD(0x90);
			this.writeData(0x00); this.writeData(0x00);			// x-start 0
			this.writeData(0x01); this.writeData(0x8f);			// x-end 399
			this.writeData((region.y0 >> 8) & 1); this.writeData(region.y0 & 0xFF);
			this.writeData((region.y1 >> 8) & 1); this.writeData(region.y1 & 0xFF);
			this.writeData(0x01);
			const a = region.y0 * STRIDE, b = (region.y1 + 1) * STRIDE;
			this.writeCMD(0x10);
			this.writeDataBuffer(frames[0].subarray(a, b));
			this.writeCMD(0x13);
			this.writeDataBuffer(frames[1].subarray(a, b));
			this.writeCMD(0x92);
			trace("UC8176 band: windowed rows", region.y0, "..", region.y1, "\n");
			region.commit?.();
			this.writeCMD(0x12);				// DISPLAY_REFRESH
			if (this.#onDisplayReady)
				this.#waitingDisplayDone = true;
			return;
		}
		// plain full-frame plane write, gray and BW alike: gray deliberately
		// skips the PARTIAL_WINDOW machinery (the reference warns grey_refresh
		// plus window "doesn't work correctly" - GxEPD2_420 displayWindow)
		this.writeCMD(0x10);					// DTM1 / OLD data (transition source)
		this.writeDataBuffer(frames[0]);
		this.writeCMD(0x13);					// DTM2 / NEW data
		this.writeDataBuffer(frames[1]);
		region?.commit?.();						// mirror merge once bytes are on the wire

		this.writeCMD(0x12);					// DISPLAY_REFRESH
		if (this.#onDisplayReady)
			this.#waitingDisplayDone = true;
	}
}

class Display {		// implementation of Poco PixelsOut
	#epd;
	#shown = new Uint8Array(FRAME_BYTES).fill(0xFF);	// what the panel is displaying
	#active = new Uint8Array(FRAME_BYTES).fill(0xFF);	// frame being drawn (0xFF is white)
	#dither = new Dither({width: WIDTH});
	#gray = false;
	#dataKind;
	#planeB = new Uint8Array(FRAME_BYTES);	// DTM2 for the level-encoded gray path
	#wantFull = true;					// next update is a full (de-ghosting) refresh
	// The first frame must be driven absolutely, not as a transition: the panel's
	// physical state at power-up is unknown (it keeps the last image forever, and
	// may be mid-convergence from a prior run). Writing the new frame to both
	// planes selects the 1->1 / 0->0 full-drive waveform for every pixel, so it
	// converges regardless of the prior state. Cleared by end() after one frame.
	#previous = true;
	#bands = false;		// provider knob device.epd.bands: windowed partial flushes
	#y0 = 0;
	#y1 = HEIGHT - 1;

	constructor(options = {}) {
		this.#bands = /^(1|true)$/i.test(String(globalThis.device?.epd?.bands ?? ""));
		if (options.onDisplayReady) {
			options = {
				...options,
				onDisplayReady: options.onDisplayReady.bind(this)
			};
		}
		this.#epd = new EPD(options);
	}
	close() {
		this.#planeB = undefined;
		if (this.#epd) {
			this.#epd.deepSleep();
			this.#epd.close();
			this.#epd = undefined;
		}

		this.#dither?.close?.();
		this.#dither = undefined;
		this.#shown = this.#active = undefined;
	}
	configure(options) {
		if (undefined !== options?.refresh)
			this.#wantFull = options.refresh;

		if (undefined !== options?.previous)
			this.#previous = options.previous;

		if (undefined !== options?.gray)
			this.#gray = !!options.gray;

		if (undefined !== options?.dither) {
			this.#dither.close();

			let algorithm = options.dither;
			if (false === algorithm)
				algorithm = "none";
			else if (true === algorithm)
				algorithm = "atkinson";		// default; must be a string - a present-but-undefined
										// algorithm slot is rejected as an invalid name
			this.#dither = new Dither({width: WIDTH, algorithm});
		}
	}

	begin(x, y, width, height) {
		// the flush region arrives as four scalars on ESP32 hosts and as a
		// single rectangle object on ECMA419-display-hook builds; parse both
		if (null !== x && "object" == typeof x) {
			const area = x;
			x = area.x, y = area.y;
			width = area.width ?? area.w;
			height = area.height ?? area.h;
		}
		let y0 = 0, y1 = HEIGHT - 1;
		if (this.#bands && undefined !== height) {
			y0 = Math.max(0, y | 0);
			y1 = Math.min(HEIGHT - 1, (y + height - 1) | 0);
			if (y1 < y0)
				y1 = y0;
		}
		this.#y0 = y0;
		this.#y1 = y1;
		this.#active.position = y0 * STRIDE;
		this.#dither.reset();
	}
	send(data, offset = 0, byteLength = data.byteLength) {
		// JS indexing needs a view over the bytes; native may hand a bare
		// ArrayBuffer (the C dither path never cared - xsmcGetBufferReadable
		// accepts any view over it). Build the view defensively for every
		// possibility and, once per boot, report what actually arrived so this
		// line can never again be a guess
		if (!this.#dataKind)
			this.#dataKind = true;	// native hands pixelsOut a buffer-like whose
										// constructor name reads undefined; the
										// defensive view below is the fix (the
										// probe trace earned its retirement)
		let view;
		if (ArrayBuffer.isView(data))
			view = (data instanceof Uint8Array) ? data : new Uint8Array(data.buffer, data.byteOffset ?? 0, byteLength);
		else if (data instanceof ArrayBuffer)
			view = new Uint8Array(data);
		else
			view = new Uint8Array(data?.buffer ?? data, data?.byteOffset ?? 0, byteLength);
		data = view;
		const buffer = this.#active;
		if (!this.#gray) {
			this.#dither.send(Math.idiv(byteLength, WIDTH), data, offset, buffer, buffer.position);
			buffer.position += byteLength >> 3;
			return;
		}
		// gray path: the production writeImage_4G grammar, read off the source
		// this time (and my earlier "two thresholds" reading was wrong):
		//   DTM1: white->1, black->0, v>=160 -> 1 (light), else 0
		//   DTM2: white->1, black->0, v>=160 -> 0 (light), else 1 (dark)
		// so the four pairs are white=(1,1), light=(1,0), dark=(0,1),
		// black=(0,0) - DTM2 is not a threshold of v, it is "dark or white".
		const rows = Math.idiv(byteLength, WIDTH);
		const planeB = this.#planeB;
		let from = offset,
			at = buffer.position;
		for (let line = 0; line < rows; line++) {
			for (let c = 0; c < STRIDE; c++) {
				let bitsA = 0, bitsB = 0;
				for (let bit = 0; bit < 8; bit++) {
					const v = data[from++];
					if (0 == v)
						;						// black: (0,0)
					else if (255 == v)
						{ bitsA |= 0x80 >> bit; bitsB |= 0x80 >> bit; }	// white: (1,1)
					else if (v >= 160)
						bitsA |= 0x80 >> bit;	// light gray: (1,0)
					else
						bitsB |= 0x80 >> bit;	// dark gray: (0,1)
				}
				buffer[at + c] = bitsA;
				planeB[at + c] = bitsB;
			}
			at += STRIDE;
		}
		buffer.position += byteLength >> 3;
	}
	end() {
		const epd = this.#epd;
		epd.probeOnce();
		// when the app asserts the panel already shows this frame (previous: true)
		// there is no transition reference; drive both planes with the new frame
		const oldFrame = this.#previous ? this.#active : this.#shown;

		// persistent buffers + commit merge, replacing the old ping-pong swap:
		// with region streaming, untouched rows of #active must retain the
		// last displayed content, which a swap cannot guarantee. The merge runs
		// inside the EPD once the plane bytes are on the wire (never earlier -
		// a too-early or no-op merge is how one era of this driver froze the
		// mirror and painted stale black forever)
		const shown = this.#shown, active = this.#active;
		const bandPass = this.#bands && !this.#gray && !this.#wantFull && !this.#previous;
		const y0 = bandPass ? this.#y0 : 0,
			y1 = bandPass ? this.#y1 : HEIGHT - 1;
		const a = y0 * STRIDE, b = (y1 + 1) * STRIDE;
		const commit = () => { shown.set(active.subarray(a, b), a); };
		const region = {y0, y1, commit};

		if (this.#gray) {
			// gray is the absolute level-pair refresh, always full-screen;
			// #active holds DTM1 (the thresholded view), so the same commit
			// leaves the BW mirror consistent for a later BW partial
			epd.initFull(true);
			epd.display(active, this.#planeB, region);
			this.#wantFull = false;
		}
		else if (this.#wantFull) {
			// full refresh: drives every pixel, clears ghosting, visibly flashes
			epd.initFull();
			this.#wantFull = false;
			epd.display(oldFrame, active, region);
		}
		else
			// partial refresh waveform; windowed when bandPass (the EPD checks
			// the region bounds and falls through to plain writes for a
			// full-screen region, so one path serves both)
			epd.doPartial(oldFrame, active, region);

		this.#previous = false;
	}
	continue() {
		return this.end();
	}
	adaptInvalid(area) {
		// bands: keep Piu's row strip, widened to full width (byte-aligned
		// rows); without them, native must stream the whole panel to match
		// begin()'s full-frame assumption
		if (!this.#bands) {
			area.y = 0;
			area.h = HEIGHT;
		}
		area.x = 0;
		area.w = WIDTH;
	}

	// SD apps borrow the panel driver's held rail pin (default OFF):
	//   screen.sdPower.write(0) + settle delay before SDCard construction,
	//   screen.sdPower.write(1) when done. Never claim device.pin.sdPower in a
	//   separate Digital - the driver owns it precisely so no app boots into a
	//   floating enable beside an inserted card
	get sdPower() {
		return this.#epd.sdPower;
	}
	get sdCS() {
		return this.#epd.sdSelect;
	}
	get width() {
		return WIDTH;
	}
	get height() {
		return HEIGHT;
	}
	get pixelFormat() {
		return Bitmap.Gray256;
	}
	get async() {
		return false;
	}
	pixelsToBytes(pixels) {
		return pixels;
	}

	// force a full (de-ghosting) refresh of the panel right now
	refresh() {
		const epd = this.#epd;

		epd.initFull();
		epd.display(this.#shown, this.#shown);
		this.#wantFull = false;
	}
}

export default Display;
