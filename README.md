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
- [ ] **Data link** — `link/`: SYN/DLE/STX framing, byte-stuffing,
      CRC-16/XMODEM (done, `link/crc16.ts`), ARQ, EPOC connection state
      machine (`Idle → Idle_Req → Idle_Ack → Data → Data_Ack`).
- [ ] **Session (NCP)** — `ncp/`: channel multiplexing, fragmentation,
      NCP Information frame, connect to `SYS$RFSV.*`.
- [ ] **Presentation (RFSV32)** — `rfsv/`: file service commands (open/read
      dir, open/create/read/write/close file, delete, rename, mkdir, rmdir,
      path test, drive list, volume info).

**Angular shell:**

- [x] Angular v22 workspace, standalone components + Signals, bun tooling
- [x] `@angular/pwa` (service worker + manifest)
- [x] Angular Material, M3 custom-theme Sass API (density/typography
      tuning toward Expressive still pending — see CLAUDE.md "UI sensibility")
- [x] `PsionLinkService` seam stub (owns `SerialPort`, exposes connection
      state as Signals) — not yet wired to the protocol core
- [ ] File browser UI (breadcrumbs, drag-and-drop upload, per-file progress)
- [ ] Connection-status indicator

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
