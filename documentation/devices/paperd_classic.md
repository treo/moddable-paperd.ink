# paperd.ink classic Developer Guide
Copyright 2026 Moddable Tech, Inc.<BR>
Revised: September 29, 2026

This document provides information about using the [paperd.ink classic](https://docs.paperd.ink/docs/hardware/hardware/) with the Moddable SDK, including how to build and deploy apps and links to other development resources.

The paperd.ink classic is an ESP32-WROOM-32 board with a 4.2 inch 400 x 300 one-bit e-paper panel (Good Display GDEW042T2, UltraChip UC8176C controller), four buttons, a piezo buzzer, a microSD card slot, a PCF8574 I/O expander, and a LiPo battery circuit. All panel, SD, and battery sense circuitry is power-switched (active low) for very low sleep currents.

## Table of Contents

- [SDK and Host Environment Setup](#setup)
- [Building and Deploying Apps](#building-and-deploying-apps)
- [Simulator](#simulator)
- [Troubleshooting](#troubleshooting)
- [Development Resources](#development-resources)
	- [Port Status](#port-status)
	- [Display Driver](#display-driver)
		- [Update Modes](#update-modes)
		- [Four gray levels](#four-gray)
		- [Update Modes](#update-modes)
		- [Image Filters](#image-filters)
		- [Panel Power](#panel-power)
	- [Buttons](#buttons)
	- [Buzzer](#buzzer)
	- [Battery Voltage](#battery-voltage)
	- [Battery Powered Operation](#battery-powered-operation)
	- [Examples](#examples)
	- [Documentation](#documentation)

<a id="setup"></a>
## SDK and Host Environment Setup

To build and run apps on the paperd.ink classic, you'll need to:

1. Install the [Moddable SDK](./../Moddable%20SDK%20-%20Getting%20Started.md)
2. Install [ESP32 tools](./esp32.md)
3. Follow the instructions in the **Building and Deploying Apps** section below.

<a id="building-and-deploying-apps"></a>
## Building and Deploying Apps

After you've set up your host environment and ESP32 tools, take the following steps to install an application on your paperd.ink classic.

1. Attach the paperd.ink classic to your computer with a USB cable. The board uses a CP2104 USB-UART converter; the Moddable tools use the DTR/RTS lines to reset the module into programming mode automatically. If the board does not enter programming mode, hold the BOOT button while the ESP32 resets.

2. Build and deploy the app with `mcconfig`.

	`mcconfig` is the command line tool to build and launch Moddable apps on microcontrollers and the simulator. Full documentation of `mcconfig` is available [here](../tools/tools.md).

	Use the platform `-p esp32/paperd_classic` with `mcconfig` to build for the paperd.ink classic. For example, to build the [`paperd-hello` example](../../examples/drivers/paperd-hello):

	```text
	cd $MODDABLE/examples/drivers/paperd-hello
	mcconfig -d -m -p esp32/paperd_classic
	```

	The [examples readme](../../examples) contains additional information about other commonly used `mcconfig` arguments for screen rotation, Wi-Fi configuration, and more.

<a id="simulator"></a>
## Simulator

The Moddable simulator includes a paperd.ink classic skin, so apps can be developed and screenshotted without the hardware:

```text
cd $MODDABLE/examples/drivers/paperd-hello
mcconfig -d -m -p sim/paperd_classic
```

The simulated screen is the real 400 x 300 geometry, and the simulator applies the same Atkinson dithering and the same full-frame adaptation the hardware driver uses -- what you see in the simulator window is pixel-for-pixel what the panel will show (including the dither pattern). Keyboard `1`..`4` and the panel's Buttons controls drive the four hardware buttons; the Battery slider feeds `device.peripheral.battery`; the buzzer appears as a status readout (no sound).

What the simulator does not model is panel timing and behavior: refresh latency (about 1.5 s full, 0.6 s partial), the flash of a full update, and ghosting between images. Do not conclude from a clean simulator screen that an update frequency is kind to the panel, and keep an eye on the number of full refreshes.

<a id="troubleshooting"></a>
## Troubleshooting

See the Troubleshooting section of the [ESP32 documentation](./esp32.md) for a list of common issues and how to resolve them.

If the display does not update at all, confirm that the panel power pin (EPD_EN, GPIO12) is being asserted; the driver does this automatically when `device.pin.epdPower` is defined by the target provider.

<a id="development-resources"></a>
## Development Resources

<a id="port-status"></a>
### Port Status

The following are implemented and working:

- EPD display driver (UC8176C / GDEW042T2, 400 x 300)
- Four front buttons
- Piezo buzzer (tones)
- Battery voltage sensing
- Simulator skin (`-p sim/paperd_classic`) with matching dithered 1-bit display

Not yet provided by the target:

- microSD card (the pins are declared in the provider; the SD controller must be wired into a project manifest)
- PCF8574 I/O expander on the extension header

<a id="display-driver"></a>
### Display Driver

The display driver (`embedded:` module `uc8176`) is a [Poco `PixelsOut`](../commodetto/poco.md) implementation, so it can be used with both the [Poco](../commodetto/poco.md) graphics API and the [Piu](../piu/piu.md) user interface framework.

The driver is written entirely in JavaScript and uses the [ECMA-419 IO](https://419.ecma-international.org) APIs (`embedded:io/digital` and `embedded:io/spi`) for all hardware access.

The panel is 400 x 300 pixels at 1 bit per pixel. The controller holds two full-frame planes in its SRAM, "old" and "new" data; the refresh waveform is selected by the (old, new) pixel pair. The driver keeps both frames in host memory and rewrites both planes on every update, so partial updates are always driven from a known state. A set bit is a white pixel.

<a id="update-modes"></a>
#### Update Modes

One fact governs everything on this interface: **at too-fast SPI clock this
module silently misses register and waveform-table writes** (plane data
survives; configuration does not - which is how 10 MHz produced a long
detour where the panel appeared to "own" its OTP waveform and reject
everything downloaded). The target provider brokers one shared SPI
instance for the panel and the SD slot at **400 kHz** - re-swept with the SD
pins parked (the panel's own register writes are clean to 2 MHz), it is the SD
card's read path that binds the bus: 1 MHz desyncs card reads, 2 MHz silently
corrupts them. 400 kHz is where every measured pattern on both tenants is
green; it pays a ~600 ms plane-transfer tax for that, invisible inside the
refresh-dominated totals.

Measured durations at 400 kHz, PLL at its 100 Hz register value:

| update | duration | behavior |
|---|---|---|
| full (first frame, forced polish) | ~2.2 s | drives every pixel's transition, visibly flashes, clears ghosting |
| partial | ~1.24 s | drives only changed pixels: quiet, no flash, accumulates slow ghosting |
| gray (4 levels) | ~1.7 s | absolute four-level drive; always full-screen (see Four gray levels) |

About 600 ms of each total is the plane transfer; the refresh engine (~650 ms
of frames at 100 Hz) runs inside the remainder.

The first update after instantiation is full and driven absolutely (new frame
into both planes), so it converges whatever the glass held. Subsequent updates
are transitions from the driver's mirrored view of the panel; the driver writes
both planes every update and merges the flushed rows into its mirror, and the
`display.js` internals document why that mirror is load-bearing (a frozen
mirror silently froze every erase on the panel once - see the copyWithin note
in git history).

```js
screen.configure({refresh: true});	// next update: full (polish)
screen.configure({refresh: false});	// next update: partial (default after the first)
screen.configure({previous: true});	// assert the panel already shows what you draw first
```

Force a full refresh every handful of partials to re-converge pigment drift
(the manufacturer's own guidance: ~one full pass per five, with a pause).
Sub-rectangular *refreshes* are not possible on this controller, at any
clock: the `0x90` partial window trims the SPI transfer but does not position
the write cursor (windowed rows land at RAM row 0 and corrupt other rows'
SRAM) and does not bound the scan (refresh time is pure frame-count), and the
chip exposes no RAM write-address command to do it properly. Partials are
quiet, full-screen, ~1.24 s.

Poco and Piu queue draw commands into a fixed display list allocated with the
pixel buffer. Every glyph of every string is a command, and the list is
replayed on each draw. The default length is 1024 bytes; if a screen exceeds
that the device aborts with `display list overflow` - notably, the 64-bit
simulator inflates the requested length by 50% and renders in a single pass,
so an app can pass in the simulator and overflow on the panel. Size it
explicitly (`new Poco(screen, {displayListLength: 4096})`), and measure rather
than guess: `"defines": { "poco": { "log": true } }` logs the bytes and command
count per draw.

<a id="image-filters"></a>
#### Image Filters

To support dithering, the driver requires that Poco render at 8-bit gray (256 Gray); gray levels are converted to black and white pixels using the [commodetto Dither](../commodetto/dither.md) module. The default dithering algorithm is Atkinson. To change the algorithm, or to disable dithering:

```js
screen.configure({dither: "burkes"});
screen.configure({dither: false});
```

The driver maintains two full-frame buffers (15000 bytes each), which is required by the way the controller compares old and new data.

<a id="text-quality"></a>
#### Text quality on a 1 bpp panel

Anti-aliased fonts (BMF, Piu styles with AA) feed the dither gray pixels along glyph edges. Error-diffusion algorithms (Atkinson, Burkes) pass pure black and pure white through untouched, but diffuse the *edges* into the surrounding pixels -- on a panel at this pixel density that reads as speckle around text. If a screen is mostly text, threshold instead:

```js
screen.configure({dither: false});
```

Threshold (`none`) hard-quantizes the edges at 50%: solid stems, stepped curves, zero speckle. It is a per-frame choice, not a per-region one -- the whole frame is dithered in a single pass during the display's `end()` -- so a screen with both photographs and crisp text needs the text to contribute no gray at all. The standard way: pre-binarize the glyph masks at asset build time (render the font to a bitmap and convert to a 1-bit mask, e.g. with `png2bmp`) and draw them with `poco.drawMonochrome(bitmap, black, undefined, x, y)`; monochrome pixels never enter the error-diffusion path and stay sharp under a dithered photograph.

The simulator applies the same dither algorithm to the same framebuffer (and the same four-level quantization when `gray` is configured), so what the simulator window shows -- speckle or thresholded steps, including the exact dot pattern, or flat gray bands -- is what the panel will show.

<a id="four-gray"></a>
#### Four gray levels

Four-level gray works on this panel: register-downloaded 4G waveform tables
(byte-for-byte from GxEPD2's `GxEPD2_420`, validated against its
`writeImage_4G` conversion loops), a level-encoded plane pair, and - the
condition that hid this for an entire investigation - a bus slow enough for
the chip to hear (400 kHz; see Update Modes).

```js
screen.configure({gray: true});		// subsequent frames render four pigment levels
```

The 8-bit stream quantizes per the production grammar: `white -> (1,1)`,
`v >= 160 -> light (1,0)`, `0 < v < 160 -> dark (0,1)`, `black -> (0,0)`. Note
that this maps the entire mid-range to the dark level: a smooth ramp shows
stepped plateaus, which is four levels doing their job.

Three caveats are part of the contract:

- **Text blooms in gray.** Anti-aliased glyph edges all classify dark, giving
  letters dark halos at small sizes. Draw text with 1-bit monochrome masks
  (`drawMonochrome`) in gray frames, or accept the softness.
- **Gray never combines with the partial window.** The reference states it in
  its own commented code: `// else if (_refresh_mode == grey_refresh)
  _writeCommand(0x91); // doesn't work correctly`. Gray plane writes are plain
  full-screen `0x10`/`0x13`.
- **There is no partial gray waveform** - gray is the absolute refresh, and
  BW partials resume from the thresholded view the driver keeps as its mirror.

[`paperd-gray`](../../examples/drivers/paperd-gray) toggles gray and dithered
BW on every button press for the side-by-side comparison.

<a id="manufacturer-demo"></a>
#### The manufacturer's reference demos: null results, pending a retry at the honest clock

**Read this section as history with an asterisk.** Every observation in it was
made when the driver talked to the panel at 10 MHz - the same clock we later
learned silently drops this module's register writes. The raw traces (below,
kept verbatim because they are data) may be properties of the bus, not the
panel; the retry at 400 kHz is open work. The practices extracted from the
vendor code at the bottom of this section are unaffected.

Good Display's published Arduino demo for the GDEW042T2 (the `A32-GDEW042T2-F`
kit code: `EPD_init` / `EPD_init_Fast` / `PIC_display`) was replicated on this
board, command for command, at 10 MHz, and **the panel did not update** -- `0x12` holds
BUSY for a deterministic 8.08 s and draws nothing, with or without the forced
temperature trio (`0xE0`/`0xE5`/`0x82`, whose `E5 0x4B` theory was tested and is
dead: identical timing with and without it) and with or without adding the
`0x01` POWER_SETTING block the demo omits (it relies on the OTP command-default
region to pre-program power-on state). The demo works on Good Display's own EV
stock; the panels paperd.ink ships carry an OTP whose waveform configuration
does not produce analog drive through the paths that demo exercises. The
working configuration -- the one this SDK's driver uses -- is PSR `0x3f` with
the register waveform downloads, triple-reset not required, refreshing the full
panel in ~4.01 s (about 172 frames).

A second reference, Good Display's partial-refresh demo (`A-GDEW042T2-PF-210512`),
was also transcribed verbatim onto this board (again at 10 MHz) - tile geometry, mirrored-x window
arithmetic, the all-black `0x10` "claim" plane, the second PON (`EPD_init_data`)
immediately before `0x12`, the demo's full-panel prologue, grouped power
discipline, and the 32x32 call shape its code actually exercises. Every variant
returns a `0x12` that BUSY refuses to acknowledge: the refresh never starts (pin
stays idle, drive time collapses to ~10 ms, nothing renders). The demo's own
source comment says why: `//UC8151D` - it is written for the sibling controller
Good Display ships these panels with, whose partial-window data accounting
differs from the UC8176C on the paperd.ink board. Partial refresh via the vendor
recipes is unavailable on this controller revision, at the manufacturer's own
code.

Measured facts from this investigation worth keeping: BUSY must not be polled
for ~10 ms after issuing `0x12` (the vendor marks 200 us as a hard minimum);
a triple reset (3 x 10 ms pulse) is the vendor's guard against residual-charge
power-up failure; and `0x02` power-off wants ~100 ms of settling before `0x07`
deep sleep. All three are incorporated practice.

<a id="panel-power"></a>
#### Panel Power

On the paperd.ink classic the panel is powered through a MOSFET switch (EPD_EN, active low). The driver asserts the switch when instantiated and, if `close()` is called, powers the panel down after putting the controller into deep sleep. Apps do not need to manage the panel supply directly.

```js
screen.close();
```

<a id="deep-sleep"></a>
#### Deep Sleep

The panel holds its image with zero power, and the whole board -- panel, SD slot,
battery divider -- is rail-switched (active-low enables). A battery-aware app
therefore wants ESP32 deep sleep between refreshes: the image on the glass
persists through it, and waking is a full reboot.

The `deepSleep` module (included by the `paperd_classic` target manifest) wraps
the ESP-IDF wake configuration and PM2 sleep:

```js
import deepSleep from "deepSleep";

screen.close();		// panel power-off sequence + controller deep sleep + rail off
deepSleep({
	pins: [device.pin.button1, device.pin.button2, device.pin.button3, device.pin.button4],
	seconds: 3600,	// optional timer heartbeat, in addition to pin wake
});
```

Order matters, and the vendor's reference code is the authority: the panel
controller must be told to sleep (via `screen.close()`, which issues `0x02`,
waits BUSY, settles ~100 ms, then `0x07`+`0xA5`, and finally releases EPD_EN)
*before* its rail is cut -- SPI is the only way to ask, and after `0x07` the
controller ignores everything except a hardware reset.

Notes established against the hardware and Good Display / paperd.ink reference
code:

- Wake sources are RTC GPIOs only. All four buttons (GPIO 2, 4, 14, 27) qualify;
  `pins` uses ext1 (any-low), `pin` uses ext0. A rejected configuration throws
  rather than sleeping forever.
- A wake is a reboot. `import getResetReason from "resetReason"` (also included
  by the target) tells an app *why* it booted: `"Deep Sleep"` versus
  `"Power-On"`, `"External Pin"`, etc.
- Wake leaves the controller's SRAM blank (the rail was cut), while the glass
  keeps the old image. The driver's first update after boot drives the new frame
  into both planes, which converges the pixels it changes; pixels that should
  fade from black to white have no transition reference and may need one
  deliberate white frame first if the prior image was dark.
- paperd.ink's own documentation quotes ~1.4 mA deep-sleep current with button
  wake on this board -- noticeably above a bare ESP32-WROOM's ~10 uA; the board's
  peripheral circuitry (not the rails this SDK switches: EPD, SD, divider)
  accounts for the difference.
- Wake-on-button holds the pressed pin low; the ext1 wake configuration keeps
  the pad's pull-up during sleep, so the button release is not required before
  boot resumes.

The [`paperd-sleep`](../../examples/drivers/paperd-sleep) example demonstrates
the full cycle: it reports the reset reason and battery voltage on each boot,
hibernates on any button press, and wakes on button press or an hourly timer.

<a id="sd-card"></a>
#### SD Card

The microSD slot sits on the shared SPI bus (CS GPIO21) behind an active-low
power rail (SD_EN GPIO5). The `sdcard` module
([`modules/drivers/sdcard`](../../modules/drivers/sdcard/sdcard.js)) is a raw
block driver in SPI mode:

```js
import SDCard from "sdcard";

const Digital = device.io.Digital;
const power = new Digital({pin: device.pin.sdPower, mode: Digital.Output, initialValue: 0});
Timer.delay(50);						// rail settle before first SPI

const card = new SDCard();				// init at 200 kHz, data at 10 MHz
if (card.sdhc)
	debugger;							// SDHC/SDXC: block addressed
const block = new Uint8Array(512);
card.readBlock(0, block);				// throws RangeError past card.blocks
card.writeBlock(100, block);			// with the caveats below
card.close();
```

Know what this is and is not:

- **Raw blocks, no filesystem.** This SDK tree carries no FAT layer, so a card
  written through this driver must be *owned* by the application -- a log, a
  cache, a journal. Never write to a card that carries a filing system someone
  else might read; there is no coordination with partitions here.
- **The rail is the app's responsibility**, as the SD_EN GPIO is separate from
  the bus. Assert it (low) before construction; drop it (high) when done to
  save power. The [`paperd-sleep`](../../examples/drivers/paperd-sleep) example
  parks this rail before deep sleep.
- Init runs the SD v2 sequence (CMD0/CMD8/ACMD41-with-HCS/CMD58/CMD16/CMD9) and
  decodes capacity from the CSD for both versions; MMC cards and pre-v2 SDSC
  cards without the HCS handshake throw rather than half-initializing.
- **A card left in the slot while the panel refreshes needs its pins parked.**
  An SD card with supply switched off is *not* inert: the panel's own MOSI/SCLK
  traffic rectifies through the card's ESD diodes and pumps its VDD toward
  2.6 V - a phantom-powered card. If SPI chip-select is also floating (nobody
  claimed it), the zombie wakes selected, drives MISO and loads the shared
  lines, and partial refreshes gain severe ghosting. The panel driver therefore
  owns both SD pins at boot - rail off, CS deselected - and SD apps borrow them
  through `screen.sdPower` / `screen.sdCS` (see `SDCard({cs})`). This cost a
  full debugging arc to find; it is board physics, not driver folklore.
- The SPI bus is shared with the panel, and the sharing is structural: the
  target provider owns the single `embedded:io/spi` instance (the io layer
  claims pins per instance, so two drivers could not each construct one), and
  both drivers join it through `device.SPI.bus`. It runs at 400 kHz - the
  SD-init ceiling. Panel refresh time is BUSY-bound, so the slower plane
  transfer is invisible (~0.5 s absorbed inside the ~4 s refresh), and the
  card gets a spec-legal clock. Drivers never close the brokered bus.
- Writes honor the card's programming time: the driver waits for the card to
  release MISO (up to a second) instead of assuming a constant, and every
  command waits for the idle-high byte before starting, so back-to-back block
  traffic is safe.

The [`paperd-sd`](../../examples/drivers/paperd-sd) example reports capacity,
addressing mode, and block 0's boot signature. It is read-only by default;
`mcconfig ... writeTest=true` additionally runs a self-restoring write test on
one block near the card's end (read original, write pattern, verify, restore,
verify) -- the only firmware-visible write available without taking ownership
of the user's data, and it still asks explicitly because a power failure
mid-test costs that one block. Validated against three genuine cards (8/32/64
GB) decoding exact capacities over the byte- and block-addressed paths alike.
The simulator maps `sdcard` to an in-memory stub with the same API, so the app
code runs in `sim/paperd_classic` unchanged.

If metadata ever decodes to nonsense on a *genuine* card before these
validations, suspect the capture grammar first: this driver's history includes
a windowed response scan that ate the leading bytes of every data response,
which made two real SanDisk cards look like matching counterfeits -- one
single-frame capture per exchange (see the design notes atop `sdcard.js`) is
what the cards themselves taught the driver.

<a id="how-we-should-have-known"></a>
#### How we should have known: a postmortem in three limits

Everything this section documents about clocks and cards was - in hindsight -
knowable before the debugging it cost. Worth stating precisely, because the
general lesson hides inside the specific numbers:

**1. The panel's write ceiling is in its own datasheet, and we were sitting on
it.** `GDEW042T2` §3.3-2 specifies `tscycw` (SCLK cycle, write) minimum
**100 ns = 10 MHz**, `tscycr` (read) 150 ns, and data setup/hold of 30 ns.
A driver clocked at exactly 10 MHz was not violating the spec; it was
*completing* it - leaving two nanoseconds of margin against the 30 ns data
hold on a long flat flex with the SD slot branched onto the same traces. Datasheet
maxima are corners of the silicon, not the finished assembly; "works at the
limit on someone's EV board" is not a spec. Reading that table with paranoia
- "write at a quarter to half of 10 MHz" - skips an entire era of false
"the OTP ignores our waveforms" conclusions.

**2. The SD-parking practice was documented by example, not warning.** The
vendor's own library (see `paperdink` in the doc set) initializes
`EPD_EN/SD_EN/BATT_EN as outputs` in `begin()` and exposes
`enable_sd()/disable_sd()` - their software never leaves the slot's pins
floating, so a phantom-powered, self-selected zombie card simply cannot exist
in their world, and no warning was ever needed. Our examples diverged from
that practice silently, and rediscovered the physics the hard way: an unpowered
card whose CS floats wakes selected off the panel's own clocking (see the SD
Card section). Vendor code that *does* something is documentation that *says*
nothing - read their init sequences as design notes.

**3. The SD read limit was calculable, but appears in nobody's datasheet -
because it lives in the wiring.** MISO idles high through the ESP32's internal
~45 kOhm pull-up (the board has no documented external one, and notably the
panel's own AC table prices reads at 6.7 MHz for a line our driver never reads;
Good Display's reference demo polls the BUSY pin for status and never reads
MISO either - a suspicious amount of routing-around for a free feature).
45 kOhm x (20-40 pF of branched bus plus card input) is a ~1-2 us rising edge:
comfortable at 400 kHz (2.5 us bits), marginal at 1 MHz, silently corrupt at
2 MHz - which is exactly the measured sequence: clean, `read token 55` desync,
wrong-bytes-without-complaints. Recompute for your own wiring rather than
trusting our number: a 100 kOhm external pull-up on MISO near the slot would
buy roughly 2x the clock; a proper 10 kOhm buys everything up to SD's own
25 MHz SPI ceiling.

The meta-lesson this panel enforced three times: every measurement is taken
through a setup - a clock, a pin left floating, a pull-up nobody added - and
when the datasheet and the bench disagree, the setup is the suspect. Every
"impossible" in this document was a setup artifact.

<a id="buttons"></a>
### Buttons

The four buttons are numbered from top to bottom, and are available as `device.peripheral.button.One` through `device.peripheral.button.Four` (`Default` is the top button). All of the buttons are available with callbacks when changed. Here's a basic test that installs callbacks on each.

```js
for (let name in device.peripheral.button) {
	new device.peripheral.button[name]({
		onPush() {
			trace(`Button ${name}: ${this.pressed}\n`);
		}
	})
}
```

<a id="buzzer"></a>
### Buzzer

The piezo buzzer is implemented to play tones.

Instantiate the buzzer:

```js
const buzzer = new device.peripheral.tone.Default;
```

Play a tone by frequency:

```js
buzzer.tone(262);
```

Play a tone by frequency for a fixed duration in milliseconds:

```js
buzzer.tone(262, 500);
```

Mute the buzzer (it automatically unmutes on the next tone played):

```js
buzzer.mute();
```

Close the buzzer:

```js
buzzer.close();
```

<a id="battery-voltage"></a>
### Battery Voltage

To get the battery voltage, in millivolts:

```js
const battery = new device.peripheral.battery.Default;
const voltage = battery.read();
```

<a id="battery-powered-operation"></a>
### Battery Powered Operation

The paperd.ink classic saves power by switching off the panel, SD card, and battery sense circuits. The enable lines are active low. The target provider declares the pins; applications that want maximum battery life should power down the panel (`screen.close()`), and gate the battery enable (`device.pin.batteryEnable`) when not sampling.

For deep sleep between partial updates, close the screen and use `device.io.Digital` interrupts or the RTC alarm, then re-initialize on wake. The panel image is retained without power.

<a id="examples"></a>
### Examples

The Moddable SDK has over 150 [example apps](../../examples) that demonstrate how to use its many features. Many Poco and Piu examples that do not depend on touch will run on the paperd.ink classic. Note that the display refresh rate is roughly 1 full update every 1.5 seconds, so animation-heavy examples like `balls` are not a good fit.

The [`paperd-hello`](../../examples/drivers/paperd-hello) example draws a gray-scale swatch row and updates a counter when any of the four buttons is pressed; the press cycle walks the panel's three rendering modes - dithered 1-bit, thresholded 1-bit, and the native four-level gray (where the swatch row collapses to four flat, dither-free bands) - demonstrating full, partial, and gray refresh.

<a id="documentation"></a>
### Documentation

All the documentation for the Moddable SDK is in the [documentation](../) directory. The **documentation**, **examples**, and **modules** directories share a common structure to make it straightforward to locate information. Some of the highlights include:

- The `commodetto` subdirectory, which contains resources related to Commodetto--a bitmap graphics library that provides a 2D graphics API--and Poco, a lightweight rendering engine.
- The `piu` subdirectory, which contains resources related to Piu, a user interface framework that makes it easier to create complex, responsive layouts.
- The `networking` subdirectory, which contains networking resources related to BLE, network sockets, and a variety of standard, secure networking protocols built on sockets including HTTP/HTTPS, WebSockets, DNS, SNTP, and telnet.
- The `pins` subdirectory, which contains resources related to supported hardware protocols (digital, analog, PWM, I2C, etc.). A number of drivers for common off-the-shelf sensors and corresponding example apps are also available.
