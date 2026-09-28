/*
 * Copyright (c) 2026  Moddable Tech, Inc.
 *
 *   This file is part of the Moddable SDK.
 * 
 *   This work is licensed under the
 *       Creative Commons Attribution 4.0 International License.
 *   To view a copy of this license, visit
 *       <http://creativecommons.org/licenses/by/4.0>.
 *   or send a letter to Creative Commons, PO Box 1866,
 *   Mountain View, CA 94042, USA.
 *
 */

// SPI clock sweep probe: one flash tests BOTH bus tenants at the
// provider's EPD_BUS_HZ. SD: init + read + (optional) write self-test.
// Panel: a gray ramp whose partial refresh duration is the LUT-latch
// canary - ~0.5-1 s means the register waveforms still latch at this
// clock; ~4 s means the OTP has taken over and the step below is the
// module's true write ceiling.

import Poco from "commodetto/Poco";
import parseBMF from "commodetto/parseBMF";
import Resource from "Resource";
import Timer from "timer";
import config from "mc/config";
import SDCard from "sdcard";

export default function () {
	const report = [];

	// --- SD at this clock ---
	screen.sdPower.write(0);			// borrow the panel driver's held rail
	Timer.delay(250);
	try {
		const card = new SDCard({cs: screen.sdCS});
		report.push(`SD OK ${(card.bytes / (1 << 30)).toFixed(1)} GB`);
		const b0 = new Uint8Array(512);
		card.readBlock(0, b0);
		report.push(`MBR ${0x55 == b0[510] && 0xAA == b0[511] ? "55AA" : "none"}`);
		if (config.writeTest)
		{
			const target = card.blocks - 16, original = new Uint8Array(512),
				pattern = new Uint8Array(512), check = new Uint8Array(512);
			card.readBlock(target, original);
			for (let i = 0; i < 512; i++)
				pattern[i] = (i * 37 + 11) & 0xFF;
			card.writeBlock(target, pattern);
			card.readBlock(target, check);
			let ok = true;
			for (let i = 0; i < 512; i++)
				if (check[i] != pattern[i])
					ok = false;
			card.writeBlock(target, original);
			card.readBlock(target, check);
			for (let i = 0; i < 512; i++)
				if (check[i] != original[i])
					ok = false;
			report.push(`WR ${ok ? "OK" : "FAIL"}`);
		}
		card.close();
	}
	catch (e)
	{
		report.push(`SD FAIL: ${String(e.message ?? e).slice(0, 60)}`);
	}
	screen.sdPower.write(1);			// hand it back parked

	// --- panel canary: gray boot frame, then partial BW updates time themselves ---
	const render = new Poco(screen, { displayListLength: 4096 });
	const font = parseBMF(new Resource("OpenSans-Regular-18.bf4"));
	function frame() {
		screen.configure({gray:true});
		render.begin();
			render.fillRectangle(render.makeColor(255,255,255), 0, 0, render.width, render.height);
			const levels = [0, 64, 128, 192, 255];
			const band = Math.idiv(render.height - 60, levels.length);
			levels.forEach((v, i) => render.fillRectangle(render.makeColor(v,v,v), 0, 30 + i*band, render.width, band));
			const status = report.join("  ");
			render.drawText(status, font, render.makeColor(0,0,0), 8, render.height - 16);
		render.end();
		screen.configure({gray:false});
	}
	frame();

	// every button: one BW partial (the canary measurement) at the current clock
	for (const name of ["One", "Two", "Three", "Four"]) {
		const button = new device.peripheral.button[name]({
			onPush: () => {
				if (!button.pressed)
					return;
				frame();						// re-rasterizes; the next update is partial
				screen.configure({refresh:false});
				render.begin();
					render.fillRectangle(render.makeColor(255,255,255), 0, 0, render.width, render.height);
					render.drawText("PARTIAL CANARY", font, render.makeColor(0,0,0), 8, 30);
					render.drawText(report.join("  "), font, render.makeColor(0,0,0), 8, render.height - 16);
				render.end();
			}
		});
	}
}
