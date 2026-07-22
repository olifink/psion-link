# Psion Link

A Chrome-only, local-first PWA that speaks the Psion Link Protocol (PLP)
over WebSerial, so EPOC32-era Psion handhelds (Series 5, 5mx, Revo,
netBook 7) can be browsed and synced from a modern Chromebook/Chrome
machine — no drivers, no native binaries, no cloud round-trip.

File transfer and basic filesystem management is the whole product: browse
drives/directories, upload/download, rename/delete, mkdir, device info.

See [`BRIEF.md`](./BRIEF.md) for the full handoff spec and [`CLAUDE.md`](./CLAUDE.md)
for the binding architecture decisions.

## Progress

**Protocol core** (`src/protocol/`, framework-free, built bottom-up — see CLAUDE.md):

- [x] **Physical** — `transport/`: WebSerial `SerialPort` wrapper, 8N1 +
      hardware flow control, autobaud rate table, DTR/RTS assertion, DSR
      cable-pull detection.
- [x] **Data link** — `link/`: SYN/DLE/STX framing + byte-stuffing +
      CRC-16/XMODEM (`crc16.ts`, `framing.ts`, `cont-seq.ts`), ARQ + EPOC
      connection state machine (`connection.ts`: `Idle → Idle_Req →
      connected`, windowed ARQ standing in for `Data ↔ Data_Ack` — see its
      doc comment). Byte layout and state transitions cross-checked
      against plptools' `lib/link.cc`/`datalink.cc` and the PLP spec's own
      "State Machine" section. Client/initiator role only — we never
      accept incoming connections.
- [x] **Session (NCP)** — `ncp/`: general frame codec + fragmentation/
      reassembly (`frame.ts`, `fragmentation.ts`), channel-multiplexing
      orchestration (`session.ts`: `NcpSession` sends the NCP Information
      frame, `connectToServer("SYS$RFSV")` opens a channel and hands back
      a pub/sub `NcpChannel`). Client/initiator role only, matching
      `LinkConnection`. Byte layout cross-checked against the PLP spec's
      "Session Layer" section and plptools' `lib/ncp.cc`/`linkchannel.cc`/
      `socketchannel.cc`. Two known gaps, documented in `session.ts`: no
      response to a peer-initiated `LINK.*` Connect request (open question
      against real hardware), and no Link Register fallback if a direct
      `SYS$RFSV.*` connect fails.
- [x] **End-to-end wiring** — `connection.ts`: `PlpConnection` pumps bytes
      between `WebSerialTransport` and `LinkConnection`, and payloads
      between `LinkConnection` and `NcpSession`; runs the BRIEF.md §4.1
      autobaud cascade (115200 → 9600) against a raw `SerialPort`; wires
      DSR cable-pull detection into session teardown. `connect(port)`
      resolves with an `NcpChannel` already connected to SYS$RFSV — the
      handoff point for the RFSV32 layer below. Integration-tested against
      a fake Psion peer built from the project's own encode/decode
      primitives (`connection.test.ts`), not mocked at the seam.
