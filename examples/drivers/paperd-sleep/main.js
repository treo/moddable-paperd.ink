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
import deepSleep from "deepSleep";
import getResetReason from "resetReason";

export default function () {
	const render = new Poco(screen, { displayListLength: 4096 });
	const white = render.makeColor(255, 255, 255);
	const black = render.makeColor(0, 0, 0);
	const font = parseBMF(new Resource("OpenSans-Regular-52.bf4"));
	const smallFont = parseBMF(new Resource("OpenSans-Regular-18.bf4"));

	// why did this boot happen? after a deep sleep the ESP32 reboots from
	// scratch; the reset-reason register is the only evidence of the sleep
	const reason = getResetReason().string;

	// battery reading needs the sense divider rail ON; it is switched off
	// again before sleeping (the divider would otherwise bleed the pack
	// through the whole sleep)
	const battery = new device.peripheral.battery.Default();
	const millivolts = battery.read();
	battery.close();

	const lines = [
		"paperd.ink classic",
		`Wake: ${reason}`,
		`Battery: ${millivolts} mV`,
		"Press any button to hibernate.",
		"Wakes on a button press, or every hour.",
	];

	render.begin();
		render.fillRectangle(white, 0, 0, render.width, render.height);
		let y = 60;
		for (const line of lines) {
			const f = y < 200 ? font : smallFont;
			const x = Math.idiv(render.width - render.getTextWidth(line, f), 2);
			render.drawText(line, y < 200 ? font : smallFont, black, x, y);
			y += (y < 200 ? 80 : 40);
		}
	render.end();

	function hibernate() {
		// the panel keeps its image with no power at all: hibernate it
		// (controller deep sleep + panel rail off, done by the driver's
		// close()), cut the remaining switched rails, and sleep the ESP32.
		//
		// ordering matters: rails cut AFTER the panel has run its power-off
		// sequence (0x02 settles, then 0x07 deep sleep), so the controller
		// is told to sleep while it can still hear SPI.
		screen.close();

		// SD slot and battery divider rails: drive their active-low enables
		// high (off). Held instances keep the drives alive to the end of
		// the program - there is no end of the program here, only a sleep.
		// the panel driver already holds the SD rail parked; only the battery
		// divider rail is ours to cut
		const Digital = device.io.Digital;
		new Digital({pin: device.pin.batteryEnable, mode: Digital.Output, initialValue: 1});

		deepSleep({
			pins: [device.pin.button1, device.pin.button2, device.pin.button3, device.pin.button4],
			seconds: 3600,				// heartbeat wake, one hour
		});
	}

	for (const name of ["One", "Two", "Three", "Four"]) {
		const button = new device.peripheral.button[name]({
			onPush: () => {
				if (button.pressed)		// fire on press, not on release
					hibernate();
			}
		});
	}
}
