// ModoRF — HAROGIC spectrum analyzers for SoundBase.
//
// Talks SCPI over TCP to the SCPI service built into SAStudio4. On a handheld
// PXN the software runs on the instrument itself, so the address is the
// analyzer's own IP; on a rack SA/NX driven from a PC it is that PC's address.
// Either way it is the host running SAStudio4, and SCPI has to be switched on
// there under System > SCPI.
//
// The wire protocol lives in driver/harogic-scpi.js. This file is only about
// the SoundBase contract.

import { HarogicClient, probe } from './driver/harogic-scpi.js';

export const PRODUCT = 'plugin:modorf-harogic/px-series';

const DEFAULT_PORT = 5025;
const DEFAULT_SWEEP_INTERVAL_MS = 50;

// Used only when measuring the unit's real range fails. The narrowest HAROGIC
// span, so a fallback never invites the user past what the hardware can do.
const FALLBACK_MIN_HZ = 9_000;
const FALLBACK_MAX_HZ = 4_500_000_000;

// Where the probe pushes to find the ends of the range.
const PROBE_LOW_HZ = 0;
const PROBE_HIGH_HZ = 1e13;

const DEFAULT_START_HZ = 470_000_000;
const DEFAULT_STOP_HZ = 616_000_000;
const FALLBACK_POINTS = 4_000;

// A PXN-45 asked for a million points stops answering SCPI at all and has to
// be power-cycled; its own default is 4000. This ceiling is far above anything
// a sweep needs (at 16k points a 2 GHz span is 120 kHz per point) and far
// below what wedges the instrument. Clamping here means neither a typo in the
// host's field nor a badly behaved caller can take the analyzer down mid-show.
const MAX_POINTS = 16_384;
const MIN_POINTS = 2;

// The instrument's own limits, from the PXN product manual.
const MIN_BW_HZ = 0.1;
const MAX_BW_HZ = 10_000_000;
const MIN_REF_LEVEL_DBM = -70;
const MAX_REF_LEVEL_DBM = 23;

// RBW on these instruments is continuous from 0.1 Hz to 10 MHz, so this list
// is not a hardware limit — it is the 1-2-5 ladder a live-event coordinator
// actually reaches for, offered as a menu because picking 100 kHz from a list
// beats typing 100000 between songs. Anything on it is sent through verbatim;
// leaving the host's field on auto hands the choice to the rbwMode control,
// which can and does resolve to values between these rungs.
const RBW_CHOICES_HZ = [50_000, 100_000, 200_000, 500_000, 1_000_000];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** three significant figures — the hardware is continuous, people are not */
const tidy = (v) => Number(v.toPrecision(3));

const delay = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

/**
 * Analyzers reachable right now.
 *
 * There is no broadcast discovery for an instrument on an arbitrary subnet, so
 * the addresses come from the plugin's own configuration — the user types them
 * once. The shell calls this once a second while SoundBase is enumerating and
 * never otherwise, so it stays cheap and stays silent.
 */
export async function discoverDevices(pluginConfig = {}) {
  const addresses = parseAddresses(pluginConfig.addresses);
  const found = await Promise.all(
    addresses.map(async ({ host, port }) => {
      const identity = await probe({ host, port });
      if (!identity) return null;
      return {
        // Derived from the address and nothing else, so it is stable across
        // restarts. It goes into URLs and into the user's saved project.
        id: `net:${host}:${port}`,
        name: `HAROGIC (${host})`,
        product: PRODUCT,
        transport: { kind: 'network', host, port },
      };
    })
  );
  return found.filter(Boolean);
}

/** "192.168.1.100, 192.168.1.101:5026" -> [{host, port}, …] */
function parseAddresses(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, port] = entry.split(':');
      return { host, port: Number(port) || DEFAULT_PORT };
    });
}

// ---------------------------------------------------------------------------
// the analyzer
// ---------------------------------------------------------------------------

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new HarogicAnalyzerAdapter(device, pluginConfig);
}

class HarogicAnalyzerAdapter {
  constructor(device, pluginConfig = {}) {
    // Addressing arrives in the device the host asked for, never from a file
    // beside the plugin: the same project opened on another machine has to
    // work, and that machine has never seen this one's configuration.
    const { host, port } = addressOf(device);
    this.host = host;
    this.port = port;
    this.sweepIntervalMs = isNum(pluginConfig.sweepIntervalMs)
      ? Math.max(0, pluginConfig.sweepIntervalMs)
      : DEFAULT_SWEEP_INTERVAL_MS;
    this.client = null;
    this.range = { minHz: FALLBACK_MIN_HZ, maxHz: FALLBACK_MAX_HZ };
    this.defaultPoints = FALLBACK_POINTS;
    this.effective = null;
    this.sweeping = false;
    /** assigned by the shell; call it when the transport dies unprompted */
    this.onFatal = null;
  }

