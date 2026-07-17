# Psion Link — Project Brief

**Status:** Pre-implementation / handoff brief
**Owner:** Oliver
**Purpose:** A local-first PWA that speaks the Psion Link Protocol (PLP) over
WebSerial, so EPOC32-era Psion handhelds can be browsed and synced from a
modern Chromebook/Chrome machine without drivers, native binaries, or a
cloud round-trip.

---

## 1. Goal & scope

Build a Chrome-only PWA that can connect to an EPOC32 Psion over a standard
USB↔RS232 adapter and the original Psion serial cable, then:

- Browse drives and directories
- Download files to the local machine
- Upload files to the device
- Rename / delete files, create directories
- Read basic device info (machine type, ROM version, battery status)

### In scope (v1)

- **EPOC32 devices only**: Series 5, 5mx, Revo, netBook 7.
- **Chrome / Chromium only**, explicitly including ChromeOS. No Firefox/Safari
  fallback — WebSerial isn't implemented there, so don't spend effort on it.
- File transfer + basic filesystem management. That's the whole product.

### Explicitly out of scope (v1)

- SIBO / Series 3, 3a, 3c, 3mx, Siena support — different, less-documented
  protocol (`p3nfs`/NCP over SIBO Serial Protocol). Possible v2 if wanted,
  but treat as a separate protocol implementation, not a variant.
- Raw SSD flash imaging outside the device (ASIC4/5 hardware protocol) —
  unrelated problem, would need a hardware reader. Not attempted here.
  Reading files off an SSD *while it's inserted in the Psion* is just
  ordinary RFSV32 file access and **is** in scope.
- Clipboard server (`ClipBdServer`), printing (`WPRT`), registry access,
  process control (`RPCS` exec/stop/query) — not needed for a file
  sync/browse tool. Skip unless it turns out to be trivially cheap once the
  transport layer exists.
- Infrared. RS232-only.
- The Bluetooth prototypes — out of scope for this project.
- Wireless/headless bridge (ESP32/Pico + WebSocket) — good v2 if you want to
  reach a Psion that's not physically tethered to the Chromebook, but v1
  should nail direct WebSerial first.

---

## 2. Why this is tractable

Two independent things make this lower-risk than a cold reverse-engineering
project:

1. **The protocol is fully documented.** Alexander Thoukydides' PLP spec
   (originally hosted for the PsiFS project, mirrored at
   `plptools.sourceforge.net/plp.html`) gives byte-level frame formats, the
   CRC algorithm, the connection state machine, and every RFSV32/NCP command
   used by EPOC32 devices. This brief inlines the parts needed for the MVP
   below; go back to the source doc for anything not covered here.
