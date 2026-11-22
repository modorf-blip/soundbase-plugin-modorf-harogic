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
| Point count | sized from the span when left on auto, and never more than three per RBW — see below |
| Trace modes | Clear/Write on the instrument — SoundBase accumulates max-hold and averaging itself, at the full sweep rate |

### RBW that follows the span

The control worth knowing about. Set **RBW when set to auto** to *Track point
spacing* and the plugin sizes the filter to roughly one display point wide
every time the span changes:

| Span | Points (auto) | Point spacing | RBW chosen |
|---|---|---|---|
| 470–510 MHz | 2000 | 20 kHz | 20 kHz |
| 470–698 MHz | 4560 | 50 kHz | 50 kHz |
| 470–900 MHz | 8600 | 50 kHz | 50 kHz |
| 1.0–2.0 GHz | 10000 | 100 kHz | 100 kHz |
| 900–2400 MHz | 15000 | 100 kHz | 100 kHz |

which is the ratio you want across that whole range, because what you are
looking for up at 2.4 GHz is wider than what you are looking for at 500 MHz.
The analyzer's own `span/1000` and `span/100` presets are offered too.

**Typing an RBW always wins.** The mode only decides what *auto* means; put
the host's RBW field back to auto to hand control back to it.

### Point count that follows the span too

Left on auto, the point count is sized from the span rather than fixed, for
the same reason: 4000 points is 10 kHz apart across a 40 MHz scan and 375 kHz
apart across a 1.5 GHz one, so the number on its own means nothing. Auto
targets a spacing instead — **50 kHz per point** below 500 MHz of span, where
a coordinator is separating UHF carriers a couple of hundred kHz wide, and
**100 kHz** above it, where the occupants are WiFi, DECT and wideband IEM and
finer spacing buys sweep time and no information. Never fewer than 2000
points, never more than 16384.

Type a number and yours is used instead — up to a ceiling the plugin will not
let you past.

### The point-count ceiling, and why it is not negotiable

An instrument will not produce trace points closer together than the filter
in force can tell apart. Three measurements per RBW is the usual engineering
choice, and it is what SoundBase itself assumes when it sizes a sweep from an
RBW: across 430 MHz at RBW 200 kHz that comes to 6451 points.

What matters is what a PXN-45 does when it is asked for more. Measured on
2026-11-21, on that exact span and RBW:

| Points asked for | What happened |
|---|---|
| 6451 | sweeps normally |
| 12000 | the instrument stops answering, and has to be recovered by hand |

It does not clamp. It does not report an error. It goes quiet, the plugin
hangs waiting for a trace, and the host gives up on the device — which, in a
show, is the analyzer gone until someone restarts its SCPI service.

So the plugin works the ceiling out for itself from the RBW it just applied,
and clamps to it before `SWE:POIN` ever goes out. A point count beyond it
does not reach the instrument. The fake analyzer reproduces the failure, so a
regression here fails the test suite loudly rather than waiting to be found
on a show day.

### One control that is missing, and why

**LO optimization** (`LO:STAT`) moves where the local oscillator sits so that
fewer spurious products are generated — a genuinely useful companion to spur
rejection, which cleans them out of the trace afterwards. The instrument
offers it on its own front panel in sweep mode. This plugin does not.

A PXN-45 accepts `LO:STAT 0` and then never answers `LO:STAT?`.

That is worse than it sounds. A reply on this protocol carries no indication
of what it answers, so replies are matched to queries in the order they were
asked. One query that is never answered shifts every reply after it by one
place, for the life of the connection: the trace meant for the sweep is handed
to a config read, the sweep waits for a reply it will never recognise, and
nothing reports an error because every query did receive *a* reply. The socket
stays open and healthy-looking while no measurement ever arrives.

This was shipped in 0.3.3, found on hardware, and taken out again in 0.3.5.
Until the driver can survive a dropped reply, a control belongs here only if
the instrument answers its query. Set LO optimization on the analyzer itself.

### Defaults

Every control arrives at the value the instrument itself boots with, or the
one its own manual recommends — not at one tuned for any particular kind of
work. A coordinator will likely want *Low side lobe* for the FFT window, for
instance, but that is a choice for whoever is holding the analyzer, not
something this plugin should decide on their behalf.

In practice three controls get touched in a working session — reference
level, the RBW mode, and the dwell. The rest are there for the day they are
needed rather than to be managed.

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

**A HAROGIC PXN-45, over Ethernet, coordinating live events.** It sweeps,
retunes, and holds a connection across a working session. Two things found
that way are in the code because no fake would have produced them: the unit
returns its trace array wrapped in quotes, and it stops answering SCPI
altogether if asked for a point count far beyond what it expects — hence the
16384 ceiling, which exists so nobody else has to power-cycle an analyzer
mid-show to find that out.

Confirmed on the instrument: connect and identify, range measurement, start
and stop, point count, RBW and VBW in both automatic and manual modes,
reference level, continuous sweeping, and the dwell multiplier.

Everything else runs against the fake analyzer in `driver/fake-harogic.js`,
which reproduces the clamping, quantizing and reply behaviour the SCPI guide
describes — including answering in the long spelling and ignoring an enum it
does not know.

It is written against *SCPI Application Guide V4.55.64* and uses no command
that guide does not document. The five enum controls are set and then read
back, so if a firmware does not implement one, the value snaps back in
SoundBase instead of silently doing nothing.

Only the PXN-45 has been tried. Other models in the SA, NX and PX families
should work — the plugin measures what it finds rather than assuming a model.
The USB units should work too, pointed at whatever machine runs their
SAStudio4, though nobody has confirmed that. If you run one, say so in an
issue and this section grows.

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

---

## Licence

MIT — see [`LICENSE`](LICENSE). Use it, change it, ship it in your own work.

The files this repository was generated from carry the SoundBase SDK's own
licence, which is a different one; [`NOTICE`](NOTICE) says which files and
what it permits.
