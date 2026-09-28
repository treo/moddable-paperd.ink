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
	SPI-mode MMC/SD card driver for Moddable, written against embedded:io SPI
	full-duplex transfer(). Raw 512-byte block access only: this SDK tree has
	no FAT layer, so a card addressed through this module should be entirely
	owned by the application - not shared with a filing system.

	Design rules, each purchased with hardware transcripts:
	- Command AND response in one continuous SPI frame (6 + window bytes;
	  data commands use #dataCommand's command+status+token+payload single
	  capture). Byte-at-a-time transaction stitching by the master desyncs
	  the card's bit counters, and a windowed scan followed by a SECOND poll
	  for the data token silently eats the leading payload bytes - two genuine
	  cards then "looked identically counterfeit". One capture, parse in place.
	- After ACMD41 answers 0, the card drives MISO LOW through t_init (<=1 s).
	  #afterActivation releases CS and clocks until the line returns high;
	  every later 0x00 read as "status" means this step was skipped.
	- ACMD41 is tried HCS-first, then plain, then MMC CMD1; CMD8's echo is
	  evidence, never a verdict (real v2 cards skip it). Retries de-assert CS.
	- The MISO idle-level probe at init start distinguishes electrical faults
	  from protocol ones in one byte.
	- Writes bound the card's programming time instead of assuming it; reads
	  verify the FE token before trusting data.

	The paperd.ink classic wires the slot to the shared VSPI bus behind an
	active-low power rail (assert it and settle ~250 ms before constructing);
	on that board the provider brokers the single bus instance at 400 kHz, the
	SD-init spec ceiling - see device.SPI.bus. Simulator: sim/paperd_classic
	maps "sdcard" to an in-memory stub with the same API.

	Validated on device against three genuine cards (8/32/64 GB, correct
	capacity decode, MBR reads, SDSC byte- and SDHC block-addressed paths).
*/


import Timer from "timer";

const BLOCK = 512;

function crc7(bytes)
{
	let crc = 0;
	for (const byte of bytes)
	{
		for (let i = 7; i >= 0; i--)
		{
			const feedback = ((crc >> 6) ^ ((byte >> i) & 1)) & 1;
			crc = (crc << 1) & 0x7F;
			if (feedback)
				crc ^= 0x09;
		}
	}
	return (crc << 1) | 1;		// 7-bit CRC with stop bit, as transmitted
}

export default class SDCard
{
	#spi;
	#cs;
	#blocks = false;			// block-addressed (SDHC/SDXC)
	#totalBlocks = 0;
	#frame = new Uint8Array(6 + 12);	// command bytes + response window
	#bigFrame;						// command + status + token + data, one capture
	#resp = null;				// captured response bytes from the last burst
	#respAt = 6;				// window offset where #resp began
	#one = new Uint8Array(1);
	#fill = new Uint8Array(8).fill(0xFF);
	#writeBuf = new Uint8Array(3 + BLOCK);	// token + data + two dummy CRC
	#log = [];

	#shared = false;		// true when the bus is brokered (options.spi or device.SPI.bus)
	#ownCs = true;			// false when CS is borrowed (options.cs)

