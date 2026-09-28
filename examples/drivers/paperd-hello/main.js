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

const greetings = ["paperd.ink", "Hello, world!", "UC8176C", "e-paper", "1 bpp panel"];

export default function () {
	// The display list must hold this frame's draw commands - every glyph of
	// every string is one command (measured here: ~59 commands / ~2.6 KB). The
	// 1024-byte default overflows on the device; the 64-bit simulator quietly
	// inflates it by 50% and gets away with it. Size explicitly; see
	// documentation/devices/paperd_classic.md for measuring with poco log.
	const render = new Poco(screen, { displayListLength: 4096 });
	const white = render.makeColor(255, 255, 255);
	const black = render.makeColor(0, 0, 0);
	const font = parseBMF(new Resource("OpenSans-Regular-52.bf4"));
	const smallFont = parseBMF(new Resource("OpenSans-Regular-18.bf4"));

	let pressed = 0;

	// The press cycle walks the panel's three rendering modes: dithered 1-bit,
	// thresholded 1-bit, and the controller's native four-level gray. The gray
	// phase is the one a dithered panel cannot imitate: the swatch row carries
	// eight gray levels, and the driver's quantizer collapses them to exactly
	// four flat, dither-free bands.
	function draw() {
		const phase = pressed % 3;
		// Text on a 1bpp panel: atkinson and burkes pass pure black and pure
		// white through untouched, but error-diffuse the anti-aliased gray edge
		// pixels of a BMF font -- which reads as speckle. false selects the
		// threshold algorithm: solid glyphs with hard-stepped curves. Error
		// diffusion remains the right choice for continuous-tone photographs.
		// In the gray phase dither is moot: the panel itself has four levels.
		screen.configure({gray: 2 === phase, dither: 0 === phase});

		const message = 2 === phase ? "four gray levels" : greetings[pressed % greetings.length];
		const count = `Button presses: ${pressed}`;
		const hint = 2 === phase ? "native 4G waveform - press for dithered BW"
			: 0 === phase ? "dithered edges - press to threshold"
			: "thresholded edges - press for true gray";

		render.begin();
			render.fillRectangle(white, 0, 0, render.width, render.height);

			// a row of gray swatches -- eight levels, rendered by the active
			// mode: dithered or thresholded through 1-bit in the BW phases,
			// quantized to the panel's four real levels in the gray phase
			const swatchWidth = render.width >> 3;
			for (let i = 0; i < 8; i++) {
				const g = 255 - (i << 5);
				render.fillRectangle(render.makeColor(g, g, g), i * swatchWidth, 0, swatchWidth, 20);
			}

			let x = Math.idiv(render.width - render.getTextWidth(message, font), 2);
			let y = Math.idiv(render.height, 3);
			render.drawText(message, font, black, x, y);

			x = Math.idiv(render.width - render.getTextWidth(count, smallFont), 2);
			y += 90;
			render.drawText(count, smallFont, black, x, y);

			x = Math.idiv(render.width - render.getTextWidth(hint, smallFont), 2);
			y += 40;
			render.drawText(hint, smallFont, black, x, y);
		render.end();
	}

	draw();

	// any of the four buttons triggers a partial update
	const buttons = [];
	for (const name of ["One", "Two", "Three", "Four"]) {
		const button = new device.peripheral.button[name]({
			onPush: () => {
				if (!button.pressed)		// fire on press, not on release
					return;
				pressed += 1;
				// periodic full refresh clears the ghosting that partial updates
				// accumulate over many transitions; the gray phase is an
				// absolute full-panel refresh by construction, so it polishes
				// (and polishes the panel) on its own
				if (2 !== (pressed % 3) && 0 === (pressed % 5))
					screen.configure({refresh: true});
				draw();
			}
		});
		buttons.push(button);
	}
}
