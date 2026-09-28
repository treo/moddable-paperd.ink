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
import Timer from "timer";
import SDCard from "sdcard";
import config from "mc/config";

export default function () {
	const render = new Poco(screen, { displayListLength: 8192 });
	const white = render.makeColor(255, 255, 255);
	const black = render.makeColor(0, 0, 0);
	const font = parseBMF(new Resource("OpenSans-Regular-18.bf4"));

	function report(lines) {
		render.begin();
			render.fillRectangle(white, 0, 0, render.width, render.height);
			let y = 30;
			for (const line of lines) {
				render.drawText(line, font, black, 12, y);
				y += 28;
			}
		render.end();
	}

	// the slot is on a switched rail (active low); assert it and give the
	// card time to stabilize before speaking SPI
	screen.sdPower.write(0);			// borrow the panel driver's held rail
	Timer.delay(250);		// generous: the card sees its rail through a MOSFET

	// wrap a long diagnostic (the init failure log is the diagnosis) to the
	// panel width and to the trace channel, so xsdb sees it verbatim even
	// when the glass cannot
	function show(text)
	{
		trace("SD: ", text, "\n");
		const words = String(text).split(/\s+/);
		const out = [];
		let line = "";
		for (const w of words)
		{
			if (line.length + w.length + 1 > 30)
				out.push(line), line = w;
			else
				line = line.length ? line + " " + w : w;
		}
		if (line.length)
			out.push(line);
		return out;
	}

	// read-only demonstration: this app touches nothing it might destroy.
	// The raw block API (writeBlock) is for cards OWNED by an app - this SDK
	// has no FAT layer, so a card shared with a filing system must never be
	// written through this driver.
	let card;
	try {
		card = new SDCard({cs: screen.sdCS});
		const bytes = card.bytes;
		const size = bytes > (1 << 30) ? `${(bytes / (1 << 30)).toFixed(1)} GB`
			: bytes > (1 << 20) ? `${(bytes / (1 << 20)).toFixed(0)} MB`
			: `${bytes} B`;
		const block0 = new Uint8Array(512);
		card.readBlock(0, block0);
		const hex = Array.from(block0.subarray(440, 446)).map(b => b.toString(16).padStart(2, "0")).join(" ");
		let verdict = "Read-only demo: nothing was written.";

		// opt-in write self-test (mcconfig ... writeTest=true): exercises
		// writeBlock WITHOUT taking ownership of the user's card - reads the
		// target block, writes a known pattern, verifies, restores the
		// original bytes, and verifies the restore. One block near the card's
		// end (partitions rarely reach the last tracks). A power failure
		// mid-test costs this one block of their filesystem; that is the
		// entire risk, hence the explicit opt-in.
		if (config.writeTest)
		{
			const target = card.blocks - 16;
			const original = new Uint8Array(512);
			const pattern = new Uint8Array(512);
			const check = new Uint8Array(512);
			card.readBlock(target, original);
			for (let i = 0; i < 512; i++)
				pattern[i] = (i * 37 + 11) & 0xFF;
			card.writeBlock(target, pattern);
			card.readBlock(target, check);
			let wrote = true;
			for (let i = 0; i < 512; i++)
				if (check[i] != pattern[i])
				{
					wrote = false;
					break;
				}
			card.writeBlock(target, original);			// restore
			card.readBlock(target, check);
			let restored = true;
			for (let i = 0; i < 512; i++)
				if (check[i] != original[i])
				{
					restored = false;
					break;
				}
			verdict = `write test: ${wrote ? "OK" : "FAILED"}, restore: ${restored ? "OK" : "FAILED"}`;
		}
		const bootid = 0x55 == block0[510] && 0xAA == block0[511] ? "partitioned (55AA)" : "no boot signature";
		report([
			"SD card: OK",
			`${size}, ${card.sdhc ? "SDHC/SDXC (block-addressed)" : "SDSC (byte-addressed)"}`,
			`block 0: ${bootid}`,
			`disk id bytes: ${hex}`,
			"",
			verdict,
		]);
	}
	catch (e) {
		const message = String(e.message ?? e);
		// narrow, short lines: a wide/long diagnostic overflowed the display
			// list once already, and a failing report must never throw - fall
			// back to the bare fact
		try {
			report(["SD card: none / not readable", ""]
				.concat(show(message).slice(0, 5))
				.concat(["Re-seat the card and reboot."]));
		}
		catch (_) {
			report(["SD card: none", "(diagnostic too long)"]);
		}
	}

	// leave the rail on so the display result is stable; a battery app would
	// close the card and drive sdPower high when done - see paperd-sleep,
	// which already parks this rail before deep sleep
}