	constructor(options = {})
	{
		// options.cs: a Digital already owned elsewhere - on paperd.ink classic
		// the panel driver parks SD_CS deselected at boot (a floating CS lets a
		// phantom-powered card wake selected and drive MISO), so the card driver
		// borrows that instance rather than claiming the pin and colliding
		if (options.cs) {
			this.#cs = options.cs;
			this.#ownCs = false;
		}
		else {
			const Digital = device.io.Digital;
			this.#cs = new Digital({
				pin: options.pin ?? device.pin.sdSelect,
				mode: Digital.Output,
				initialValue: 1
			});
		}
		const shared = options.spi ?? device.SPI?.bus;
		if (shared) {
			// provider-brokered bus (paperd.ink classic): panel and card are
			// wired to the same VSPI signals and the io SPI pins are
			// per-instance claims, so the provider owns the one instance - we
			// must neither reopen nor close it. Its clock must be SD-init safe
			// (<=400 kHz).
			this.#spi = shared;
			this.#shared = true;
		}
		else
			this.#openSPI(options.initHz ?? 200_000);
		this.#init();
		if (!this.#shared)
			this.#openSPI(options.hz ?? 10_000_000);
	}
	close()
	{
		if (!this.#shared)
			this.#spi?.close();
		this.#spi = undefined;
		if (this.#ownCs)
			this.#cs?.close();
		this.#cs = undefined;
	}
	get blocks()
	{
		return this.#totalBlocks;
	}
	get bytes()
	{
		return this.#totalBlocks * BLOCK;
	}
	get sdhc()
	{
		return this.#blocks;
	}

	#openSPI(hz)
	{
		if (this.#shared)
			throw new Error("SD: cannot reclock a brokered bus");
		this.#spi?.close();
		this.#spi = new device.io.SPI({
			...device.SPI.default,
			hz,
			mode: 0
		});
	}

	#byte()
	{
		this.#one[0] = 0xFF;
		this.#spi.transfer(this.#one);
		return this.#one[0];
	}
	// Command and response in ONE uninterrupted clock burst: frame = 6 command
	// bytes + a 12-byte response window, transferred together, and the captured
	// MISO stream is scanned for the first byte with bit7 clear. Byte-at-a-time
	// response polling (what this driver did first) inserts SCK gaps between
	// one-byte transactions; cards count NAC in bit clocks, and three different
	// cards were measured answering CMD8 with 0x7F and ACMD41 with 0x3F - the
	// signatures of 0x01 and 0x00 sampled one bit late - then going silent under
	// the poll storm. The burst is how every robust SPI SD driver works.
	#command(index, argument, extra = 0)
	{
		const f = this.#frame;
		const bytes = [0x40 | index,
			(argument >>> 24) & 0xFF, (argument >>> 16) & 0xFF, (argument >>> 8) & 0xFF, argument & 0xFF];
		f[0] = bytes[0]; f[1] = bytes[1]; f[2] = bytes[2]; f[3] = bytes[3]; f[4] = bytes[4];
		f[5] = crc7(bytes);
		for (let i = 6; i < f.length; i++)
			f[i] = 0xFF;
		this.#spi.transfer(f);
		this.#respAt = 6;
		for (let k = 6; k <= f.length - 1 - extra; k++) {
			if (!(f[k] & 0x80)) {
				this.#resp = f.slice(k, k + 1 + extra);	// copy: frame is reused
				this.#respAt = k;
				return f[k];
			}
		}
		return 0xFF;					// no response inside the window
	}
	// wait for the card to hold MISO high (0xFF) = ready to receive a command.
	// A card finishing a write program pulls it low; reading 0xFF means idle.
	#waitIdle(ms)
	{
		const deadline = Date.now() + ms;
		while (Date.now() < deadline)
			if (0xFF == this.#byte())
				return true;
		return false;
	}
	#address(block)
	{
		return this.#blocks ? block : block * BLOCK;
	}

	#init()
	{
		this.#log = [];
		this.#cs.write(1);
		this.#spi.write(this.#fill);			// >=80 clocks before chip select

		// electrical self-check: with nobody selected and (per modules/io/spi/
		// esp/spi.c) the pad pull-up active, MISO must idle HIGH; a read of
		// 0x00 means the line is floating - the pull-up is absent in this
		// build or on this pad - which is exactly the failure that made every
		// delayed response tail read as zero. Distinguish the two worlds
		// before speaking protocol at all.
		const probe = new Uint8Array(4).fill(0xFF);
		this.#spi.transfer(probe);
		if (0x00 == probe[0] && 0x00 == probe[1] && 0x00 == probe[2] && 0x00 == probe[3])
			throw new Error("MISO idles LOW - SPI MISO pull-up missing (see modules/io/spi/esp/spi.c)");

		this.#cs.write(0);
		try {
			this.#spi.write(this.#one.fill(0xFF));	// one clock with CS low
			const r0 = this.#cmd(0, 0);
			if (1 != r0)
				throw new Error("SD: CMD0 answered " + r0 + " [" + this.#log.join(" ") + "]");

			// SD v2 requires a CMD8 status of 1 AND the 0x1AA check-bit echo.
			// Real cards exist that answer CMD8 with status but a zero tail
			// (echo unimplemented) - the Arduino SD library's policy is to
			// treat echo failure as "not proven v2" and run the legacy
			// activation, where a true v2 card still answers ACMD41+HCS. So a
			// missing echo routes to legacy; it is no longer fatal.
			let v2 = false;
			const r7 = this.#cmd(8, 0x1AA, 4);
			if (1 == r7)
			{
				let o = 0;
				for (let i = 1; i < this.#resp.length; i++)
					o = (o << 8) | this.#resp[i];
				this.#log.push("R7:" + o.toString(16));
				v2 = (o & 0xFFF) == 0x1AA;
			}
			if (v2)
			{
				if (!this.#activate(0x40000000))
					throw new Error("SD: ACMD41 never activated [" + this.#log.join(" ") + "]");
				this.#afterActivation();
				this.#cmd(58, 0, 4);
				const ocr = this.#readOCR();
				this.#blocks = 0 != (ocr & 0x40000000);
				this.#log.push("OCR:" + ocr.toString(16));
			}
			else
			{
				// Anything other than a clean R7 answer means "CMD8 not
				// understood" - which includes cards that are v2-capable but
				// answered 0x7F/0x80/none. Identity is decided by what
				// ACTIVATE, not by what CMD8 refused. Measured on this card:
				// CMD55 -> 1 (accepts app commands) and ACMD41-without-HCS ->
				// 0x3F forever, so the HCS form goes FIRST here: it activates
				// v2-era cards whose CMD8 echo went wrong; plain ACMD41 second
				// for true v1; MMC's CMD1 last.
				this.#log.push("legacy(" + r7 + ")");
				if (this.#activate(0x40000000) || this.#activate(0))
				{
					this.#afterActivation();
					this.#cmd(58, 0, 4);
					const ocr = this.#readOCR();
					this.#blocks = 0 != (ocr & 0x40000000);
					this.#log.push("OCR:" + ocr.toString(16));
				}
				else
				{
					this.#mmc();				// MMC CMD1 (throws on timeout)
					this.#blocks = false;
				}
				this.#cmd(16, BLOCK);			// 512-byte blocks
			}

			// CMD9: SEND_CSD - status, token, 16 data bytes in one capture
			const csdR = this.#dataCommand(9, 0, 16);
			this.#log.push("C9:" + csdR.status + " tk:" + csdR.token.toString(16));
			const csd = new Uint8Array(BLOCK);
			csd.set(csdR.data);
			this.#logBytes("CSD0-15", csd.subarray(0, 16));
			this.#totalBlocks = this.#decodeCSD(csd, this.#blocks);
			if (!(this.#totalBlocks > 0 && this.#totalBlocks < 128 * 1024 * 1024))
			{
				// CSD fiction: capture the CID before dying - real CIDs carry an
				// ASCII product name; a fabricated capacity page usually comes
				// with one that is equally uninformative, and either answer ends
				// the guessing about what this card is
				this.#log.push("blocks:" + this.#totalBlocks);
				this.#readCID();
				throw new Error("SD: CSD decode implausible (" + this.#totalBlocks + ") [" + this.#log.join(" ") + "]");
			}
		}
		finally {
			this.#cs.write(1);
			this.#byte();							// one more clock after deselect
		}
	}
	// One capture for command, status, token, and data. The previous shape -
	// scan a window, THEN poll for the data token - let the scan consume the
	// leading payload bytes: two GENUINE cards showed near-identical "garbage"
	// metadata because both were sliced at the same offset by our own window,
	// while block-0 read true (its long NCR placed the token beyond the
	// window). A single frame, everything parsed from it, cannot cannibalize
	// itself. 540 bytes sits inside the platform's 1024 transaction size.
	#dataCommand(index, argument, dataLength)
	{
		const f = this.#bigFrame ??= new Uint8Array(6 + 16 + 2 + 512 + 8);
		const bytes = [0x40 | index,
			(argument >>> 24) & 0xFF, (argument >>> 16) & 0xFF, (argument >>> 8) & 0xFF, argument & 0xFF];
		f[0] = bytes[0]; f[1] = bytes[1]; f[2] = bytes[2]; f[3] = bytes[3]; f[4] = bytes[4];
		f[5] = crc7(bytes);
		for (let i = 6; i < f.length; i++)
			f[i] = 0xFF;
		this.#spi.transfer(f);
		let k = 6;
		for (; k < f.length; k++)
			if (!(f[k] & 0x80))
				break;
		const status = k < f.length ? f[k] : 0xFF;
		let m = k + 1;
		for (; m < f.length && (0xFF == f[m] || 0x00 == f[m]); m++)
			;
		// a frame that runs out before any token byte means "no data response
		// came" - report it as idle (0xFF) rather than undefined: diagnostics
		// must never crash while reporting (measured at the failed 10 MHz bus
		// experiment: r.token.toString threw inside the throw statement)
		const token = m < f.length ? f[m] : 0xFF;
		return {status, token, data: f.subarray(m + 1, m + 1 + dataLength)};
	}
	#readCID()
	{
		const r = this.#dataCommand(10, 0, 16);
		this.#log.push("C10:" + r.status + " tk:" + r.token.toString(16));
		this.#logBytes("CID", r.data);
		this.#log.push("CIDtxt:" + String.fromCodePoint(...Array.from(r.data, v => 32 > v || v > 126 ? 0x2E : v)));
	}
	#cmd(index, argument)
	{
		const r1 = this.#command(index, argument);
		if (this.#log.length < 240)
			this.#log.push("C" + index + ":" + r1);
		return r1;
	}
	#ocrFromFrame(f, k)	// OCR word starting at window position k
	{
		let v = 0;
		for (let i = k; i < k + 4; i++)
			v = (v << 8) | f[i];
		return v >>> 0;
	}
	#readOCR()
	{
		// Measured RAW58: ff 00 c0 ff 80 00 - this card starts CMD58's R3 data
		// at the FIRST window byte (no status byte in front: the 0xff is the
		// idle before the burst scan... and the 00 begins the OCR). Accept both
		// grammars: OCR at k+1 (spec: status then OCR) or at k; validate the
		// shape with the voltage-range bits, never trust a zero over a read.
		const f = this.#frame, k = this.#respAt;
		let ocr = 0;
		for (let i = 1; i < this.#resp.length; i++)
			ocr = (ocr << 8) | this.#resp[i];
		if (ocr & 0xC0FF0000)
			return ocr >>> 0;
		const alt1 = this.#ocrFromFrame(f, k + 1);
		if (alt1 & 0xC0FF0000)
			return alt1;
		const alt0 = this.#ocrFromFrame(f, k);
		if (alt0 & 0xC0FF0000)
			return alt0;
		return ocr >>> 0;
	}
	// SdFat's retry discipline, not the naive back-to-back loop: a card that
	// answers ACMD41 with an error flag byte (measured here: 0x3F, then total
	// 0xFF silence - a confused or rail-sagged card) needs CS cycled and time
	// given between attempts. Toggling CS releases the card's command sequencer
	// (t_cs-off >= 8 clocks); the pause lets an inrush-sagged rail recover
	// before the next charge-pump request.
	#activate(arg)
	{
		const start = Date.now();
		let attempts = 0;
		for (;;) {
			this.#cmd(55, 0);						// CMD55: APP_CMD
			if (0 == this.#cmd(41, arg, 4))			// ACMD41 answers R3 (status + OCR)
				return true;
			this.#deselect();						// CS high + clocks
			Timer.delay(20);
			this.#cs.write(0);
			this.#byte();							// one clock with CS low again
			if (Date.now() - start > 2_000 || ++attempts >= 40)
				return false;
		}
	}
	// After ACMD41 answers 0, the card runs internal initialization for up to
	// t_init (1 s) and signals it by DRIVING MISO LOW (confirmed here: with the
	// pull-up verified present by the idle:ff probe, every "0x00" captured
	// after activation is the card holding the line, not a float). Commands
	// issued during t_init get no response, so everything downstream decoded
	// as zero-status/zero-OCR/zero-token. Clock patiently until the line goes
	// high again before speaking further.
	#afterActivation()
	{
		this.#deselect();						// release CS; card drives busy
		const ok = this.#waitIdle(2_000);		// clock with CS high until MISO high
		this.#log.push(ok ? "init-done" : "init-wait-timeout");
		this.#cs.write(0);
		this.#byte();							// re-sync clock with CS low
	}
	#deselect()
	{
		this.#cs.write(1);
		this.#byte();
		this.#byte();
	}
	#mmc()
	{
		const start = Date.now();
		for (;;) {
			if (0 == this.#cmd(1, 0))				// CMD1: MMC activation
				return;
			this.#deselect();
			Timer.delay(20);
			this.#cs.write(0);
			this.#byte();
			if (Date.now() - start > 2_000)
				throw new Error("SD: no SD v1/MMC activation [" + this.#log.join(" ") + "]");
		}
	}
	// Capacity from the CSD. CSD version 2 (SDHC/SDXC) puts a 22-bit C_SIZE at
	// byte offsets 7 (low 6 bits), 8, 9; version 1 uses c_size/c_size_mult/
	// bl_len spread wider. The structure bits in csd[0][7:6] normally pick the
	// layout - but a byte-shifted data read (missing token eaten as csd[0])
	// moves both the structure tag and the fields, so when the OCR already
	// proved SDHC, decode v2 at either alignment and keep the reading that
	// looks like a real card: v2 sizes are enormous (>32 GB-ish in blocks), a
	// misaligned read yields a small or zero number.
	#decodeCSD(csd, forcedV2)
	{
		const v2Blocks = (o7, o8, o9) => ((((csd[o7] & 0x3F) << 16) | (csd[o8] << 8) | csd[o9]) + 1) * 1024;
		if (forcedV2 || 1 == ((csd[0] >> 6) & 3))
		{
			const aligned = v2Blocks(7, 8, 9);
			if (aligned >= 0x800000)					// >=4 GiB in 512B blocks: true SDHC decode
				return aligned;
			return v2Blocks(6, 7, 8);					// shifted-by-one read
		}
		const c_size = ((csd[6] & 0x03) << 10) | (csd[7] << 2) | ((csd[8] >> 6) & 0x03);
		const c_size_mult = ((csd[9] & 0x03) << 1) | ((csd[10] >> 7) & 0x01);
		const bl_len = csd[5] & 0x0F;
		return Math.pow(2, c_size_mult + bl_len - 9) * (c_size + 1);
	}
	// one-time helper while the CSD grammar is still being pinned down: dump a
	// byte window of the raw response at a chosen offset into the log
	#logBytes(name, bytes)
	{
		if (this.#log.length < 240)
			this.#log.push(name + ":" + Array.from(bytes, v => v.toString(16).padStart(2, "0")).join(" "));
	}
	readBlock(block, buffer, offset = 0)
	{
		if (block >= this.#totalBlocks)
			throw new RangeError("SD: block beyond card capacity");
		this.#cs.write(0);
		try {
			this.#waitIdle(1_000);
			const r = this.#dataCommand(17, this.#address(block), BLOCK);
			if (0xFE != r.token)
				throw new Error("SD: read token " + r.token.toString(16) + " status " + r.status);
			buffer.set(r.data, offset);
		}
		finally {
			this.#cs.write(1);
			this.#byte();
		}
	}
	writeBlock(block, buffer, offset = 0)
	{
		if (block >= this.#totalBlocks)
			throw new RangeError("SD: block beyond card capacity");
		const buf = this.#writeBuf;
		buf[0] = 0xFE;								// data token
		buf.set(buffer.subarray(offset, offset + BLOCK), 1);
		buf[BLOCK + 1] = 0xFF; buf[BLOCK + 2] = 0xFF;	// dummy CRC (card ignores it)
		this.#cs.write(0);
		try {
			this.#waitIdle(1_000);
			const r1 = this.#command(24, this.#address(block));
			if (0 != (r1 & 0xC0))
				throw new Error("SD: write command rejected");
			this.#spi.write(buf);
			const response = this.#byte();
			if (0x05 != (response & 0x1F))
				throw new Error("SD: write data rejected");
			// programming: card holds MISO low until done (bounded, not assumed)
			const deadline = Date.now() + 1_000;
			while (Date.now() < deadline)
				if (0xFF == this.#byte())
					break;
		}
		finally {
			this.#cs.write(1);
			this.#byte();
		}
	}
}
