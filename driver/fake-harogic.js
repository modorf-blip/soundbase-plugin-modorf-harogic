// A fake HAROGIC analyzer, so the plugin can be developed and tested with
// nothing plugged in — on a laptop in a hotel room, or on a CI runner.
//
// It reproduces the habits of the real instrument that the driver has to get
// right, and that are easy to get wrong:
//
//   - a setting sends NO reply, only a query does. A fake that acknowledged
//     everything would hide the bug where every reply is matched to the wrong
//     command.
//   - the trace comes back wrapped in one pair of quotes.
//   - values are clamped and quantized silently, so what you asked for and
//     what you got are not the same number.

import net from 'node:net';

const MIN_HZ = 9_000;
const MAX_HZ = 4_500_000_000;
// deliberately above the adapter's own ceiling, so a test can prove the
// adapter clamps before the instrument ever has to
const MAX_POINTS = 20_000;
const MIN_BW = 0.1;
const MAX_BW = 10_000_000;
const BASE_SWEEP_SECONDS = 0.0091;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const DWELL = {
  SWT: 1,
  SWT2: 2,
  SWT4: 4,
  SWT10: 10,
  SWT20: 20,
  SWT50: 50,
};

// The documented vocabularies, written the way the SCPI Application Guide
// V4.55.64 prints them (§6.2.37, .39, .44, .51, .57): capitals are the short
// form, the whole word is the long one, and a query answers with the long
// one in quotes. Both spellings are accepted, nothing else is.
const ENUMS = {
  dwell: [
    'MANUal',
    'SWT',
    'SWT2',
    'SWT4',
    'SWT10',
    'SWT20',
    'SWT50',
    'SWTN',
    'SMPN',
  ],
  fftWindow: ['FLATop', 'NUTTall', 'LOWSideLobe', 'RECT', 'KAISer'],
  spurRejection: ['OFF', 'ON', 'HIGH'],
  detector: [
    'NORMal',
    'POSitive',
    'AVERage',
    'NEGAtive',
    'MAXPower',
    'RMS',
    'RAW',
  ],
  preamp: ['AUTO', 'OFF', 'LOW', 'MEDIUM', 'HIGH'],
};

/**
 * The most trace points the instrument will hand out at the resolution
 * bandwidth currently in force.
 *
 * Measured on a PXN-45: a 40 MHz span at RBW 200 kHz settles on 601 points,
 * 66.6 kHz apart — one third of the RBW. Points closer together than that
 * would be three looks through the same filter, so it declines to produce
 * them, whatever is asked for.
 *
 * Reproduced here because it is what makes the order of SWE:POIN and
 * BAND:RES matter, and an adapter that gets that order wrong looks perfectly
 * healthy against a fake that hands out whatever it is asked for.
 */
const POINTS_PER_RBW = 3;
const pointCeiling = (state) =>
  Math.max(
    2,
    Math.floor((POINTS_PER_RBW * (state.stopHz - state.startHz)) / state.rbwHz)
  );

/** `NUTTall` -> `NUTT`: the leading run of capitals and digits. */
const shortForm = (word) => word.match(/^[A-Z0-9]*/)[0];

/**
 * Resolve what was sent to the spelling the instrument would answer with, or
 * null if it is not in the vocabulary.
 *
 * A real instrument given an enum it does not implement ignores the line and
 * keeps the value it had — and says nothing, because settings draw no reply.
 * Reproducing that is the whole point: it is the failure a plugin cannot see
 * unless it reads the value back.
 */
function resolveEnum(which, sent) {
  const token = String(sent).trim().toUpperCase();
  return (
    ENUMS[which].find(
      (word) =>
        word.toUpperCase() === token || shortForm(word).toUpperCase() === token
    ) ?? null
  );
}