  /**
   * Connect, put the instrument into a state this adapter can reason about,
   * and report what *this* unit can do.
   */
  async open() {
    this.client = new HarogicClient({ host: this.host, port: this.port });
    this.client.onFatal = (err) => this.onFatal?.(err);
    await this.client.connect();

    const identity = await this.client.identify();

    // Standard Spectrum Analysis. Everything below is a SWP-mode command.
    await this.client.write('INST:MODE SWP');

    // Four settings the rest of this adapter depends on:
    //
    //   TRAC:FORM 0       equally spaced frequency points. SoundBase builds
    //                     the frequency axis from start/stop/pointCount, which
    //                     is only true in this format — PrecisFrq would draw a
    //                     trace that looks right and is shifted.
    //   TRAC:DATA:TYPE    ASCII, so the trace arrives as text we can parse.
    //   TRAC:TYPE WRIT    Clear/Write. The shell accumulates max-hold and
    //                     averaging itself, at the full sweep rate, which is
    //                     the only place it can be done without losing a
    //                     transient. An instrument left in Max Hold would hold
    //                     twice and never release.
    //   INIT:MODE CONT    keep sweeping, so a trace read always has fresh data.
    await this.client.write('TRAC:FORM 0');
    await this.client.write('TRAC:DATA:TYPE ASC8');
    await this.client.write('TRAC:TYPE WRIT');
    await this.client.write('INIT:MODE CONT');

    // Adopt the instrument's own point count as the default rather than
    // imposing one: a PXN-45 boots at 4000, and that is a number its firmware
    // is known to be happy with.
    const points = await this.client.number('SWE:POIN');
    if (isNum(points) && points >= MIN_POINTS) {
      this.defaultPoints = Math.min(Math.round(points), MAX_POINTS);
    }

    this.range = await this.#measureRange();

    return {
      capabilities: {
        minFrequencyHz: this.range.minHz,
        maxFrequencyHz: this.range.maxHz,
        minRefLevelDbm: MIN_REF_LEVEL_DBM,
        maxRefLevelDbm: MAX_REF_LEVEL_DBM,
        rbwHz: [...RBW_CHOICES_HZ],
        controls: this.#controls(),
      },
      identity: {
        model: identity.model,
        firmware: identity.firmware,
        manufacturer: identity.manufacturer,
        serial: identity.serial,
      },
    };
  }

