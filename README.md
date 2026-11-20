# ModoRF — HAROGIC Spectrum Analyzers for SoundBase

A SoundBase plugin that brings HAROGIC real-time spectrum analyzers into
SoundBase as a live spectrum source, over SCPI on TCP.

Built by [ModoRF](https://modorf.com) for RF coordination at live events.

## What it supports

Any HAROGIC analyzer whose SAStudio4 exposes SCPI — the SA, NX and PX series,
including the handheld PXN. The plugin measures the tuning range of whatever
unit it finds rather than looking it up by model, so one build serves a
PXN-45, a PXN-90 and a rack NX without an edit.

| | |
|---|---|
| Span | the unit's full range, measured at connect |
| RBW / VBW | continuous, 0.1 Hz – 10 MHz, with automatic modes that track the span |
| Reference level | −70 to +23 dBm |
| Controls | reference level, RBW mode, VBW mode, dwell per sweep, FFT window, spur rejection, input attenuation, detector, preamplifier |
| Point count | adopted from the instrument at connect, clamped to 16384 |
| Trace modes | Clear/Write on the instrument — SoundBase accumulates max-hold and averaging itself, at the full sweep rate |

### RBW that follows the span

The control worth knowing about. Set **RBW when set to auto** to *Track point
spacing* and the plugin sizes the filter to roughly one display point wide
every time the span changes:

| Span | Points | Point spacing | RBW chosen |
|---|---|---|---|
| 470–510 MHz | 4000 | 10 kHz | 10 kHz |
| 470–900 MHz | 4000 | 108 kHz | 108 kHz |
| 1.0–2.0 GHz | 4000 | 250 kHz | 250 kHz |
| 900–2400 MHz | 4000 | 375 kHz | 375 kHz |

which is the ratio you want across that whole range, because what you are
looking for up at 2.4 GHz is wider than what you are looking for at 500 MHz.
The analyzer's own `span/1000` and `span/100` presets are offered too.

**Typing an RBW always wins.** The mode only decides what *auto* means; put
the host's RBW field back to auto to hand control back to it.

### What it does not do

- **Only Standard Spectrum Analysis (`SWP`).** IQ streaming, real-time (RTA),
  EMI pre-compliance, phase noise and the demodulation modes are not exposed.
  The plugin puts the instrument into SWP at connect and leaves it there.
- **No tracking generator**, no markers, no recording or playback. Those are
  SAStudio4's own, and SoundBase has nowhere to put them.
- **The SCPI data channel (port 5125) is not used.** Traces come over the
  control channel, which is fast enough for coordination work and far simpler
  to keep correct.
- **No broadcast discovery.** An analyzer is found at an address you give it.

### What it has been tested against

So far, only the fake analyzer in `driver/fake-harogic.js`, which reproduces
the HAROGIC clamping, quantizing and reply behaviour described in the SCPI
guide. **It has not yet been run against real hardware.** Until that line
changes, treat it as untested on an instrument.

It is written against *SCPI Application Guide V4.55.64* and uses no command
that guide does not document. Other models in the SA, NX and PX families
should work — the plugin measures what it finds rather than assuming a model —
but none has been tried. If you run one, say so in an issue.

## Trusting this plugin

Installing a plugin means trusting its author. SoundBase runs it as a separate
process so a crash cannot take the app down, but that is fault isolation, not a
security sandbox: this code runs with your privileges, like a VST or a
Companion module. It is all in this repository — `adapter.js` and `driver/` are
about 600 lines between them. Read them.

It opens exactly one outbound TCP connection, to the address you type in, and
sends nothing anywhere else.

## Before it can connect

SCPI is off by default. On the analyzer (or on the PC running SAStudio4):

1. **System → SCPI**
2. Tick **Enable**
3. Note the **Control Port** — 5025 unless you changed it

Then find the address of the machine running SAStudio4. On a handheld PXN that
is the analyzer itself, and the quickest way is its own terminal:

```sh
hostname -I
```

Older SAStudio builds ran SCPI through a separate `HTRA_Server`. If one is
still installed it holds port 5025 and the built-in service cannot start —
uninstall it from `C:\HTRA_Server` first.

## Setting it up in SoundBase

Add the device by hand with its **IP address** and **Control port**, or put the
addresses in the plugin's own settings and let them appear in the device
picker:

```
192.168.1.100, 192.168.1.101:5026
```

There is no broadcast discovery for an instrument on an arbitrary subnet, so an
address that is not listed and not typed in is an analyzer SoundBase will not
find.

## Development

```sh
npm install
npm test     # the whole stack against a fake analyzer — no hardware needed
npm run smoke
npm start
```

`driver/fake-harogic.js` is a fake instrument that reproduces the two HAROGIC
habits the driver has to get right: a setting sends no reply, and values are
clamped and quantized silently. It is why the test suite runs anywhere.

### The files

```
soundbase-plugin.json      the manifest — products, and the fields the user fills in
main.js                    unchanged from the template; do not edit
adapter.js                 the SoundBase contract: discovery, open, config, sweep
driver/harogic-scpi.js     the wire. Knows nothing about SoundBase.
driver/fake-harogic.js     an analyzer to test against
__tests__/harogic.test.js  shell, adapter, driver and socket, end to end
```

### Notes for whoever picks this up next

- **`*IDN?` has no model name in it.** HAROGIC answers with a literal
  `Hardware` where other instruments put `PXN-45`. The tuning range is measured
  at `open()` instead — push the stop frequency past anything that exists, read
  back what it clamped to, and put the user's own span back.
- **Settings are silent; only queries answer.** Anything that writes and then
  waits for an acknowledgement will hang, and worse, will match every later
  reply to the wrong command.
- **Trace arrives as one long line**, semicolon separated in practice though
  the guide's prose says commas. The driver accepts either.
- **`TRAC:FORM 0` matters.** SoundBase builds the frequency axis from start,
  stop and point count, which is only true for equally spaced points. In
  PrecisFrq the plot looks right and is shifted.
- **The point count is whatever the trace is long**, not whatever `SWE:POIN`
  was asked for. `applyConfig` reads one real trace and reports its length.
- **Never pass a large point count straight through.** A PXN-45 asked for a
  million points stops answering SCPI altogether and has to be power-cycled;
  its own default is 4000. The adapter clamps at 16384, which is far more than
  any sweep needs and far less than what wedges the instrument.
- **Do not expose the instrument's own Max Hold or averaging.** SoundBase
  accumulates trace modes itself at the full sweep rate, so a device left
  holding would hold twice and never release. `open()` forces Clear/Write.

Reference: *HAROGIC Spectrum Analyzer SCPI Application Guide V4.55.64*.

---

## Inicio rápido (ES)

1. En el analizador: **System → SCPI → Enable**. El puerto de control es 5025.
2. Averigua su IP. En un PXN de mano, abre su terminal y escribe `hostname -I`.
3. En SoundBase, añade el dispositivo con esa IP y el puerto 5025.

Para trabajar en el código sin tener el analizador delante, `npm test` levanta
un analizador falso y prueba todo el camino.
