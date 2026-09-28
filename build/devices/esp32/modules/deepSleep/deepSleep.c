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

#include "xsmc.h"

#include "esp_sleep.h"
#include "driver/gpio.h"

// Wake configurations return esp_err_t to JavaScript (ESP_OK == 0) so a
// rejected pin (not RTC-capable) is an exception in JS, not a silent no-op;
// esp_deep_sleep_start() never returns, so `now` has no result.

void xs_esp32_deepsleep_wake_pin(xsMachine *the)
{
	const gpio_num_t pin = (gpio_num_t)xsmcToInteger(xsArg(0));
	const int level = (xsmcArgc > 1) ? xsmcToInteger(xsArg(1)) : 0;
	xsmcSetInteger(xsResult, esp_sleep_enable_ext0_wakeup(pin, level));
}

void xs_esp32_deepsleep_wake_pins(xsMachine *the)
{
	const uint64_t mask = (uint64_t)xsmcToInteger(xsArg(0));
	// mode passed as a plain int, converted implicitly at the enum parameter:
	// the enum TYPE name varies across IDF versions (esp_ext1_wakeup_t in 4.x,
	// renamed in 5.x where this call is deprecated but present), while the
	// VALUE numbering is stable: DISABLE 0, ALL_LOW 1, ANY_LOW 2, ALL_HIGH 3,
	// ANY_HIGH 4. Only the function and the numbers are relied on.
	const int mode = xsmcToInteger(xsArg(1));
	xsmcSetInteger(xsResult, esp_sleep_enable_ext1_wakeup(mask, mode));
}

void xs_esp32_deepsleep_wake_timer(xsMachine *the)
{
	const uint32_t us = xsmcToUnsigned(xsArg(0));
	xsmcSetInteger(xsResult, esp_sleep_enable_timer_wakeup((uint64_t)us));
}

void xs_esp32_deepsleep_now(xsMachine *the)
{
	esp_deep_sleep_start();
	while (1)
		modDelayMilliseconds(1000);
}
