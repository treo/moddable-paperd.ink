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

import Poco from "commodetto/Poco";
import parseBMF from "commodetto/parseBMF";
import Resource from "Resource";

export default function () {
	const render = new Poco(screen, { displayListLength: 4096 });
	const black = render.makeColor(0, 0, 0);
	const font = parseBMF(new Resource("OpenSans-Regular-52.bf4"));
	const smallFont = parseBMF(new Resource("OpenSans-Regular-18.bf4"));

	// the four-level ladder plus the extremes; in gray mode the driver
	// quantizes this 8bpp ramp into the DTM1/DTM2 level pair (v >= 128 into
	// DTM1, v >= 64 into DTM2), and the 4G waveform resolves each of the four
	// pairs to its own pigment state. Turned off, the same ramp is dithered
	// by the host into two levels - the visible comparison this example is
	// for. Any button toggles; the toggle redraws and re-refreshes
	let gray = true;

	function draw() {
		screen.configure({gray});
		const white = render.makeColor(255, 255, 255);
		render.begin();
			render.fillRectangle(white, 0, 0, render.width, render.height);
			const levels = [0, 64, 128, 192, 255];
			const band = Math.idiv(render.height - 60, levels.length);
			levels.forEach((v, i) => {
				render.fillRectangle(render.makeColor(v, v, v), 0, 30 + i * band, render.width, band);
			});
			const mode = gray ? "4-gray (register 4G waveform)" : "1-bit (host dither)";
			const x = Math.idiv(render.width - render.getTextWidth(mode, smallFont), 2);
			render.drawText(mode, smallFont, gray ? white : black, x, render.height - 22);
		render.end();
	}

	draw();

	for (const name of ["One", "Two", "Three", "Four"]) {
		const button = new device.peripheral.button[name]({
			onPush: () => {
				if (!button.pressed)		// fire on press, not on release
					return;
				gray = !gray;
				draw();
			}
		});
	}
}
