// The plugin booted under the real shell against a fake HAROGIC analyzer.
//
// Shell, adapter, driver and socket, end to end, with nothing plugged in — so
// this runs on a laptop on a plane as well as it runs in the shop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlugin, SoundBasePlugin } from '@soundbase/plugin-shell';
import { startFakeHarogic } from '../driver/fake-harogic.js';
import {
  PRODUCT,
  createSpectrumAnalyzerAdapter,
  discoverDevices,
} from '../adapter.js';

const instrument = await startFakeHarogic();
const ADDRESS = `127.0.0.1:${instrument.port}`;
const DEVICE_ID = `net:${ADDRESS}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;

const UHF = { startHz: 470_000_000, stopHz: 608_000_000, pointCount: 4_000 };

// exactly what main.js does
class Plugin extends SoundBasePlugin {
  async discoverDevices() {
    return discoverDevices(this.config);
  }
  createSpectrumAnalyzerAdapter(device) {
    return createSpectrumAnalyzerAdapter(device, this.config);
  }
}

const handle = await runPlugin(Plugin, {
  manifestPath: new URL('../soundbase-plugin.json', import.meta.url),
  handleSignals: false,
});

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const configure = (patch) =>
  request('POST', `${DEVICE_PATH}/configuration`, patch);

// the host's first PUT /config brings the plugin up, and is where discovery
// gets its addresses from
await request('PUT', '/config', { values: { addresses: ADDRESS } });

test.after(async () => {
  await handle.close();
  await instrument.close();
});

test('discovery probes the configured addresses and names a stable device', async () => {
  const { body } = await request('GET', '/devices');
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  assert.ok(device, `no ${DEVICE_ID} in ${JSON.stringify(body.devices)}`);
  assert.equal(device.product, PRODUCT);
  assert.deepEqual(device.transport, {
    kind: 'network',
    host: '127.0.0.1',
    port: instrument.port,
  });
});

test('an address with nothing on it is an empty result, not an error', async () => {
  // port 1 on loopback refuses instantly: the common case for a user who
  // typed an address that is not an analyzer
  assert.deepEqual(await discoverDevices({ addresses: '127.0.0.1:1' }), []);
});

test('open() measures the unit tuning range instead of trusting *IDN?', async () => {
  await configure(UHF);
  const { body } = await request('GET', '/devices');
  const caps = body.devices.find((d) => d.id === DEVICE_ID).capabilities;

  // the fake clamps to 9 kHz - 4.5 GHz, so that is what the probe must find.
  // HAROGIC answers *IDN? with a literal "Hardware" in place of a model, so
  // nothing here could have been looked up from a table.
  assert.equal(caps.minFrequencyHz, 9_000);
  assert.equal(caps.maxFrequencyHz, 4_500_000_000);
  assert.equal(caps.minRefLevelDbm, -70);
  assert.equal(caps.maxRefLevelDbm, 23);
  // a menu of the bandwidths a coordinator reaches for, not a hardware limit
  assert.deepEqual(
    caps.rbwHz,
    [50_000, 100_000, 200_000, 500_000, 1_000_000]
  );
  assert.deepEqual(
    caps.controls.map((c) => c.id),
    [
      'refLevelDbm',
      'rbwMode',
      'vbwMode',
      'sweepDwell',
      'fftWindow',
      'spurRejection',
      'attenDb',
      'detector',
      'preamp',
    ]
  );
});

test('the probe leaves the span the user had, not the span it measured', async () => {
  assert.equal(instrument.state.startHz, UHF.startHz);
  assert.equal(instrument.state.stopHz, UHF.stopHz);
});

test('the instrument is left in a state the shell can accumulate from', async () => {
  // Clear/Write, because the shell holds max-hold itself at the full sweep
  // rate; equally spaced points, because the shell builds the frequency axis
  // from start, stop and count.
  assert.equal(instrument.state.traceType, 'WRIT');
  assert.equal(instrument.state.traceFormat, 0);
  assert.equal(instrument.state.mode, 'SWP');
});

test('out-of-range values come back clamped, and the request still succeeds', async () => {
  const { status, body } = await configure({
    startHz: 0,
    stopHz: 9_000_000_000,
    pointCount: 4_000,
  });
  assert.equal(status, 200);
  assert.equal(body.startHz, 9_000);
  assert.equal(body.stopHz, 4_500_000_000);
});

test('an absurd point count is clamped before it reaches the instrument', async () => {
  // A PXN-45 asked for a million points stops answering SCPI until it is
  // power-cycled. The adapter must never let that number out.
  const { status, body } = await configure({ ...UHF, pointCount: 1_000_000 });
  assert.equal(status, 200);
  assert.ok(
    body.pointCount <= 16_385,
    `point count reached ${body.pointCount}`
  );
  assert.ok(instrument.state.points <= 16_385);
});

test('RBW tracks the span when the host leaves it on auto', async () => {
  // One display point wide, so the same setting serves a 138 MHz UHF scan and
  // a 430 MHz survey without the user re-tuning the filter by hand.
  const narrow = await configure({ ...UHF, controls: { rbwMode: 'tracking' } });
  assert.equal(narrow.body.resolved.rbwHz, 34_500); // 138 MHz / 4000

  const wide = await configure({ ...UHF, stopHz: 900_000_000 });
  assert.equal(wide.body.resolved.rbwHz, 108_000); // 430 MHz / 4000, 3 s.f.
});

test("the analyzer's own RBW presets are offered too", async () => {
  await configure({ ...UHF, controls: { rbwMode: 'span1000' } });
  assert.ok(instrument.state.rbwAuto.startsWith('ONETHOU'));
  assert.equal(instrument.state.rbwHz, 138_000); // 138 MHz / 1000
});

// Ordered after the automatic modes on purpose: once the host has a resolution
// bandwidth in force it keeps sending it, so a typed RBW stays in force until
// the user puts the field back to auto. That is the behaviour we want, and it
// is also why this test cannot run before the ones above.
test('an RBW the user typed overrides the tracking mode', async () => {
  const { body } = await configure({ ...UHF, rbwHz: 30_000 });
  assert.equal(body.rbwHz, 30_000);
  assert.equal(instrument.state.rbwAuto, 'MANU');
  assert.equal(instrument.state.rbwHz, 30_000);
});

test('VBW follows RBW by the ratio the user picked', async () => {
  await configure({ ...UHF, rbwHz: 30_000, controls: { vbwMode: 'tenth' } });
  assert.equal(instrument.state.vbwHz, 3_000); // RBW / 10
});

test('reference level is applied and echoed', async () => {
  const { body } = await configure({
    ...UHF,
    controls: { refLevelDbm: -70 },
  });
  assert.equal(body.controls.refLevelDbm, -70);
  assert.equal(instrument.state.refLevelDbm, -70);

  // and clamped to what a PXN-45 accepts: the manual gives -70 to +23 dBm
  const tooLow = await configure({ ...UHF, controls: { refLevelDbm: -200 } });
  assert.equal(tooLow.body.controls.refLevelDbm, -70);
  assert.equal(instrument.state.refLevelDbm, -70);
});

test('the dwell multiplier slows the sweep and is reported', async () => {
  const fast = await configure({ ...UHF, controls: { sweepDwell: 'SWT' } });
  const slow = await configure({ ...UHF, controls: { sweepDwell: 'SWT20' } });
  assert.ok(
    slow.body.resolved.sweepTimeMs >= fast.body.resolved.sweepTimeMs * 15,
    `${fast.body.resolved.sweepTimeMs} -> ${slow.body.resolved.sweepTimeMs}`
  );
  assert.equal(instrument.state.dwell, 'SWT20');
});

test('window and spur rejection reach the instrument', async () => {
  const { body } = await configure({
    ...UHF,
    controls: { fftWindow: 'LOWS', spurRejection: 'HIGH' },
  });
  // The instrument holds the long spelling its own SCPI guide prints, and
  // answers queries with it; the host gets back the short id it asked with.
  assert.equal(instrument.state.fftWindow, 'LOWSideLobe');
  assert.equal(instrument.state.spurRejection, 'HIGH');
  assert.equal(body.controls.fftWindow, 'LOWS');
  assert.equal(body.controls.spurRejection, 'HIGH');
});

test('auto point count follows the span, and never the last sweep', async () => {
  // Driven against the adapter directly, not through the shell: once the host
  // has sent a pointCount the shell keeps sending it (only `rbwHz` has a way
  // to be cleared), so "auto" — the field absent — is a state reachable only
  // before one has ever been set. Through the shell this would be testing the
  // leftovers of whichever test ran first.
  const [device] = await discoverDevices({ addresses: ADDRESS });
  const adapter = createSpectrumAnalyzerAdapter(device, {});
  await adapter.open();

  const spacing = async (startHz, stopHz) => {
    const e = await adapter.applyConfig({ startHz, stopHz });
    return (e.stopHz - e.startHz) / e.pointCount;
  };

  try {
    // 40 MHz comes to 800 points by the rule, so the floor decides instead
    const narrow = await spacing(470e6, 510e6);
    assert.ok(narrow < 25_000, `narrow spacing was ${narrow} Hz`);

    // UHF: carriers a couple of hundred kHz wide, neighbours to tell apart
    const uhf = await spacing(470e6, 900e6);
    assert.ok(uhf > 45_000 && uhf < 55_000, `UHF spacing was ${uhf} Hz`);

    // above the cut: WiFi, DECT and wideband IEM, megahertz across
    const survey = await spacing(900e6, 2_400e6);
    assert.ok(
      survey > 90_000 && survey < 110_000,
      `survey spacing was ${survey} Hz`
    );

    // and back down. The bug this guards against: an instrument that answers
    // a request for 4000 points with 601 used to make 601 the new meaning of
    // auto, and it stayed 601 when a far wider span was opened next.
    const again = await spacing(470e6, 510e6);
    assert.ok(again < 25_000, `spacing after a wide sweep was ${again} Hz`);
  } finally {
    await adapter.close();
  }
});

test('a control the instrument will not take comes back as what it kept', async () => {
  // The failure this guards against is silent: a setting draws no reply, so
  // firmware that does not implement an option ignores the line and the host
  // would go on displaying a value that never reached the instrument.
  await configure({ ...UHF, controls: { fftWindow: 'LOWS' } });

  const { body } = await configure({
    ...UHF,
    controls: { fftWindow: 'NOSUCHWINDOW' },
  });

  assert.equal(
    instrument.state.fftWindow,
    'LOWSideLobe',
    'the instrument should have kept the window it had'
  );
  assert.equal(
    body.controls.fftWindow,
    'LOWS',
    'the host should be told what the instrument kept, not what was asked'
  );
});

test('the dwell multiplier is not confused with the plain multiplier', async () => {
  // "SWT" is a prefix of "SWT20". Matching the reply loosely would report
  // every multiplier as the fastest setting and look like a working control.
  const { body } = await configure({ ...UHF, controls: { sweepDwell: 'SWT20' } });
  assert.equal(body.controls.sweepDwell, 'SWT20');
  assert.equal(instrument.state.dwell, 'SWT20');
});

test('controls are merged by id and echoed as the device settled on them', async () => {
  const first = await configure({ controls: { detector: 'AVER' } });
  assert.equal(first.body.controls.detector, 'AVER');

  const second = await configure({ controls: { attenDb: '20' } });
  assert.equal(second.body.controls.attenDb, '20');
  assert.equal(
    second.body.controls.detector,
    'AVER',
    'the untouched control survived'
  );

  const auto = await configure({ controls: { attenDb: 'auto' } });
  assert.equal(auto.body.controls.attenDb, 'auto');
  assert.equal(instrument.state.attenDb, -1, 'auto is -1 on the wire');
});

test('pointCount is the length of a real trace, not the length asked for', async () => {
  // the fake settles on an odd number, as instruments tend to
  const { body } = await configure({ ...UHF, pointCount: 800 });
  assert.equal(body.pointCount, 801);
  assert.equal(instrument.state.points, 801);
});

test('sweeping produces traces whose geometry matches the effective config', async (t) => {
  const applied = await configure({
    ...UHF,
    pointCount: 1_000,
    controls: { attenDb: 'auto', detector: 'POS', sweepDwell: 'SWT' },
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const { status, body } = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(status, 200);
  assert.equal(body.pointCount, applied.body.pointCount);
  assert.equal(body.amplitudesDbm.length, applied.body.pointCount);
  assert.equal(body.startHz, applied.body.startHz);
  assert.ok(body.sweepId >= 1);

  // the fake's first carrier sits a third of the way across the span
  const bin = Math.round(applied.body.pointCount * 0.33);
  const carrier = Math.max(...body.amplitudesDbm.slice(bin - 4, bin + 4));
  assert.ok(carrier > -70, `carrier only reached ${carrier}`);
});

test('a transport that dies mid-sweep marks the device failed, not healthy', async () => {
  await configure({ ...UHF, pointCount: 1_000 });
  await request('POST', `${DEVICE_PATH}/sweep/start`);

  instrument.dropConnections();

  const deadline = Date.now() + 5_000;
  let status = null;
  while (Date.now() < deadline) {
    const { body } = await request('GET', '/devices');
    status = body.devices.find((d) => d.id === DEVICE_ID)?.status?.status;
    if (status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    status,
    'failed',
    'onFatal is what turns a dead socket into a device SoundBase reports as broken'
  );
});