  /**
   * Knobs SoundBase has never heard of, rendered beside RBW and point count
   * and handed back in `cfg.controls`. Built here rather than declared in the
   * manifest so their ranges can come from the unit just identified.
   */
  #controls() {
    return [
      {
        id: 'refLevelDbm',
        type: 'number',
        label: 'Reference level',
        unit: 'dBm',
        default: 0,
        min: MIN_REF_LEVEL_DBM,
        max: MAX_REF_LEVEL_DBM,
        step: 1,
        help: 'The single biggest lever on what you can see. On a PXN-45 the noise floor is about 24 dB lower at -70 dBm than at -20 dBm. Lower it to find weak carriers; raise it when a strong transmitter is compressing the front end.',
      },
      {
        id: 'rbwMode',
        type: 'dropdown',
        label: 'RBW when set to auto',
        default: 'tracking',
        choices: [
          { id: 'tracking', label: 'Track point spacing' },
          { id: 'span1000', label: 'Span / 1000' },
          { id: 'span100', label: 'Span / 100' },
          { id: 'analyzer', label: "Analyzer's own auto" },
        ],
        help: 'What auto means. **Track point spacing** sets RBW to roughly one display point wide, so changing span re-tunes the filter for you — right across a 40 MHz UHF scan and a 1.5 GHz survey alike. Typing an RBW by hand always overrides this.',
      },
      {
        id: 'vbwMode',
        type: 'dropdown',
        label: 'VBW when set to auto',
        default: 'tentimes',
        choices: [
          { id: 'tentimes', label: '10 x RBW (no smoothing)' },
          { id: 'equal', label: '= RBW' },
          { id: 'tenth', label: 'RBW / 10 (smoothed)' },
          { id: 'hundredth', label: 'RBW / 100 (very smooth)' },
        ],
        help: 'Video bandwidth averages the trace. Narrower than RBW steadies the noise floor and makes a weak carrier stand out; it also hides short bursts, so widen it again when hunting intermittent signals.',
      },
      {
        id: 'sweepDwell',
        type: 'dropdown',
        label: 'Dwell per sweep',
        default: 'SWT',
        choices: [
          { id: 'SWT', label: 'Fastest' },
          { id: 'SWT2', label: '2 x' },
          { id: 'SWT4', label: '4 x' },
          { id: 'SWT10', label: '10 x' },
          { id: 'SWT20', label: '20 x' },
          { id: 'SWT50', label: '50 x' },
        ],
        help: 'How long the analyzer listens at each point, as a multiple of the fastest it could sweep. Raise it to catch an intermittent transmitter that a fast sweep flies straight past; the sweep slows by the same factor.',
      },
      {
        id: 'fftWindow',
        type: 'dropdown',
        label: 'FFT window',
        default: 'NUTT',
        choices: [
          { id: 'NUTT', label: 'Blackman-Nuttall (default)' },
          { id: 'LOWS', label: 'Low side lobe' },
          { id: 'FLAT', label: 'Flat top (accurate level)' },
          { id: 'KAIS', label: 'Kaiser' },
          { id: 'RECT', label: 'Rectangular' },
        ],
        help: '**Low side lobe** keeps the skirts of a strong transmitter from burying a weak carrier beside it — the usual problem next to a TV channel. **Flat top** is the one to pick when the number on the marker has to be right.',
      },
      {
        id: 'spurRejection',
        type: 'dropdown',
        label: 'Spur rejection',
        default: 'ON',
        choices: [
          { id: 'OFF', label: 'Off (fastest)' },
          { id: 'ON', label: 'On' },
          { id: 'HIGH', label: 'High' },
        ],
        help: "Suppresses the analyzer's own internally generated spurs, so you do not go hunting an interferer that is inside the instrument. It costs sweep speed: the manual's headline sweep rates are all quoted with this off.",
      },
      {
        id: 'attenDb',
        type: 'dropdown',
        label: 'Input attenuation',
        default: 'auto',
        choices: [
          { id: 'auto', label: 'Auto' },
          { id: '0', label: '0 dB' },
          { id: '10', label: '10 dB' },
          { id: '20', label: '20 dB' },
          { id: '30', label: '30 dB' },
        ],
        help: 'Raise this if a strong local transmitter is compressing the front end. Auto follows the reference level.',
      },
      {
        id: 'detector',
        type: 'dropdown',
        label: 'Detector',
        default: 'POS',
        choices: [
          { id: 'POS', label: 'Peak' },
          { id: 'NEGA', label: 'Negative peak' },
          { id: 'AVER', label: 'Average' },
          { id: 'RMS', label: 'RMS' },
          { id: 'MAXP', label: 'Max power' },
          { id: 'NORM', label: 'Sample' },
        ],
        help: 'Peak is what frequency coordination wants: the detector that will not miss a narrow carrier sitting between two points.',
      },
      {
        id: 'preamp',
        type: 'dropdown',
        label: 'Preamplifier',
        default: 'AUTO',
        choices: [
          { id: 'AUTO', label: 'Auto' },
          { id: 'OFF', label: 'Off' },
          { id: 'LOW', label: 'Low' },
          { id: 'MEDIUM', label: 'Medium' },
          { id: 'HIGH', label: 'High' },
        ],
        help: 'Lifts weak signals out of the noise. It also drops the maximum safe input from 23 dBm to 10 dBm, so switch it off when working close to transmitters.',
      },
    ];
  }

  /**
   * Find the ends of this unit's tuning range by asking for more than any
   * instrument has and reading back what it clamped to.
   *
   * `*IDN?` reports a literal "Hardware" where the model name would be, so
   * there is nothing to look a range up by. Measuring it means one adapter
   * serves a PXN-45, a PXN-90 and a rack NX without an edit. The user's own
   * start and stop are restored before this returns, and a failure anywhere
   * leaves the conservative fallback in place rather than inviting them past
   * what the hardware can do.
   */
  async #measureRange() {
    let restoreStart;
    let restoreStop;
    try {
      restoreStart = await this.client.number('FREQ:STAR');
      restoreStop = await this.client.number('FREQ:STOP');

      const maxHz = await this.client.settleNumber('FREQ:STOP', PROBE_HIGH_HZ);
      const minHz = await this.client.settleNumber('FREQ:STAR', PROBE_LOW_HZ);

      if (!isNum(minHz) || !isNum(maxHz) || minHz >= maxHz) {
        return { minHz: FALLBACK_MIN_HZ, maxHz: FALLBACK_MAX_HZ };
      }
      return { minHz, maxHz };
    } catch {
      return { minHz: FALLBACK_MIN_HZ, maxHz: FALLBACK_MAX_HZ };
    } finally {
      try {
        if (isNum(restoreStart) && isNum(restoreStop)) {
          await this.client.write(`FREQ:STAR ${Math.round(restoreStart)}`);
          await this.client.write(`FREQ:STOP ${Math.round(restoreStop)}`);
        }
      } catch {
        // the first applyConfig sets a span of its own anyway
      }
    }
  }

  /**
   * Apply what was asked for and report what is actually in force.
   *
   * Clamp, never reject: a 400 makes a working plugin look broken, while a
   * clamped value tells the user what the instrument can do. Fields absent
   * from `cfg` are unchanged, and `cfg.controls` is merged by id.
   */
  async applyConfig(cfg = {}) {
    const previous = this.effective ?? { controls: {} };
    const controls = { ...previous.controls, ...(cfg.controls ?? {}) };
    const { minHz, maxHz } = this.range;

    const wantStart = clamp(
      isNum(cfg.startHz) ? cfg.startHz : (previous.startHz ?? DEFAULT_START_HZ),
      minHz,
      maxHz
    );
    const wantStop = clamp(
      isNum(cfg.stopHz) ? cfg.stopHz : (previous.stopHz ?? DEFAULT_STOP_HZ),
      wantStart,
      maxHz
    );

    // Move the far end first, so the instrument never sees a start above its
    // stop and clamps the span on the way past.
    let startHz;
    let stopHz;
    if (wantStart >= (previous.stopHz ?? 0)) {
      stopHz = await this.client.settleNumber('FREQ:STOP', Math.round(wantStop));
      startHz = await this.client.settleNumber(
        'FREQ:STAR',
        Math.round(wantStart)
      );
    } else {
      startHz = await this.client.settleNumber(
        'FREQ:STAR',
        Math.round(wantStart)
      );
      stopHz = await this.client.settleNumber('FREQ:STOP', Math.round(wantStop));
    }

    const wantPoints = clamp(
      Math.round(
        isNum(cfg.pointCount)
          ? cfg.pointCount
          : (previous.pointCount ?? this.defaultPoints)
      ),
      MIN_POINTS,
      MAX_POINTS
    );
    await this.client.settleNumber('SWE:POIN', wantPoints);

    const effective = {
      startHz,
      stopHz,
      pointCount: wantPoints, // replaced below by the length of a real trace
      controls,
      resolved: {},
    };
    const span = Math.max(1, stopHz - startHz);

    // --- resolution bandwidth ------------------------------------------------
    //
    // An RBW the user typed always wins. The mode only decides what "auto"
    // means, and the tracking mode is the one that makes a single setting work
    // across a 40 MHz UHF scan and a 1.5 GHz survey: one display point wide.
    if (isNum(cfg.rbwHz)) {
      await this.client.write('BAND:AUTO MANU');
      effective.rbwHz = await this.client.settleNumber(
        'BAND:RES',
        clamp(cfg.rbwHz, MIN_BW_HZ, MAX_BW_HZ)
      );
    } else {
      const mode = controls.rbwMode ?? 'tracking';
      if (mode === 'tracking') {
        const perPoint = clamp(span / wantPoints, MIN_BW_HZ, MAX_BW_HZ);
        await this.client.write('BAND:AUTO MANU');
        effective.resolved.rbwHz = await this.client.settleNumber(
          'BAND:RES',
          tidy(perPoint)
        );
      } else {
        const word =
          mode === 'span1000'
            ? 'ONETHOU'
            : mode === 'span100'
              ? 'ONEPER'
              : 'AUTO';
        await this.client.write(`BAND:AUTO ${word}`);
        effective.resolved.rbwHz = await this.client.number('BAND:RES');
      }
    }

    // --- video bandwidth -----------------------------------------------------
    if (isNum(cfg.vbwHz)) {
      await this.client.write('BWID:VID:AUTO MANU');
      effective.vbwHz = await this.client.settleNumber(
        'BWID:VID',
        clamp(cfg.vbwHz, MIN_BW_HZ, MAX_BW_HZ)
      );
    } else {
      const word =
        {
          equal: 'EQUALToRBW',
          tenth: 'TENPERcentRBW',
          hundredth: 'ONEPERcentRBW',
        }[controls.vbwMode ?? 'tentimes'] ?? 'TENTIMEsRBW';
      await this.client.write(`BWID:VID:AUTO ${word}`);
      effective.resolved.vbwHz = await this.client.number('BWID:VID');
    }

    // --- amplitude -----------------------------------------------------------
    const askedRefLevel = isNum(cfg.refLevelDbm)
      ? cfg.refLevelDbm
      : isNum(Number(controls.refLevelDbm))
        ? Number(controls.refLevelDbm)
        : undefined;
    if (isNum(askedRefLevel)) {
      effective.refLevelDbm = await this.client.settleNumber(
        'DISP:TRAC:Y:SCAL:RLEV',
        Math.round(clamp(askedRefLevel, MIN_REF_LEVEL_DBM, MAX_REF_LEVEL_DBM))
      );
      effective.controls.refLevelDbm = effective.refLevelDbm;
    }

    if (controls.attenDb !== undefined) {
      // -1 is HAROGIC's "automatic", linked to the reference level.
      const asked = controls.attenDb === 'auto' ? -1 : Number(controls.attenDb);
      const atten = await this.client.settleNumber(
        'INP:ATT',
        Math.round(isNum(asked) ? asked : -1)
      );
      effective.controls.attenDb = atten < 0 ? 'auto' : String(atten);
    }
    if (controls.preamp !== undefined) {
      await this.client.write(`INP:GAIN:STAT ${controls.preamp}`);
    }

    // --- acquisition ---------------------------------------------------------
    if (controls.detector !== undefined) {
      await this.client.write(`DET ${controls.detector}`);
    }
    if (controls.sweepDwell !== undefined) {
      await this.client.write(`SWE:TIME:AUTO ${controls.sweepDwell}`);
    }
    if (controls.fftWindow !== undefined) {
      await this.client.write(`SWE:FFT:WIND:TYPE ${controls.fftWindow}`);
    }
    if (controls.spurRejection !== undefined) {
      await this.client.write(
        `DISP:WIND:TRAC:SPUR:SUPP ${controls.spurRejection}`
      );
    }

    // How long one sweep takes at these settings. Without it SoundBase has to
    // learn the instrument's speed from its sweeps, and a slow first sweep
    // reads as a stall. The dwell multiplier above can make this seconds.
    const sweepSeconds = await this.client.number('SWE:TIME');
    if (isNum(sweepSeconds)) {
      effective.resolved.sweepTimeMs = Math.round(sweepSeconds * 1000);
    }

    // The point count the instrument settles on is not always the one it was
    // asked for, and a trace whose length disagrees with the configuration is
    // the classic cause of a plot that looks right and is shifted in
    // frequency. One real trace settles it.
    const trace = await this.client.trace();
    effective.pointCount = trace.length;

    if (Object.keys(effective.resolved).length === 0) delete effective.resolved;
    this.effective = effective;
    return effective;
  }

  /**
   * Sweep until told to stop, calling `onTrace(amplitudesDbm)` once per
   * completed sweep: one array of numbers in dBm, ordered from startHz to
   * stopHz. The shell builds the frequency axis, the sweep id, the timestamp
   * and the trace-mode accumulation from the effective configuration.
   *
   * A loop rather than setInterval, so an instrument slower than the interval
   * cannot pile up overlapping reads on one socket.
   */
  async startSweep(onTrace) {
    if (this.sweeping) return;
    this.sweeping = true;
    (async () => {
      while (this.sweeping) {
        try {
          const amplitudes = await this.client.trace();
          if (!this.sweeping) return;
          // A trace of the wrong length would draw a frequency-shifted plot.
          // Skipping it keeps the last good one on screen until applyConfig
          // catches up, which is what a reconfigure in flight looks like.
          if (amplitudes.length === this.effective?.pointCount) {
            onTrace(amplitudes);
          }
          if (this.sweepIntervalMs > 0) await delay(this.sweepIntervalMs);
        } catch (err) {
          // One bad read is not necessarily a dead instrument; the client's
          // own close and error handling calls onFatal when it really is.
          if (!this.sweeping) return;
          this.onFatal?.(err);
          return;
        }
      }
    })();
  }

  async stopSweep() {
    this.sweeping = false;
  }

  /** Release the transport. Called on removal, teardown, and after a fatal. */
  async close() {
    this.sweeping = false;
    this.client?.close();
    this.client = null;
  }
}

/**
 * `device.config` holds the manifest's `deviceConfigFields`, filled in from the
 * SoundBase project. The id fallback covers a device this plugin discovered
 * itself, whose id already encodes the address.
 */
function addressOf(device) {
  const config = device.config ?? {};
  if (config.host) {
    return { host: config.host, port: Number(config.port) || DEFAULT_PORT };
  }
  const match = /^net:([^:]+)(?::(\d+))?$/.exec(device.id ?? '');
  if (match) return { host: match[1], port: Number(match[2]) || DEFAULT_PORT };
  throw new Error(
    `device ${device.id} has no address: set "IP address" in its configuration`
  );
}