export async function startFakeHarogic({ port = 0 } = {}) {
  const state = {
    mode: 'SWP',
    startHz: 470_000_000,
    stopHz: 616_000_000,
    // a real PXN-45 boots at 4000
    points: 4_001,
    rbwHz: 300_000,
    rbwAuto: 'AUTO',
    vbwHz: 3_000_000,
    vbwAuto: 'TENTIMEsRBW',
    refLevelDbm: 0,
    attenDb: -1,
    detector: 'POSitive',
    preamp: 'AUTO',
    dwell: 'SWT',
    fftWindow: 'NUTTall',
    spurRejection: 'ON',
    traceFormat: 0,
    traceType: 'WRIT',
    dataType: 'ASC8',
  };

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (line === '') continue;
        const reply = handle(line, state);
        // null means "this was a setting" — the real instrument says nothing
        if (reply !== null) socket.write(`${reply}\n`);
      }
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    state,
    /** drop every connection without closing the listener — a transport death */
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function handle(line, state) {
  const space = line.indexOf(' ');
  const command = (space < 0 ? line : line.slice(0, space)).toUpperCase();
  const argument = space < 0 ? '' : line.slice(space + 1).trim();

  switch (command) {
    case '*IDN?':
      return 'HTRA,Hardware,57465013002b003a,A:0_55_89,F:0_55_103,M:0_55_103S0_55_103';
    case '*CLS':
    case '*WAI':
      return null;
    case '*ERR?':
      return '0, No error';

    case 'INST:MODE':
      state.mode = argument.toUpperCase();
      return null;
    case 'INST:MODE?':
      return state.mode;

    case 'FREQ:STAR':
      state.startHz = clamp(Number(argument), MIN_HZ, state.stopHz);
      return null;
    case 'FREQ:STAR?':
      return String(state.startHz);
    case 'FREQ:STOP':
      state.stopHz = clamp(Number(argument), state.startHz, MAX_HZ);
      return null;
    case 'FREQ:STOP?':
      return String(state.stopHz);

    case 'SWE:POIN':
      // the real instrument settles on something near what it was asked for,
      // and will not go finer than the filter in force can tell apart
      state.points =
        clamp(
          Math.round(Number(argument)),
          2,
          Math.min(MAX_POINTS, pointCeiling(state))
        ) | 1;
      return null;
    case 'SWE:POIN?':
      return String(state.points);

    case 'SWE:TIME:AUTO':
      state.dwell = resolveEnum('dwell', argument) ?? state.dwell;
      return null;
    case 'SWE:TIME:AUTO?':
      return `"${state.dwell}"`;
    case 'SWE:TIME?':
      return String(BASE_SWEEP_SECONDS * (DWELL[state.dwell] ?? 1));

    case 'SWE:FFT:WIND:TYPE':
      state.fftWindow = resolveEnum('fftWindow', argument) ?? state.fftWindow;
      return null;
    case 'SWE:FFT:WIND:TYPE?':
      return `"${state.fftWindow}"`;

    case 'BAND:AUTO':
      state.rbwAuto = argument.toUpperCase();
      if (state.rbwAuto.startsWith('ONETHOU')) {
        state.rbwHz = clamp((state.stopHz - state.startHz) / 1000, MIN_BW, MAX_BW);
      } else if (state.rbwAuto.startsWith('ONEPER')) {
        state.rbwHz = clamp((state.stopHz - state.startHz) / 100, MIN_BW, MAX_BW);
      } else if (state.rbwAuto === 'AUTO') {
        state.rbwHz = clamp((state.stopHz - state.startHz) / 500, MIN_BW, MAX_BW);
      }
      return null;
    case 'BAND:AUTO?':
      return `"${state.rbwAuto}"`;
    case 'BAND:RES':
      state.rbwHz = clamp(Number(argument), MIN_BW, MAX_BW);
      return null;
    case 'BAND:RES?':
      return String(state.rbwHz);

    case 'BWID:VID:AUTO': {
      state.vbwAuto = argument.toUpperCase();
      const ratio = state.vbwAuto.startsWith('EQUAL')
        ? 1
        : state.vbwAuto.startsWith('TENPER')
          ? 0.1
          : state.vbwAuto.startsWith('ONEPER')
            ? 0.01
            : 10;
      if (!state.vbwAuto.startsWith('MANU')) {
        state.vbwHz = clamp(state.rbwHz * ratio, MIN_BW, MAX_BW);
      }
      return null;
    }
    case 'BWID:VID':
      state.vbwHz = clamp(Number(argument), MIN_BW, MAX_BW);
      return null;
    case 'BWID:VID?':
      return String(state.vbwHz);

    case 'DISP:TRAC:Y:SCAL:RLEV':
      state.refLevelDbm = clamp(Math.round(Number(argument)), -70, 23);
      return null;
    case 'DISP:TRAC:Y:SCAL:RLEV?':
      return String(state.refLevelDbm);

    case 'DISP:WIND:TRAC:SPUR:SUPP':
      state.spurRejection =
        resolveEnum('spurRejection', argument) ?? state.spurRejection;
      return null;
    case 'DISP:WIND:TRAC:SPUR:SUPP?':
      return `"${state.spurRejection}"`;

    case 'INP:ATT':
      state.attenDb = clamp(Math.round(Number(argument)), -1, 30);
      return null;
    case 'INP:ATT?':
      return String(state.attenDb);

    case 'DET':
      state.detector = resolveEnum('detector', argument) ?? state.detector;
      return null;
    case 'DET?':
      return `"${state.detector}"`;

    case 'INP:GAIN:STAT':
      state.preamp = resolveEnum('preamp', argument) ?? state.preamp;
      return null;
    case 'INP:GAIN:STAT?':
      return `"${state.preamp}"`;

    case 'TRAC:FORM':
      state.traceFormat = Number(argument);
      return null;
    case 'TRAC:FORM?':
      return String(state.traceFormat);
    case 'TRAC:TYPE':
      state.traceType = argument.toUpperCase();
      return null;
    case 'TRAC:TYPE?':
      return `"${state.traceType}"`;
    case 'TRAC:DATA:TYPE':
      state.dataType = argument.toUpperCase();
      return null;
    case 'TRAC:DATA:TYPE?':
      return `"${state.dataType}"`;
    case 'INIT:MODE':
      return null;

    // Semicolon separated, exponent notation, and the whole array wrapped in
    // one pair of quotes — which is what a PXN-45 on 4.55.64 actually sends,
    // though the SCPI guide's own example shows it unquoted. Reproduced here
    // because a driver that splits before stripping the quotes fails on the
    // first and last point of every sweep, and only on real hardware.
    case 'TRAC:DATA?':
      return `"${sweep(state)
        .map((v) => v.toExponential(3))
        .join(';')}"`;
    case 'TRAC:X:DATA?':
      return `"${frequencies(state)
        .map((v) => v.toExponential(3))
        .join(';')}"`;

    default:
      return `-113, Undefined header: ${command}`;
  }
}

function frequencies({ startHz, stopHz, points }) {
  const step = (stopHz - startHz) / (points - 1);
  return Array.from({ length: points }, (_, i) => startHz + i * step);
}

/** A noise floor with two carriers in it, so a test can find a peak. */
function sweep(state) {
  const { startHz, stopHz, points } = state;
  const span = Math.max(1, stopHz - startHz);
  const floor = -100 + (state.attenDb > 0 ? state.attenDb : 0);
  const bump = (f, centre, width, height) =>
    height * Math.exp(-(((f - centre) / width) ** 2));
  return frequencies(state).map((f) => {
    let amp = floor + Math.random() * 2;
    amp += bump(f, startHz + span * 0.33, span * 0.004, 55);
    amp += bump(f, startHz + span * 0.66, span * 0.004, 40);
    return Math.round(amp * 10) / 10;
  });
}
