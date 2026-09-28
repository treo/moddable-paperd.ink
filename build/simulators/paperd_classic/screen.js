/*
	Runs as a setup module in the mcsim host: replaces the global `screen`
	object with one that emulates what the panel shows on hardware.

	The paperd.ink classic panel is 1 bit per pixel; the uc8176 driver dithers
	the 256 Gray Poco/Piu framebuffer down to black and white, and adapts every
	invalidation to the full screen (partial-region dithering shows seams).
	This emulator applies the same dither and the same full-frame adaptation,
	so the simulator shows exactly the pixels the panel will show - including
	the dither pattern itself.

	The timing side of the panel (multi-second refresh, flashing, ghosting) is
	not simulated.
*/

import Dither from "commodetto/Dither";

const WIDTH = 400;
const HEIGHT = 300;
const FRAME_BYTES = (WIDTH * HEIGHT) >> 3;

let real;

class ScreenEmulator {
	#dither;
	#gray = false;
	#mono = new Uint8Array(FRAME_BYTES);
	#buf = new ArrayBuffer(WIDTH);
	#row = new Uint8Array(this.#buf);

	constructor() {
		this.#dither = new Dither({ width: WIDTH });
	}
	configure(options) {
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
			this.#dither = new Dither({ width: WIDTH, algorithm });
		}
		// refresh, previous, and mode are hardware waveform controls; no-ops here
	}

	begin(...args) {
		this.#dither.reset();
		return real.begin(...args);
	}
	send(data, offset = 0, byteLength = data.byteLength) {
		const lines = Math.idiv(byteLength, WIDTH);
		if (this.#gray) {
			// the driver's gray contract: quantize to four levels with no
			// dithering. The host panel is Gray256, so the simulator can show
			// the same four flat levels the glass will show.
			const row = this.#row;
			// the host may hand us a buffer-like that JS-indexes as undefined
			// (same trap as the driver's plane path) - normalize to a view
			const src = data instanceof Uint8Array ? data : new Uint8Array(data);
			let o = offset;
			for (let line = 0; line < lines; line++, o += WIDTH) {
				for (let c = 0; c < WIDTH; c++) {
					const v = src[o + c];
					row[c] = v >= 212 ? 255 : v >= 127 ? 170 : v >= 42 ? 85 : 0;
				}
				real.send(this.#buf, 0, WIDTH);
			}
			return;
		}

		const mono = this.#mono;
		const row = this.#row;
		this.#dither.send(lines, data, offset, mono, 0);

		// dithered bits are written top-to-bottom; within a row, eight pixels
		// per byte, set bit is white
		let m = 0;
		for (let line = 0; line < lines; line++) {
			for (let c = 0; c < (WIDTH >> 3); c++) {
				const bits = mono[m++];
				const o = c << 3;
				row[o] = bits & 0x80 ? 255 : 0;
				row[o + 1] = bits & 0x40 ? 255 : 0;
				row[o + 2] = bits & 0x20 ? 255 : 0;
				row[o + 3] = bits & 0x10 ? 255 : 0;
				row[o + 4] = bits & 0x08 ? 255 : 0;
				row[o + 5] = bits & 0x04 ? 255 : 0;
				row[o + 6] = bits & 0x02 ? 255 : 0;
				row[o + 7] = bits & 0x01 ? 255 : 0;
			}
			real.send(this.#buf, 0, WIDTH);
		}
	}
	end() {
		return real.end();
	}
	continue() {
		return real.continue();
	}
	adaptInvalid(area) {
		area.x = 0;
		area.y = 0;
		area.w = WIDTH;
		area.h = HEIGHT;
	}

	// no-ops that keep device lifecycle code running in the simulator
	get sdPower() { return {write(v) {}}; }
	get sdCS() { return {write(v) {}}; }
	refresh() {}
	close() {}

	get width() {
		return WIDTH;
	}
	get height() {
		return HEIGHT;
	}
	get pixelFormat() {
		return real.pixelFormat;
	}
	get async() {
		return false;
	}
	pixelsToBytes(count) {
		return real.pixelsToBytes(count);
	}

	// message and input plumbing, delegated to the host screen
	get context() { return real.context; }
	set context(value) { real.context = value; }
	// the host's idle pump reads globalThis.screen.when (set by the native
	// start/stop on the real screen); without delegating it, Piu's idle-draw
	// loop never runs against this emulator
	get when() { return real.when; }
	set when(value) { real.when = value; }
	get onMessage() { return real.onMessage; }
	set onMessage(value) { real.onMessage = value; }
	get focus() { return real.focus; }
	set focus(value) { real.focus = value; }
	get rotation() { return real.rotation; }
	set rotation(value) { real.rotation = value; }
	get hole() { return real.hole; }
	set hole(value) { real.hole = value; }
	get transparency() { return real.transparency; }
	set transparency(value) { real.transparency = value; }
	postMessage(message) { return real.postMessage(message); }
	start(idle) { return real.start(idle); }
	stop() { return real.stop(); }
	readLED() { return real.readLED(); }
	writeLED(value) { return real.writeLED(value); }
}

export default function (done) {
	real = globalThis.screen;
	globalThis.screen = new ScreenEmulator();
	done();
}
