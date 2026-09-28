import Control from 'control';

export class Battery extends Control {
  #battery;

  constructor(options) {
    super(options);
    this.#battery = 1.0;
    this.postJSON({
      battery: this.#battery,
    });
  }
  read() {
    return this.#battery;
  }
  onJSON(json) {
    if ('battery' in json) {
      this.#battery = json.battery;
    }
  }
}