- [x] **Presentation (RFSV32)** — `rfsv/`: command/reply codec
      (`frame.ts`), EPOC-charset strings (`strings.ts`: Windows-1252 per
      the PLP spec's "Character Sets" section, with a Unicode/UTF-16LE
      path via the length field's top bit), 64-bit EPOC-epoch timestamps
      (`time.ts`), the `RFSV32_READ_DIR` batched multi-entry reply parser
      (`readdir.ts` — the exact alignment padding BRIEF.md §4.4 warns
      about, confirmed byte-for-byte against plptools' `RFSV32::readdir`),
      and `RfsvClient` (`client.ts`): opId-matched request/reply, MVP
      command set (drive list, volume info, open/read/close dir,
      open/create/read/write/close file, delete, rename, mkdir, rmdir,
      path test). No Link Register fallback, no `RFSV32_SEEK_FILE`/lock
      commands — out of scope for the MVP set BRIEF.md tabulates. Device
      timezone offset not applied to modification times (plptools'
      `PsiTime` does; would need a TZ-emulation port). Wired into
      `PlpConnection`: `getRfsvClient()` returns an `RfsvClient` bound to
      the SYS$RFSV channel once `connect()` resolves.

**Angular shell:**

- [x] Angular v22 workspace, standalone components + Signals, bun tooling
- [x] `@angular/pwa` (service worker + manifest)
- [x] Angular Material, M3 custom-theme Sass API (density/typography
      tuning toward Expressive still pending — see CLAUDE.md "UI sensibility")
- [x] `PsionLinkService` (`core/psion-link.service.ts`): the one seam onto
      the protocol core. `connect()` calls `navigator.serial.requestPort()`
      then drives a `PlpConnection` through it; `connectionState`,
      `negotiatedBaudRate`, `peer` (NCP Information frame), `lastError`,
      and `rfsv` (the connected `RfsvClient`) are all exposed as readonly
      Signals. `isSupported` feature-detects `'serial' in navigator` for
      the Chrome-only gate. Tested against the same fake-Psion-peer pattern
      as `connection.test.ts`, via `ng test`/Vitest rather than `bun test`
      since it's Angular-aware.
- [x] `ConnectionStatus` (`connection-status/`): the quiet persistent
      indicator CLAUDE.md's UI sensibility asks for — Connect button when
      disconnected, spinner while negotiating, baud rate + NCP peer
      version/id once connected, last failure reason inline. No modal.
- [x] `FileBrowser` (`file-browser/`): single-pane listing with a drive
      switcher, breadcrumb path, up/refresh/new-folder/upload toolbar
      actions, drag-and-drop upload, and a per-file determinate-progress
      panel (cancellable via `AbortSignal`) for both directions. Rename/
      delete go through small `MatDialog` prompts
      (`text-prompt-dialog.ts`/`confirm-dialog.ts`). Downloads save via a
      Blob/object-URL anchor click — no File System Access API dependency.
      Talks straight to `PsionLinkService.rfsv()`; no new state lives in
      `PsionLinkService` itself.
      Chunked transfer + EPOC path-syntax helpers
      (`rfsv/transfer.ts`, `rfsv/path.ts`) are framework-free and
      `bun test`-covered, same as the rest of the protocol core.

- [x] File-type conversion (`convert/`, SPECSv3.md): an on-by-default
      "Convert files on transfer" toggle (`OverflowMenu`, persisted via
      `SettingsService`) that, on download, converts recognized Psion
      formats to modern equivalents before saving — Word → Markdown
      (text only), Sketch → PNG, Record (voice memo) → WAV — falling back
      to the raw file with an inline notice if conversion fails. Files
      with no converter show a tooltip explaining why and are disabled
      for download while the toggle is on, rather than silently
      downloading unconverted. Upload direction isn't wired up yet:
      Markdown → Word doesn't exist. The
      three format decoders (`convert/word.ts`, `convert/sketch.ts`,
      `convert/record.ts`) plus a from-scratch PNG encoder
      (`convert/png.ts`, using the Web Compression Streams API so it
      works identically under `bun test` and in Chrome) are
      framework-free and `bun test`-covered, verified against real
      files pulled off a Series 5 (`examples/`) rather than trusted from
      documentation alone — this caught two real bugs: Record's
      "standard" codec is A-law-companded, not linear PCM, and Sketch's
      pixel data is embedded partway through its header, not after it.

**Hardware validation:**

- [x] End-to-end bring-up against a real Psion Series 5 over an FT232-based
      USB-RS232 adapter and a Chromebook (BRIEF.md §7's "hardware-in-the-loop"
      step): connect, drive/directory listing, up/download, rename/delete,
      mkdir all confirmed working. This surfaced two RFSV32 bugs invisible
      to the fixture-driven test suite — `RFSV32_OPEN_DIR`'s attribute DWORD
      is a filter mask (subdirectories need `Hidden|System|Directory`
      requested explicitly or the device omits them) and `RFSV32_MKDIR_ALL`
      requires a trailing path separator — both fixed and cross-checked
      against plptools' `lib/rfsv32.cc`.

## Tooling

Everything goes through `bun` — never `npm`/`node`/`npx`.

```bash
bun install       # install deps
bun start         # dev server (ng serve)
bun run build     # production bundle (ng build)
bun test          # protocol-core unit tests (pure TS, src/protocol only)
bunx ng test      # Angular component tests (Vitest)
```

Run a single protocol-core test file with `bun test path/to/file.test.ts`;
filter by name with `bun test -t "<pattern>"`.

## Architecture

The protocol core (`src/protocol/{transport,link,ncp,rfsv}`) is plain
TypeScript with no `@angular/*` imports, independently unit-testable under
`bun test` with no TestBed, zone.js, or DOM. Angular touches it through
exactly one seam — `PsionLinkService` — which owns the `SerialPort` handle
and adapts the core's async API to Signals for the UI. See CLAUDE.md for
why this line matters and what happens if it gets crossed.

## Scope

**v1**: EPOC32 only (Series 5, 5mx, Revo, netBook 7), Chrome/Chromium/ChromeOS
only, RS232 over USB-serial adapter. **Out of scope**: SIBO/Series 3,
raw SSD flash imaging, clipboard/print/registry/process-control servers,
infrared, Bluetooth, wireless/headless bridge. Full detail in `BRIEF.md` §1.

## References

- PLP spec: https://plptools.sourceforge.net/plp.html
- plptools (reference implementation): https://github.com/plptools/plptools
- WebSerial spec: https://wicg.github.io/serial/
