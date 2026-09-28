/*
 * Copyright (c) 2026  Moddable Tech, Inc.
 *
 *   This file is part of the Moddable SDK Runtime.
 *
 *   The Moddable SDK Runtime is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU Lesser General Public License as published by
 *   the Free Software Foundation, either version 2 of the License, or
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

// ESP32 deep sleep (PM2): RTC slow memory and the ULNA coprocessor survive;
// everything else is a full reboot on wake. Wake sources are configured
// before entering: a single RTC GPIO (ext0), any combination of RTC GPIOs
// (ext1), and/or a timer. All four paperd.ink buttons (GPIO 2, 4, 14, 27)
// are RTC-capable. On wake the reset-reason register reads "Deep Sleep",
// which is how an app tells a wake from a cold start.

export function wakeOnPin(pin, level = 0) @ "xs_esp32_deepsleep_wake_pin";
export function wakeOnPins(mask, mode) @ "xs_esp32_deepsleep_wake_pins";
export function wakeOnTimer(microseconds) @ "xs_esp32_deepsleep_wake_timer";
export function enter() @ "xs_esp32_deepsleep_now";

// esp_ext1_wakeup_t in ESP-IDF 4.x: DISABLE 0, ALL_LOW 1, ANY_LOW 2,
// ALL_HIGH 3, ANY_HIGH 4
const ANY_LOW = 2;

export default function deepSleep(options = {}) {
	if (options.pins) {
		let mask = 0;
		for (const pin of options.pins)
			mask |= (1 << pin);
		if (0 != wakeOnPins(mask, undefined !== options.mode ? options.mode : ANY_LOW))
			throw new Error("deepSleep: ext1 wake rejected (every pin must be RTC-capable)");
	}
	else if (undefined !== options.pin) {
		if (0 != wakeOnPin(options.pin, undefined !== options.level ? options.level : 0))
			throw new Error("deepSleep: ext0 wake rejected (pin must be RTC-capable)");
	}

	if (undefined !== options.seconds) {
		if (0 != wakeOnTimer(Math.round(options.seconds * 1_000_000)))
			throw new Error("deepSleep: timer wake rejected");
	}

	enter();
}