2. **There's a living reference implementation.** `plptools`
   (https://github.com/plptools/plptools) is the direct descendant of the
   tool this spec was written to describe, still gets releases (1.0.26 as of
   mid-2026), and is what modern Linux users actually use to talk to these
   devices today. Treat it as ground truth for anything ambiguous in the
   prose spec — read `ncpd`'s link-layer state machine and `rfsv32.cc`
   directly when in doubt. The old defunct Java tool you remembered was
   almost certainly **JPL (Java Psion Link)** — same era, same problem
   (native serial extension bitrot), abandoned. Not a useful reference;
   don't chase it down.

---

## 3. Architecture

```
┌─────────────────────────────────────────────┐
│  PWA (Chrome / ChromeOS)                     │
│                                               │
│  Angular UI (standalone components, Signals, │
│  Material 3 Expressive — file browser,       │
│  transfer progress, connection status)       │
│         │                                    │
│  PsionLinkService (Angular-injectable,       │
│  thin adapter — owns SerialPort, exposes     │
│  Signals; the ONLY Angular-aware layer below │
│  the components themselves)                  │
│  ───────────────────────────────────────     │
│  ↓ everything below here is framework-free,  │
│    plain TS, unit-testable with `bun test`   │
│                                               │
│  RFSV32 client (open/read/write/dir/etc.)    │
│         │                                    │
│  NCP session layer (channels, fragmentation) │
│         │                                    │
│  PLP data link layer (frames, CRC, ARQ,      │
│  connection state machine)                   │
│         │                                    │
│  WebSerial transport (port.readable /        │
│  port.writable, baud, hardware flow control) │
└─────────────────────────────────────────────┘
              │  USB
     ┌────────┴────────┐
     │ USB↔RS232 adapter│  (FTDI/CP2102/CH340 + original Psion serial cable)
     └────────┬────────┘
              │  RS232, 8N1, hw flow control
        ┌─────┴─────┐
        │   Psion    │
        └───────────┘
```

No microcontroller in the data path for v1. WebSerial's `SerialOptions`
supports arbitrary numeric `baudRate` and `flowControl: "hardware"`, which
is everything the physical layer below needs.

**Framework: Angular v22**, standalone components + Signals, `@angular/pwa`
schematic for the service worker/manifest, Angular Material with the
**Material 3 Expressive** theme.

**Runtime/tooling: use `bun`, not `npm`/`node`, for everything** — install
deps (`bun install`), run the dev server (`bun start`, i.e. `ng serve`
invoked via a `bun` script), bundle for production (`bun run build`, i.e.
`ng build` under the hood), and run protocol-core unit tests with `bun
test` where they don't need Angular's own test runner. The Angular CLI
still drives build/serve/lint (`ng` commands), but every invocation goes
through `bun run <script>` / `bunx ng ...` rather than `npm`/`npx` — no
`node_modules` resolution surprises, no separate lockfile ecosystem.

**Protocol core stays framework-free.** This is the important architectural
line: `link/`, `ncp/`, and `rfsv/` (the three protocol layers from §4) must
not import anything from `@angular/*`. They're plain TypeScript modules
operating on the `ReadableStream`/`WritableStream` from the Web Serial API,
independently unit-testable under `bun test` with no TestBed, no zone.js,
no DOM. Angular consumes them through a thin injectable service (e.g.
`PsionLinkService`) that owns the WebSerial `SerialPort` handle, exposes
connection state as a `Signal`, and adapts the protocol core's async/
event-based API to whatever the UI layer wants. This separation is what
keeps the protocol layer portable if you ever want a headless/CLI or
ESP32-bridge variant later without dragging Angular along.

---

## 4. Protocol layers to implement, in order

Build and unit-test bottom-up. Each layer should be independently testable
against fixture byte sequences before wiring in the next.

### 4.1 Physical layer

- 8 data bits, 1 stop bit, no parity.
- Baud rate: autobaud by trying `115200 → 57600 → 38400 → 19200 → 9600` in
  sequence (this is literally what `ncpd` does, and what the state machine's
  `Timeout` handler in `Idle_Req_State` describes as "try next baud rate").
- DTR and RTS should be raised while the link is active; only DSR needs to
  be monitored to detect the cable being pulled. WebSerial exposes DTR/RTS
  via `port.setSignals()` and DSR via `port.getSignals()`.
- Use `flowControl: "hardware"`.

### 4.2 Data link layer ("Link")

This is the part worth getting exactly right before moving up — everything
above depends on framing being correct.

**Frame format:**

| Bytes | 1   | 1   | 1   | 1      |  | *n*  | 1   | 1   | 2   |
|-------|-----|-----|-----|--------|--|------|-----|-----|-----|
| Data  | SYN | DLE | STX | *Cont/Seq* | | *Data* | DLE | ETX | CRC |

- `Cont` = high nibble, `Seq` = low nibble of one byte. EPOC only (which is
  all we care about): if `Seq > 7`, an extra byte is inserted — this is the
  multi-windowed EPOC variant, don't bother implementing the SIBO
  single-window / mod-8 sequencing path.
- Data field: 0–300 bytes before byte-stuffing (2048 for the Ericsson R380
  variant — irrelevant to us).
- CRC is CRC-16/XMODEM (poly `0x1021`, init `0`), computed over
  *Cont/Seq + Data* **before** stuffing, transmitted MSB first.
- Byte stuffing: `DLE→DLE DLE`, `ETX→DLE EOT (0x10 0x04)` (EPOC variant).

**Special characters:** `STX=0x02, ETX=0x03, EOT=0x04, DLE=0x10, SYN=0x16`.

**PDU types** (`Cont` value): `0=Ack_Pdu`, `1=Disc_Pdu`, `2` with
`Seq∈{1..3}→Req_Req_Pdu` / `Seq∈{4..6}→Req_Con_Pdu` (EPOC connection
handshake), `3=Data_Pdu` (Seq = next sequence number, modulo 2048 for EPOC).

**Connection (EPOC variant):**

```
client → Req_Req_Pdu
server → Req_Con_Pdu (data = 4-byte magic number)
client → Ack_Pdu
```

**Data transfer:** `Data_Pdu` → `Ack_Pdu`, up to 8 outstanding frames
before an ack is required (multi-windowed). Retransmit up to 8 times before
giving up and disconnecting.

**Retransmission timeout** = `(13200 / baud)` seconds + ~0.2s round-trip
allowance. Inactivity timeout: 60s recommended.

Implement this as an explicit state machine
(`Idle → Idle_Req → Idle_Ack → Data → Data_Ack`) — the full transition
table is in the PLP spec §"State Machine" and is worth transcribing
directly into code comments or a design doc rather than re-deriving it.

### 4.3 Session layer (NCP)

- NCP frame: `[dest channel][src channel][frame type][data...]`.
- Channel 0 = control (XOFF/XON/Connect/ConnectResponse/Disconnect/
  NcpInfo/NcpTerminate). Channel 1 = `LINK` server (always connected first).
- Data frames are type `0x01` (Complete) or `0x02` (Partial) — NCP handles
  fragmenting messages larger than the data-link layer's frame limit.
- On connect, send an **NCP Information frame** with version `0x10` (EPOC
  ER5) — this is what selects EPOC-variant behavior in the servers above.
- Connect to `SYS$RFSV.*` (file service) via a **Connect frame**; if that
  fails, use the **Link Register command** on channel 1 to register it
  first, then retry.

### 4.4 Presentation layer — RFSV32 (file service)

EPOC32 command/reply framing:

```
Command: [reason:u16][opId:u16][request data...]
Reply:   [0x11][opId:u16][status:u32][reply data...]
```

`opId` is a per-request nonce you generate and match on the reply.

**MVP command set** (everything else in the spec can wait):

| Reason | Name | Purpose |
|--------|------|---------|
| `0x13` | `RFSV32_GET_DRIVE_LIST` | enumerate A:–Z: |
| `0x14` | `RFSV32_VOLUME` | drive info (size, free, label, media type) |
| `0x10` | `RFSV32_OPEN_DIR` | open a directory listing handle |
| `0x12` | `RFSV32_READ_DIR` | read entries (repeat until `E_EPOC_EOF`) |
| `0x16` | `RFSV32_OPEN_FILE` | open existing file |
| `0x29` | `RFSV32_CREATE_FILE` | create new file |
| `0x18` | `RFSV32_READ_FILE` | read bytes (cap ~2048/op) |
| `0x19` | `RFSV32_WRITE_FILE` | write bytes |
| `0x01` | `RFSV32_CLOSE_HANDLE` | close any handle |
| `0x1b` | `RFSV32_DELETE` | delete file |
| `0x1f` | `RFSV32_RENAME` | rename/move |
| `0x20` | `RFSV32_MK_DIR_ALL` | create directory |
| `0x21` | `RFSV32_RM_DIR` | remove directory |
| `0x2b` | `RFSV32_PATH_TEST` | existence check |

Field encodings, attribute flag bits, and exact reply layouts for each are
in PLP spec §"EPOC Command Frames" — copy them in verbatim rather than
reconstructing from memory, there are several easy-to-transpose-wrong
32-bit-vs-16-bit fields (e.g. `RFSV32_READ_DIR`'s alignment padding bytes).

Strings: 2-byte length prefix + EPOC-charset bytes, not NUL-terminated;
top bit of the length field flags Unicode.

---

## 5. Data contracts (draft — refine once the protocol layer exists)

```typescript
interface DriveInfo {
  letter: string;        // "C:"
  mediaType: MediaType;
  removable: boolean;
  sizeBytes: bigint;
  freeBytes: bigint;
  label: string;
  batteryStatus?: BatteryStatus;
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  modified: Date;
  attributes: FileAttributes;   // bitflags per RFSV32_READ_DIR
  uid?: [number, number, number]; // present only if requested with UID flag
}

interface DeviceInfo {
  machineType: MachineType;     // from NCP_GET_MACHINE_TYPE / MACHINE_INFO
  romVersion: string;           // "6.20 (xxx)" style, from major/minor/build
  displayWidth: number;
  displayHeight: number;
  batteryStatus: BatteryStatus;
}
```

---

## 6. UI / design notes

Same sensibility as Tranquil — calm, typography-driven, no unnecessary
chrome. This is a utility, not a dashboard: the file browser should feel
closer to a well-made Finder/Explorer pane than a "sync dashboard." Suggest:

- Single-pane file browser with breadcrumb path, drag-and-drop for
  upload, clear per-file transfer progress (PLP file transfer is slow by
  modern standards — 19200–115200 baud — so progress feedback matters more
  than it would for a modern tool).
- Persistent, quiet connection-status indicator (baud rate negotiated,
  device name/ROM version once known) rather than a modal — you'll be
  glancing at this a lot during a real sync session.
- Zero telemetry, works fully offline once loaded (standard `@angular/pwa`
  service-worker shell caching) — matches the rest of the Quiet Tech stack.
- **Material 3 Expressive**: lean on its dynamic color + expressive shape/
  motion tokens for personality (this is a nostalgia-tinged utility for a
  device people are fond of — a little warmth is appropriate) but keep
  density tight and information-forward; M3 Expressive's default spacing
  skews a bit loose for what's fundamentally a file manager. Worth an
  explicit density/typography pass rather than accepting Material defaults
  wholesale, in keeping with how deliberate the Tranquil and Folio design
  systems were about type and tokens rather than taking the framework's
  word for it.
- `mat-list` / `mat-tree` are the natural fit for the directory view;
  `mat-progress-bar` (determinate, since RFSV32 reads return known lengths)
  for transfers.

---

## 7. Testing strategy

- **Layer-by-layer unit tests under `bun test`**: CRC16 against known
  vectors, byte-stuffing/destuffing round-trips, state machine transitions
  driven by synthetic PDU sequences — all of this is pure logic, no
  hardware or even a browser needed.
- **Cross-check against plptools**: where the spec prose is ambiguous,
  build/run `ncpd` + `plpftp` from the GitHub repo against a real device
  and compare captured byte sequences (a USB-RS232 passthrough with a
  logging middle-man, or just cross-check behavior) to your implementation.
- **Hardware-in-the-loop**: pick one device (a Series 5 or 5mx is the most
  "reference" EPOC32 implementation) for primary bring-up before testing
  against the Revo/netBook 7/Bluetooth prototypes, since minor ROM/version
  differences are called out in the spec (`NCP_GET_MACHINE_TYPE`,
  `NCP Information frame` version field) as things implementations should
  branch on.

---

## 8. Open questions before/while building

- Do you want an escape hatch to raise the data-link frame size / read
  chunk size for speed, or stay conservative (2048 bytes/op, per spec
  recommendation) for compatibility across all your devices first, and
  optimize later once it's reliable?

---

## Appendix: key references

- PLP spec: https://plptools.sourceforge.net/plp.html
- plptools (reference implementation): https://github.com/plptools/plptools
- WebSerial spec: https://wicg.github.io/serial/
