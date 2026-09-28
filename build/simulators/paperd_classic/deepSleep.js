/*
	Simulator stub of the ESP32-only deepSleep module: wake configuration is
	recorded and sleep() prints what would happen. Lets the same app code run
	in the simulator; e-paper image retention across sleep needs no simulation
	because the simulator panel is the framebuffer.
*/

export function wakeOnPin(pin, level = 0) {
	trace("deepSleep(sim): ext0 wake pin", pin, "level", level, "\n");
	return 0;
}
export function wakeOnPins(mask, mode) {
	trace("deepSleep(sim): ext1 wake mask 0x", mask.toString(16), "mode", mode, "\n");
	return 0;
}
export function wakeOnTimer(microseconds) {
	trace("deepSleep(sim): timer wake", microseconds, "us\n");
	return 0;
}
export function enter() {
	trace("deepSleep(sim): would enter deep sleep\n");
}

const ANY_LOW = 2;

export default function deepSleep(options = {}) {
	if (options.pins) {
		let mask = 0;
		for (const pin of options.pins)
			mask |= (1 << pin);
		wakeOnPins(mask, undefined !== options.mode ? options.mode : ANY_LOW);
	}
	else if (undefined !== options.pin)
		wakeOnPin(options.pin, undefined !== options.level ? options.level : 0);

	if (undefined !== options.seconds)
		wakeOnTimer(Math.round(options.seconds * 1_000_000));

	enter();
}
