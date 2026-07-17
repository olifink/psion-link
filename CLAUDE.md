# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Pre-implementation. The repository currently contains only `BRIEF.md` — a
detailed handoff spec. No code, `package.json`, or scaffold exists yet. `BRIEF.md`
is the source of truth; read it in full before writing code. The notes below
capture the binding decisions so they aren't relitigated.

## What this is

**Psion Link** — a Chrome-only, local-first PWA that speaks the Psion Link
Protocol (PLP) over WebSerial, letting EPOC32-era Psion handhelds (Series 5,
5mx, Revo, netBook 7) be browsed and synced from a modern Chromebook/Chrome
machine with no drivers, native binaries, or cloud round-trip. The whole
product is file transfer + basic filesystem management (browse, up/download,
rename/delete, mkdir, device info).

## Tooling

**Use `bun` for everything — never `npm`/`node`/`npx`.**

- `bun install` — install deps
- `bun start` — dev server (`ng serve` via a bun script)
- `bun run build` — production bundle (`ng build`)
- `bun test` — protocol-core unit tests (pure TS, no Angular test runner)
- Angular CLI still drives build/serve/lint, but every invocation goes through
  `bun run <script>` or `bunx ng ...`, not `npm`/`npx`.

Run a single test file with `bun test path/to/file.test.ts`; filter by name
with `bun test -t "<pattern>"`.

**Stack:** Angular v22 (standalone components + Signals, `@angular/pwa`
service worker/manifest), Angular Material with the **Material 3 Expressive**
theme.

## Architecture — the load-bearing rule

The protocol core is **framework-free**. The three protocol layers below
(`link/`, `ncp/`, `rfsv/`) must **not import anything from `@angular/*`**. They
are plain TypeScript operating on the WebSerial `ReadableStream`/`WritableStream`,
independently unit-testable under `bun test` with no TestBed, zone.js, or DOM.

Angular touches the protocol core through exactly one seam: a thin injectable
`PsionLinkService` that owns the `SerialPort` handle, exposes connection state
as Signals, and adapts the core's async API to the UI. Keeping this line clean
is what preserves a future headless/CLI or ESP32-bridge variant. If you find
yourself importing Angular into a protocol layer, stop — the abstraction is
wrong.

## Protocol layers — build & test bottom-up

Each layer must be independently testable against fixture byte sequences before
the next is wired in. Build in this order:

1. **Physical** (WebSerial transport): 8N1, `flowControl: "hardware"`, autobaud
   `115200 → 57600 → 38400 → 19200 → 9600`. Raise DTR/RTS while active; monitor
   DSR to detect cable pull (`port.setSignals()` / `port.getSignals()`).
2. **Data link** (`link/`): SYN/DLE/STX framing, byte-stuffing, **CRC-16/XMODEM**
   (poly `0x1021`, init `0`, MSB first) over Cont/Seq+Data before stuffing,
   ARQ, and an explicit connection state machine
   (`Idle → Idle_Req → Idle_Ack → Data → Data_Ack`). Implement the **EPOC
   variant only** (multi-windowed, mod-2048 sequencing) — do not implement the
   SIBO single-window/mod-8 path. Get this layer exactly right first.
3. **Session** (`ncp/`): channel multiplexing + fragmentation. Channel 0 =
   control, channel 1 = `LINK`. Send an NCP Information frame with version
   `0x10` (EPOC ER5) on connect, then connect to `SYS$RFSV.*`.
4. **Presentation** (`rfsv/`): RFSV32 file service. Command
   `[reason:u16][opId:u16][data]` / reply `[0x11][opId:u16][status:u32][data]`;
   `opId` is a per-request nonce matched on reply. MVP command set (reasons,
   field encodings, and data contracts) is tabulated in `BRIEF.md` §4.4–5.

When the prose spec is ambiguous, treat **plptools**
(https://github.com/plptools/plptools — `ncpd`'s link state machine,
`rfsv32.cc`) as ground truth over the spec prose. Full PLP spec:
https://plptools.sourceforge.net/plp.html.

**Byte-layout warning:** several RFSV32 fields are easy to transpose between
16- and 32-bit (e.g. `RFSV32_READ_DIR` alignment padding). Copy field encodings
verbatim from the spec rather than reconstructing from memory. Strings are
2-byte length-prefixed EPOC-charset bytes (not NUL-terminated); the length
field's top bit flags Unicode.

## Scope discipline

Out of scope for v1, do not build unless asked: SIBO/Series 3 support, raw SSD
flash imaging, clipboard/print/registry/process-control servers, infrared,
Bluetooth prototypes, and the wireless/headless bridge. RS232-only, Chrome/
Chromium-only (including ChromeOS) — no Firefox/Safari fallback (WebSerial is
absent there).

## UI sensibility

Utility, not dashboard. Single-pane file browser with breadcrumb path,
drag-and-drop upload, and clear per-file **determinate** progress (transfers are
slow at 19200–115200 baud, so progress feedback matters). Quiet persistent
connection-status indicator (negotiated baud, device name/ROM) rather than a
modal. Zero telemetry, fully offline after load. Tighten M3 Expressive's default
density/typography deliberately rather than accepting framework defaults.
