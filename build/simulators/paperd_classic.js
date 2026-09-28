import { Screen } from 'piu/Screen';

import {
  ControlsColumn,
  ButtonsRow,
  SliderRow,
  StatusRow,
  SwitchRow,
  TimerRow,
  InfoRow
} from 'ControlsPane';

import {
  DeviceBehavior,
  DeviceContainer,
  DeviceScreen,
  DeviceWorker,
} from 'DevicePane';

const base = import.meta.uri;

class MockupBehavior extends DeviceBehavior {
  onAbort(container, status) {
    if (this.reloadOnAbort) {
      application.defer('doReloadFile');
      return true;
    }
  }
  onCreate(container, device) {
    super.onCreate(container, device);
    this.reloadOnAbort = false;
  }

  onButton1Down(container) {
    this.postJSON(container, { button1: 1 });
  }
  onButton1Up(container) {
    this.postJSON(container, { button1: 0 });
  }
  onButton2Down(container) {
    this.postJSON(container, { button2: 1 });
  }
  onButton2Up(container) {
    this.postJSON(container, { button2: 0 });
  }
  onButton3Down(container) {
    this.postJSON(container, { button3: 1 });
  }
  onButton3Up(container) {
    this.postJSON(container, { button3: 0 });
  }
  onButton4Down(container) {
    this.postJSON(container, { button4: 1 });
  }
  onButton4Up(container) {
    this.postJSON(container, { button4: 0 });
  }

  onKeyDown(container, key) {
    const code = key.charCodeAt(0);
    if (code == 49 /* 1 */) this.onButton1Down(container);
    if (code == 50 /* 2 */) this.onButton2Down(container);
    if (code == 51 /* 3 */) this.onButton3Down(container);
    if (code == 52 /* 4 */) this.onButton4Down(container);
  }
  onKeyUp(container, key) {
    const code = key.charCodeAt(0);
    if (code == 49 /* 1 */) this.onButton1Up(container);
    if (code == 50 /* 2 */) this.onButton2Up(container);
    if (code == 51 /* 3 */) this.onButton3Up(container);
    if (code == 52 /* 4 */) this.onButton4Up(container);
  }
  onBatteryChanged(container, data) {
    this.postJSON(container, { battery: data.value / 100 });
  }
  onJSON(container, json) {
    if ('xsbug' in json) {
      if (json.xsbug == 'abort') application.defer('doReloadFile');
    } else if ('buzzer' in json) {
      const { hz } = json.buzzer;
      this.BUZZER_INFO.string = hz ? `${hz} Hz` : 'Off';
    }
  }
  onReloadOnAbortChanged(container, data) {
    this.reloadOnAbort = data.value;
  }
}

export default {
  applicationName: 'paperd_classic/debug/.*',
  title: 'paperd.ink classic',
  Workers: {},
  ControlsTemplate: ControlsColumn.template(($) => ({
    contents: [
      ButtonsRow({
        label: 'Buttons',
        buttons: [
          {
            eventDown: 'onButton1Down',
            eventUp: 'onButton1Up',
            label: '1',
          },
          {
            eventDown: 'onButton2Down',
            eventUp: 'onButton2Up',
            label: '2',
          },
          {
            eventDown: 'onButton3Down',
            eventUp: 'onButton3Up',
            label: '3',
          },
          {
            eventDown: 'onButton4Down',
            eventUp: 'onButton4Up',
            label: '4',
          },
        ],
      }),
      SliderRow({
        anchor: 'BATTERY_SLIDER',
        label: 'Battery',
        unit: '%',
        active: true,
        min: 0,
        max: 100,
        value: 100,
        step: 1,
        event: 'onBatteryChanged',
      }),
      InfoRow({
        name: 'BUZZER_INFO',
        label: 'Buzzer',
        value: 'Off',
      }),
      SwitchRow({
        event: 'onReloadOnAbortChanged',
        label: 'Reload On Abort',
        on: 'Yes',
        off: 'No',
        value: false,
      }),
    ],
  })),
  DeviceTemplates: {
    0: DeviceContainer.template(($) => ({
      Behavior: MockupBehavior,
      contents: [
        Content($, {
          skin: {
            texture: { base, path: 'paperd_classic/0.png' },
            x: 0,
            y: 0,
            width: 461,
            height: 391,
          },
        }),
        DeviceScreen($, {
          left: 15,
          width: 400,
          top: 70,
          height: 300,
          rotation: 0,
        }),
      ],
    })),
    90: DeviceContainer.template(($) => ({
      Behavior: MockupBehavior,
      contents: [
        Content($, {
          skin: {
            texture: { base, path: 'paperd_classic/90.png' },
            x: 0,
            y: 0,
            width: 391,
            height: 461,
          },
        }),
        DeviceScreen($, {
          left: 20,
          width: 300,
          top: 15,
          height: 400,
          rotation: 90,
        }),
      ],
    })),
    180: DeviceContainer.template(($) => ({
      Behavior: MockupBehavior,
      contents: [
        Content($, {
          skin: {
            texture: { base, path: 'paperd_classic/180.png' },
            x: 0,
            y: 0,
            width: 461,
            height: 391,
          },
        }),
        DeviceScreen($, {
          left: 45,
          width: 400,
          top: 20,
          height: 300,
          rotation: 180,
        }),
      ],
    })),
    270: DeviceContainer.template(($) => ({
      Behavior: MockupBehavior,
      contents: [
        Content($, {
          skin: {
            texture: { base, path: 'paperd_classic/270.png' },
            x: 0,
            y: 0,
            width: 391,
            height: 461,
          },
        }),
        DeviceScreen($, {
          left: 70,
          width: 300,
          top: 45,
          height: 400,
          rotation: 270,
        }),
      ],
    })),
  },
};
