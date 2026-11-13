# hsn_bench: the real-time bench

`hsn_bench` runs a site of simulated boards in real time, with the real sensor, siren and gateway roles, and joins each board's links to pseudo-terminals the real hub opens ([hub-design.md](../../../docs/hub-design.md), section 11). It is built by the normal firmware build (`build/<preset>/tools/bench/hsn_bench`).

Every board starts the way it leaves the factory: unpaired, a development build, its role already stored, in setup-only mode. Every board is on USB power at the start, so none deep-sleeps before the hub provisions it over USB with real setup messages; turn a sensor's USB power off with the script once it is paired.

## Starting a run

```sh
hsn_bench --sensors 2 --sirens 1 --gateways 1 --manifest bench-manifest.json > timeline.jsonl
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--sensors N`, `--sirens N`, `--gateways N` | 1 each | How many boards of each role. Names are `sensor1`, `siren1`, `gateway1`, and so on |
| `--gateway-wifi` | off | Gateways also get a network link (sirens always have one) |
| `--path-loss DB` | 100 | Path loss between every two boards, in dB |
| `--seed N` | 1 | The simulation's seed (radio noise, retry jitter) |
| `--manifest PATH` | `bench-manifest.json` | Where the manifest is written, before the run starts |
| `--timeline PATH` or `-` | `-` (standard output) | Where the timeline goes |
| `--skip KIND,...` or `none` | `retained_write` | Record kinds left out of the timeline |

The run goes on until the script says `quit` or the process gets SIGINT or SIGTERM. The end of standard input does not stop it, so `hsn_bench < script.txt` keeps running after the last line.

## The manifest

Written once at the start, in the hub's frozen schema (`hub/src/control-protocol/manifest.ts`):

```json
{"version":1,"devices":[
  {"name":"sensor1","role":"sensor","links":[{"kind":"usb","path":"/dev/ttys004"}]},
  {"name":"siren1","role":"siren","links":[{"kind":"usb","path":"/dev/ttys005"},{"kind":"network","path":"/dev/ttys006"}]}]}
```

Every board has a USB link; sirens, and gateways with `--gateway-wifi`, also have a network link.

## The terminals

Each link is one pseudo-terminal. Both kinds carry frames as USB does: COBS, then a zero byte; a 254-byte run is read with or without its trailing empty block.

- A link is up while the far end holds the terminal open, and down when it closes it. A USB link up means the board sees a host on USB; a network link up means the board's network connection is there.
- The bench waits 100 ms after the far end opens before it attaches, so the opener can set raw mode first; frames written in that time are held, then delivered.
- If the far end still has output processing on when the link attaches (OPOST, so each 0x0A it writes arrives as 0x0D 0x0A and frames are corrupted), the bench writes one `error` line and changes nothing, as a real board could not. Open the terminal raw, with OPOST cleared.
- A board's reset is not seen on the terminal: it stays open. The hub learns of it from what the board says next. A restart the board asks for (after a Provision, say) first lets its links finish sending what they were given, for at most 200 ms, so the answer announcing it arrives; a power loss or the script's `restart` or `power-loss` gives no such grace. Frames sent towards a board while it restarts are lost.
- Every board has its own chip identifier, from its name and the seed, and keeps it across resets and from run to run.

## The script

One command per line on standard input. Blank lines and lines starting with `#` are ignored. A command takes effect at the instant it is read. A refused line changes nothing and writes an `error` line.

| Command | Effect |
| --- | --- |
| `door <device> open\|close` | The door contact |
| `cover <device> open\|close` | The cover (tamper) switch |
| `button <device> press\|release` | The button |
| `hold <device> <seconds>` | Presses the button now and releases it after the given time |
| `usb-power <device> on\|off` | USB power to the board |
| `power-loss <device> [<seconds>]` | Removes all power for the given time (default 1 s), then restores it |
| `restart <device>` | Resets the board |
| `cut <device> usb\|network` | Takes the link down while the far end stays open |
| `restore <device> usb\|network` | Brings a cut link back (if the far end is open) |
| `noise <channel 0-2> <dBm> <seconds>` | Noise on one site channel, from now, for the given time |
| `path-loss <device> <device> <dB>` | Path loss between two boards, both ways |
| `quit` | Ends the run |

## The timeline

One JSON object per line, as it happens. `t` is true time in seconds since the start (six decimals). Two shapes:

- A record: `{"t":1.5,"actor":"sensor1","kind":"transmission",...,"text":"..."}`. `kind` is the record kind (`boot`, `wait`, `input`, `transmission`, `reception`, `link_sent`, `link_received`, `deep_sleep`, ...). Fields appear when set: `from`, `until` (`null` for never), `frequency_hz` with `data_rate`, `rssi_dbm`, `snr_quarter_db`, `reset_cause` (boot records), `length`, `peer`, `address` with `counter` and, when known, `type`; `flag` and `value` are always there. `text` is the bench's own one-line description.
- A bench line, with one of these keys:
  - `started`: the manifest path, first line of the run;
  - `command`: a script line that was carried out, after the records it caused;
  - `error`: why a script line was refused, or a far end with output processing on;
  - `note`: about a link, as `"<device> <kind>: <what>"`; `open` (also after a restore), `closed`, `cut`, or a frame that does not decode;
  - `lag_ms`, with `due`: the bench fell more than 5 ms behind the host clock;
  - `quit`: `"quit"` or `"signal"`, the last line.

## Timing

True time follows the host's monotonic clock and never runs ahead of it. Frames from a terminal are delivered at the instant they are read. When the host keeps the bench from running for more than 5 ms past an action's time, the bench catches up and reports the lag; a debug build with sanitizers lags more often than a release build.
