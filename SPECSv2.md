# Psion Link — SIS Install (v2) Spec

**Status:** Scoping only — nothing below is implemented yet.
**Purpose:** Let Psion Link install a `.sis` package onto a connected EPOC32
device, picked from the local machine. This is a deliberate expansion beyond
BRIEF.md's v1 scope ("file transfer + basic filesystem management"); treat
this document the way BRIEF.md treats v1 — the source of truth for this
feature once work starts, refined as we learn more.

---

## 1. Goal & scope

Add an "Install SIS package…" action that: picks a local `.sis` file, parses
it, copies its contents onto the device via the RFSV32 primitives Psion Link
already has, and writes back the residual/uninstall-manifest file EPOC's own
installer would write.

### In scope (v2 MVP)

- Parsing the EPOC release 3–5 SIS format (our device set — Series 5, 5mx,
  Revo — is ER3–5; see §7 for the netBook 7/ER6 question).
- Single-language installs, or a language picker when a package offers more
  than one.
- Plain file copy (`FF`/standard files) to their destination paths.
- Writing the residual SIS manifest to `C:\System\Install\` so the file
  shows up in the device's own Control Panel → installed-app list.

### Explicitly out of scope (v2 MVP)

- **`FR` (run) file records** — files EPOC's installer executes on-device
  during/after install. We have no remote-execute primitive (RFSV32 doesn't
  offer one — see §2), so packages that rely on this can't fully install.
  Detect and fail clearly rather than silently skipping. plptools'
  `sisinstall` has the same limitation.
- **Embedded/recursive SIS components** (`0x02` file records — a SIS file
  containing another SIS file to install in turn).
- **Requisite/dependency enforcement** — parse and *display* what a package
  requires, but don't block install on it (we'd need to parse every residual
  file in `\System\Install\` and compare versions to enforce this properly;
  worth it later, not for MVP).
- **EPOC release 6 extensions** — larger header, zlib-compressed file data,
  capabilities/signature blocks. Detect and reject with a clear error rather
  than mis-parsing.
- **Uninstall.** Symmetric feature, separate scoping effort.

---

## 2. Why this doesn't need new protocol-layer work

This was the open question going in: does SIS install need a special
device-side RPC? No. plptools ships its own installer
(`sisinstall/sisinstaller.cpp`) and it works entirely client-side: it parses
the `.sis` format itself on the PC, then installs by calling the *exact same*
RFSV32 operations Psion Link's `RfsvClient` already implements —
`copyToPsion` (→ our `CreateFile`/`WriteFile`), `mkdir` (→ our `mkDirAll`),
and reading `C:\System\Install\` (→ our `listDir`) to see what's already
there. The device's installer engine is bypassed entirely; there is no
"install" command on the wire.

Practically: **no changes to `src/protocol/rfsv/` are needed.** This is a new
`src/protocol/sis/` module (SIS binary parsing, framework-free, `bun
test`-covered — same shape as `rfsv/readdir.ts`) plus a UI flow that drives
the existing `RfsvClient`.

## 3. Ground truth

There's no PLP-spec coverage of SIS at all — it's an application-layer
format, not part of the link/session/presentation protocol. Two sources,
cross-checked against each other:

- **Format bytes**: Alexander Thoukydides' SIS format doc
  (`https://thoukydides.github.io/riscos-psifs/sis.html`), written for the
  same PsiFS project the PLP spec itself came from. Treat as ground truth for
  field layout, same trust level BRIEF.md gives the PLP spec.
- **Install procedure**: plptools' `sisinstall/sisinstaller.cpp` — what a
  working implementation actually does, in what order, and what it
  deliberately doesn't handle (it also just fails on `FR`/embedded-SIS/ER6
  compression rather than supporting them — precedent for our own v2 MVP
  cuts above).

---

## 4. SIS file format (ER3–5, our target)

### 4.1 Header

