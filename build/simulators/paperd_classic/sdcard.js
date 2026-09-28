/*
	Simulator stub of the SPI SDCard driver: the same API backed by memory so
	app code builds and runs unchanged in sim/paperd_classic. Not persistent -
	blocks vanish with the process. Capacity reports as a plausible 2 GB SDHC.
*/
const BLOCK = 512;

export default class SDCard
{
	#mem = new Uint8Array(4096 * BLOCK);
	constructor(options = {}) {}
	close() { this.#mem = undefined; }
	get blocks() { return this.#mem.length / BLOCK; }
	get bytes() { return this.#mem.length; }
	get sdhc() { return true; }
	readBlock(block, buffer, offset = 0)
	{
		const a = block * BLOCK;
		buffer.set(this.#mem.subarray(a, a + BLOCK), offset);
	}
	writeBlock(block, buffer, offset = 0)
	{
		const a = block * BLOCK;
		this.#mem.set(buffer.subarray(offset, offset + BLOCK), a);
	}
}