| Offset | Bytes | Field |
|--------|-------|-------|
| `0x00` | 4 | UID1 — UID of the app being installed, or `0x10000000` if none |
| `0x04` | 4 | UID2 — **always `0x1000006D` for ER3/4/5** (`0x10003A12` on ER6 — the signal to detect and reject) |
| `0x08` | 4 | UID3 — always `0x10000419`. Together, UID2+UID3 are how you identify "this is a SIS file" when scanning a filesystem, not UID3 alone the way we do for regular documents (see `file-browser.ts`'s `KNOWN_APP_UIDS` — SIS needs its own check, not an entry in that table) |
| `0x0C` | 4 | UID4 — checksum-of-checksums (two CRC-16s over even/odd byte offsets) |
| `0x10` | 2 | Checksum — CRC-16 over the whole file excluding this field and any signature block |
| `0x12` | 2 | Number of languages |
| `0x14` | 2 | Number of files |
| `0x16` | 2 | Number of requisites |
| `0x1A` | 2 | Installation drive |
| `0x20` | 4 | Installer version |
| `0x24` | 2 | Options |
| `0x26` | 2 | Type |
| `0x30` | 4 | Languages pointer |
| `0x34` | 4 | Files pointer |
| `0x38` | 4 | Requisites pointer |
| `0x3C` | 4 | Certificates pointer |
| `0x40` | 4 | Component name pointer |

ER6 adds fields from `0x44` on (signature/capabilities/installed-space
pointers) — a header longer than expected past `0x40`, or UID2 ==
`0x10003A12`, is the reject signal for out-of-scope §1.

All pointers are byte offsets from the start of the file (or, for a SIS file
embedded inside another, from the start of *that* embedded file — relevant
only once embedded components are in scope).

### 4.2 Language records

At the Languages pointer: one 2-byte language code per language (e.g.
`0x0001` = UK English, `0x000A` = American English). Every per-language
string later in the file (component name, requisite names, file names) is
repeated once per language, **in this same order** — that's how a v2 MVP
language picker maps "language N" to "string variant N" everywhere else.

### 4.3 Requisite records

At the Requisites pointer, one record per requisite:

| Offset | Bytes | Field |
|--------|-------|-------|
| `0x00` | 4 | Required component's UID |
| `0x04` | 2 | Required major version |
| `0x06` | 2 | Required minor version |
| `0x08` | 4 | Variant |
| `0x0C` | 4×n | Requisite name length, one per language |
| `0x0C+4n` | 4×n | Requisite name pointer, one per language |

Display-only per §1 for MVP — parse and show, don't enforce.

### 4.4 File records

At the Files pointer, stored **in reverse of install order** (the doc is
explicit about this — reverse the list before processing). Each starts with
a 4-byte record type, then a 4-byte file type:

| File type | Meaning | v2 MVP handling |
|-----------|---------|------------------|
| `0x00` (FF) | Standard file | ✅ copy via `CreateFile`+`WriteFile` |
| `0x01` (FT) | Text to display during install | Parse, maybe show in the confirm dialog; don't block on it |
| `0x02` | Embedded SIS component | ❌ reject (§1) |
| `0x03` (FR) | Run during install/removal | ❌ reject (§1) — no remote-exec primitive |
| `0x04` (FN) | Doesn't exist yet; created when the app runs | Skip (nothing to copy) |
| `0x05` (FM) | Open file | Treat like standard for MVP unless real packages show otherwise |

Body (standard/multi-language file record):

| Offset | Bytes | Field |
|--------|-------|-------|
| `0x00` | 4 | File record type |
| `0x04` | 4 | File type (table above) |
| `0x08` | 4 | File details |
| `0x0C` | 4 | Source name length |
| `0x10` | 4 | Source name pointer |
| `0x14` | 4 | Destination name length |
| `0x18` | 4 | Destination name pointer |
| `0x1C` | 4×n | File length, one per language |
| `0x1C+4n` | 4×n | File data pointer, one per language |

If NC (no-compress) isn't set and this is ER6, file data is zlib-compressed
— another ER6 reject condition per §1, so v2 MVP never needs a decompressor.

### 4.5 Residual/uninstall file

After a real install, EPOC writes a truncated copy of the SIS file (header +
strings, file data stripped) to `C:\System\Install\<component>.sis`, with the
header's installed-language/installed-file-count/installed-drive fields
filled in. Reproducing this is what makes our install show up in the
device's own app list — worth getting byte-right even though nothing in our
own UI reads it back (yet).

---

## 5. Install procedure (client-driven, mirrors `sisinstaller.cpp`)

1. Parse the picked `.sis` file's header; reject on ER6/UID2 mismatch,
   embedded components present, or any `FR` file record — with a specific
   error message per reason, not a generic "unsupported file."
2. If more than one language: ask which one (§8 open question — UI shape
   TBD). Single-language packages skip the prompt.
3. Show a confirmation dialog: component name, UID1, version, requisites
   (informational), file count, total install size — before touching the
   device.
4. Reverse the file record list; for each `FF`/`FM` record, `mkDirAll` the
   destination directory (if needed) and copy the file's data via
   `CreateFile`+`WriteFile`, chunked the same way `rfsv/transfer.ts`'s
   `uploadFile` already does — reuse it rather than re-deriving chunking.
   Report progress through the existing `Transfer` panel UI
   (`file-browser.ts`), same as any other upload.
5. Write the residual manifest to `C:\System\Install\`.

---

## 6. UI

- **Anchor point**: an overflow menu (`mat-menu`, kebab `more_vert` icon)
  immediately to the right of the Connect/Disconnect button
  (`ConnectButton`, `src/app/connection-status/connect-button.html`) in the
  top toolbar — the user's explicit placement call. "Install SIS package…"
  is the first (only, for now) item.
- Menu item opens a native file picker restricted to `.sis`
  (`accept=".sis"` — `.sis` has no registered MIME type, so extension
  filtering is what we've got).
- Confirmation dialog (§5 step 3) before any device writes happen — same
  `MatDialog` pattern as `confirm-dialog.ts`/`text-prompt-dialog.ts`.
- Progress reuses the existing bottom-right transfer panel rather than
  inventing new progress UI.
- Disabled/hidden whenever `PsionLinkService.connectionState() !==
  'connected'`, matching how the rest of the toolbar already gates on
  connection state.

---

## 7. Open questions

- **netBook 7 = ER6?** If so, its SIS packages hit the ER6-reject path by
  design for v2 MVP — confirm this is acceptable, or whether ER6 support
  (decompression + extended header) should be pulled into v2 rather than
  deferred.
- **Language picker UX**: dropdown in the confirm dialog vs. a separate
  step? Low-stakes, decide when building.
- **Requisite enforcement**: confirmed out of MVP scope (§1) — revisit once
  there's a reason to (e.g. a package silently failing at runtime because a
  dependency was skipped).
- **Test fixtures**: parser tests need real (or hand-built) `.sis` byte
  fixtures. Hand-crafting a minimal valid header+one-file SIS by hand (per
  §4's tables) covers the parser's happy path; a couple of real small ER5
  freeware `.sis` files would be the better cross-check, sourced and vetted
  before committing them as test fixtures.
- **UID2/UID3 check**: worth confirming `0x1000006D`/`0x10000419` against an
  actual `.sis` file transferred to/from your Series 5, the same way the
  `KNOWN_APP_UIDS` table in `file-browser.ts` got verified against real
  hardware rather than trusted from docs alone.

---

## Appendix: key references

- SIS format: https://thoukydides.github.io/riscos-psifs/sis.html
- plptools' installer (reference implementation):
  https://github.com/plptools/plptools/tree/master/sisinstall
- BRIEF.md — v1 scope and the protocol layers this feature builds on top of,
  unchanged.
