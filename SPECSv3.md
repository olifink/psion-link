# Psion Link — File Conversion (v3) Spec

**Status:** Scoping only — nothing below is implemented yet.
**Purpose:** An opt-in, generic on-the-fly conversion between Psion-native
document formats and modern, ideally text-based equivalents, applied
transparently on upload and download. First target: Word ↔ Markdown
(text only). Second: Sketch → PNG. Third: Record (voice memo) → WAV.

---

## 1. Goal & scope

A toggle in the overflow menu — "Convert files on transfer" — that, when on,
transparently converts a recognized Psion format to/from a modern format at
transfer time:

- **Download**: a Word document lands on disk as `.md`; a Sketch drawing
  lands as `.png`; a Record voice memo lands as `.wav`.
- **Upload**: a `.txt` file gets written to the device as a native Word
  document (plain text only, no Markdown syntax parsing yet — see §4's
  "Update"). Neither Sketch nor Record has an upload-direction conversion
  in v3 — see §5, §6, §10.

When the toggle is off, downloads stay byte-identical and uploads are
completely unaffected either way — see §7 for why upload was deliberately
*not* made opt-in-restrictive the way download is (that was this doc's
original plan; revised once the toggle's default flipped to on).

### Priority order

1. **Word ↔ Markdown**, text only — no images, no embedded objects
   (explicitly per the ask). Read direction (Word → Markdown, i.e.
   download) first; write direction (Markdown → Word, upload) second — see
   §4.
2. **Sketch → PNG** (bitmap decode, download only — see §5 for why the
   reverse isn't scoped here).
3. **Record → WAV** (voice memos, download only — see §6).

---

## 2. Why this is tractable, and what's different from SPECSv2

Same shape as the SIS work: no protocol-layer changes, a new
framework-free, `bun test`-covered module, driven by a UI hook. One
difference worth flagging up front — **this doesn't reuse plptools as
ground truth**, because plptools has no opinion on document *contents*, only
on moving bytes. The reference here is **psiconv**
(`https://frodo.looijaard.name/project/psifiles`), an old but thorough
GPL project that fully reverse-engineered EPOC's Word, TextEd, Sketch, MBM,
Clip Art, Record, Sheet, Userdic, and World Data formats and converts them
to HTML/other formats. Its format *documentation* is ground truth, same
trust tier as the PLP spec and the SIS format doc SPECSv2 used — but its
*code* (C, GPL, designed as a native binary) isn't directly usable: this is
a Chrome-only PWA with no native binaries (per CLAUDE.md), so we need our
own pure-TypeScript reimplementation of just the parts we need, not a port.

**A useful cross-check that fell out of this research**: psiconv's docs give
Word's app UID3 as `0x1000007F`, Sketch's as `0x1000007D`, and Record's as
`0x1000007E` — exactly what the `KNOWN_APP_UIDS` table in `file-browser.ts`
already has, sourced independently from your real Series 5. Three
independent confirmations agreeing is a good sign the UID table is solid.

**A loose end worth understanding before coding, not blocking anything**:
Word's, Sketch's, *and* Record's file headers all use UID1 `0x10000037` /
UID2 `0x1000006D` per psiconv — the *exact* UID2 value SPECSv2 documented
as the SIS format's "this is ER3/4/5" marker. Showing up identically across
four otherwise-unrelated file kinds makes "generic EPOC3–5 structured-file
version marker" the likely explanation, with UID3 doing all the real type
discrimination — which is also exactly what we already do via
`KNOWN_APP_UIDS`, so this doesn't block anything. Still worth confirming
before writing a from-scratch section-table parser, so a stray assumption
doesn't creep in.

---

## 3. Architecture

- New top-level `src/convert/` (sibling to `src/protocol/` and `src/app/`
  — not under `protocol/`, since it doesn't touch the wire, but held to the
  same "framework-free, independently `bun test`-able" discipline as the
  rest of the non-UI code): `word.ts` (Word ↔ Markdown), `sketch.ts`
  (Sketch → RGBA pixel buffer), `record.ts` (Record → PCM samples),
  `index.ts`.
- **Hook points**: `file-browser.ts`'s `startDownload`/`uploadOne`. When the
  toggle is on and the entry's UID3 is in the known-convertible set, run
  the conversion after download / before upload, and reflect the
  *converted* filename in the existing `Transfer` progress panel (so
  "downloading LETTER" shows as `LETTER.md`, not the raw Psion name) —
  reuses the transfer UI SPECSv2 also leans on, no new progress UI.
- **PNG encoding needs no hand-rolled encoder.** This runs in a real
  browser, so once Sketch's raster data is decoded into an
  `ImageData`-shaped RGBA buffer, `<canvas>` (or `OffscreenCanvas`) +
  `toBlob('image/png')` does the actual PNG encoding for free. This
  meaningfully shrinks the Sketch half of the work down to "decode Psion's
  bitmap encoding into pixels," full stop.
- **WAV needs no encoder either — it's a container, not a codec.** Once
  Record's audio is decoded to raw PCM samples (§6), producing a `.wav` is
  just prepending a fixed 44-byte RIFF/WAVE/`fmt `/`data` header describing
  sample rate/bit depth/channel count ahead of those same bytes. The only
  real work in `record.ts` is the sample decode, not the WAV output.
- **Filename convention** (settled, §10): device files carry no extension
  at all — UID is the sole type identifier. Append `.md`/`.png`/`.wav`
  locally on download; strip it back off before writing to the device on
  upload.

---

## 4. Word ↔ Markdown

Per psiconv's `Word_File` doc:

- **Header**: the usual 4-UID pattern — UID1 `0x10000037` (shared
  structured-document header layout), UID2 `0x1000006D` (see §2's loose
  end), UID3 `0x1000007F` (Word, matches `KNOWN_APP_UIDS`), UID4 checksum.
- **Section table**, listing offsets to: Word Status, Word Styles, Page
  Layout, Text, Application ID (always present); Password, Text Layout
  (optional — Text Layout absent means "Normal" style throughout).
  Encrypted documents only encrypt the Text Section itself.
- **Text Section**: the actual document text — psiconv describes it simply
  as "a list of ASCII codes," i.e. plain bytes, presumably with paragraph
  breaks as specific control characters (not yet confirmed — see §10).
- **Formatting**: applied via separate paragraph/character layer(s)
  referencing byte ranges within the Text Section (style name → heading
  level/list, character attributes → bold/italic). **The exact byte layout
  of these layers wasn't pinned down in this scoping pass** — psiconv's
  docs cover them on pages not yet fetched. This is the one piece of real
  implementation risk in the Word half; needs a dedicated research pass
  (and/or real sample `.wrd`-ish files off your device) before coding
  starts, same spirit as SPECSv2's "need real SIS fixtures" note.

**Sequencing**: build read-direction (Word → Markdown) first — most
immediately useful (reading old documents on a modern machine), lower risk
(only need to interpret the format, not reproduce it byte-valid), and it's
what validates the layer-parsing research above. Write-direction (Markdown
→ Word) is bounded but requires constructing every mandatory section from
scratch — real but self-contained work, sequenced as phase two of v3, not
deferred to a later spec.

**Update**: a plain-text (not yet Markdown-syntax-aware) write direction
now exists — `word.ts`'s `textToWord()` — confirmed opening correctly on a
real Series 5. It sidesteps needing the Word Status/Styles/Page Layout
section formats reverse-engineered from scratch: it copies them verbatim
from a real template Word file (one actually created by the on-device Word
app — an old pre-installed document turned out to have a much sparser
Word Styles Section and crashed the app) and only replaces the Text
Section, patching one documented Word Status field (the saved cursor
offset, psiconv's `Word_Status_Section` doc) that would otherwise point
at an invalid position once the Text Section's content changes underneath
it. Actual Markdown syntax parsing (`#`/`**`/lists → paragraph/character
layers) is still not attempted.

Markdown constructs with no Word equivalent (tables, code fences, images —
mostly moot anyway since this is text-only per the ask) should flatten to
plain text or fail with a clear error on upload, not silently mangle.

---

## 5. Sketch → PNG

Per psiconv's `Sketch_File`/`Sketch_Section` docs:

- **Header**: same 4-UID shape, UID3 `0x1000007D` (Sketch, matches
  `KNOWN_APP_UIDS`).
- **Sketch Section is bitmap-based, not vector** — confirmed structure:
  as-displayed width/height, the picture's offset within the displayed
  area, and offset/size within a larger "form," plus magnification/cut
  fields psiconv explicitly notes "the Sketch program does not read...
  only used for sketch objects" (skip these for v3 — always render at
  native size).
- **Actual pixel encoding (bit depth, palette, row alignment, any
  compression) is the other real research gap.** Sketch's raster data very
  likely reuses EPOC's general bitmap primitive (the same one behind MBM/
  icons — psiconv's `MBM_File` doc confirms MBM is "a special picture
  format" with a jump table to per-image "Paint Data Sections," but the
  pixel-level detail lives on a page not yet fetched). Needs the same kind
  of dedicated pass as Word's layers before coding.
- **Output**: decode into an RGBA (or greyscale — Series 5's LCD was
  monochrome/greyscale, so the source is plausibly 2–4 bits/pixel) pixel
  buffer, hand to Canvas per §3. No hand-rolled PNG encoder needed.

**PNG → Sketch (upload direction) is explicitly not scoped for v3.** The
ask was one-directional ("Sketch files to a standard web format like
PNG"), and going raster PNG back into a low-bit-depth greyscale Psion
format is a materially different, lower-value problem (dithering/
quantization decisions) than decode-only. Flagged as an open question in
§10 rather than assumed either way.

---

## 6. Record → WAV

Per psiconv's `Record_File`/`Record_Section` docs — the best-understood of
the three formats in this spec, and genuinely simple once decoded:

- **Header**: same 4-UID shape as Word/Sketch — UID1 `0x10000037`, UID2
  `0x1000006D` (§2), UID3 `0x1000007E` (Record, matches
  `KNOWN_APP_UIDS`) — and the doc notes "both alarm sounds and normal
  record files use the same file format," so this covers both cleanly.
- **Record Section fields**: repeat count minus one, inter-repeat delay (in
  microseconds), a volume setting (1–5), a codec-selector field, and the
  actual sample data as a length-prefixed byte list ("LListB").
- **Two codecs, selected by that codec field**: "standard compression" —
  described as "(about) 8.3 kHz 8-bit sampling," i.e. plain 8-bit PCM, no
  decoding needed at all beyond reading the bytes — or ADPCM, flagged by a
  distinct codec UID in that field. **ADPCM needs an actual decoder**
  (well-documented, standard algorithm — not a research gap the way Word's
  layers or Sketch's pixel encoding are, just implementation work); decode
  it to PCM rather than trying to preserve ADPCM inside the WAV container,
  so every output file is maximally compatible regardless of source codec.
- **Output**: standard-mode files are close to a straight byte-copy into a
  WAV `data` chunk; ADPCM-mode files get decoded to PCM first. Either way,
  §3's WAV-is-just-a-container point means the actual file-writing side is
  trivial once decode is done.

**MP3 is explicitly not committed for v3**, despite being asked for "if
possible." WAV needs no encoder (§3); MP3 does — either a from-scratch
encoder (real effort, arguably disproportionate for a personal utility) or
an external library dependency, which is a bigger call than anything else
in this project so far (everything to date has been built from spec/docs,
no runtime dependencies beyond Angular/Material). Flagged as an open
question in §10 rather than assumed either way; WAV alone is a complete,
useful v3 MVP for this format.

---

## 7. UI

- The overflow menu SPECSv2 introduced next to `ConnectButton`
  (`src/app/connection-status/connect-button.html`) gets a second item: a
  toggle, "Convert files on transfer" (§10 — **on by default**, revised
  from this doc's original "off" once the feature shipped and proved
  useful enough to want on unprompted). Persisted (e.g. `localStorage`)
  as a standing preference, not a one-off action.
- Angular Material detail worth flagging now rather than discovering it
  mid-build: a toggle control inside a `mat-menu-item` needs
  `(click)="$event.stopPropagation()"` on the toggle itself, or clicking it
  closes the menu along with toggling it — minor, but worth remembering.
- **Revised from this doc's original plan: upload is *not* restricted
  while the toggle is on.** The original idea was to scope the file
  picker/drag-and-drop to only accept convertible formats and grey out
  everything else, written back when the toggle defaulted off. Once it
  defaulted on (§10), that would have meant *most uploads get blocked by
  default* — this file browser's core job is general file management, and
  conversion is an opt-in nicety layered on top of a `.txt` special case,
  not the point of uploading in general. Shipped behavior instead: `.txt`
  files convert to Word documents (via `word.ts`'s `plainTextToWord`,
  using a bundled template file's Word Status/Styles/Page Layout/
  Application ID sections — see that function's doc comment for why a
  template exists at all — fetched once per session from
  `public/templates/word-template.wrd`, cached); everything else uploads
  exactly as it did before this feature existed, toggle or no toggle.
- Conversion failure (malformed file, unsupported layer feature) falls back
  to the raw/unconverted transfer with an inline notice, rather than
  blocking the transfer outright — matches the existing
  `errorMessage()`/`lastError()` "surface, don't dead-end" pattern already
  used throughout `file-browser.ts`.

---

## 8. Testing strategy

- Fixture-driven `bun test` coverage, same shape as `rfsv/readdir.ts` and
  the SIS parser SPECSv2 scoped.
- **Real fixtures already exist**: `examples/` now has two real files off a
  black-and-white Series 5 — a German Word document ("Willkommen zum Serie
  5," Psion's own bundled welcome doc) and a Sketch drawing ("My Sketch").
  More can be added as needed (a Series 7 Sketch is next in line, to cover
  color — the Series 5's is monochrome). A quick header check against both
  confirms the format assumptions in §4/§5 are on solid ground: both files'
  UID1–4 bytes match psiconv's documented constants exactly
  (`10000037`/`1000006D`/UID3/checksum), and the Word file's Text Section
  does contain plain bytes in the expected charset — spot-checked a German
  sentence including a `0xAE` (®) byte decoding correctly mid-word. The
  real remaining work — Word's paragraph/character layer byte layout and
  Sketch's pixel encoding (§10) — is exactly that: reverse-engineering
  against these two files once we start building, not further scoping.
- For Record specifically, once we have any fixtures at all: ideally one
  per codec (standard 8-bit and ADPCM), if the device's Record app lets you
  pick, so both decode paths get exercised.
- Word round-trip (once write-direction exists): parse real file →
  Markdown → back to Word bytes → compare via a second parse pass, not an
  exact byte match. Re-serialized layer tables don't need to be
  byte-identical to the original, only semantically equivalent.

---

## 9. Explicitly out of scope for v3

- Images/embedded objects inside Word documents (e.g. a Sketch object
  embedded in a Word doc) — text only, per the ask.
- Any other built-in format (Sheet, Agenda, Data, Comms, Calc). Word,
  Sketch, and Record only. Sheet → CSV is an obvious, low-effort v4+
  candidate once this pattern is proven — noted, not scoped.
- PNG → Sketch (upload-direction image conversion) — see §5.
- MP3 output for Record — see §6.

---

## 10. Open questions — resolved

1. **Default toggle state: off**, confirmed at the time — **later revised
   to on by default**, once the shipped feature (download-direction
   conversion, disabled/tooltip'd UI for unsupported types) proved useful
   enough in daily use to want it active without opting in each time.
   Additionally: while on, the upload side should only accept supported
   source formats and grey out/disable anything else, rather than
   silently uploading unconverted files under a misleading "conversion is
   on" state — folded into §7 (still not implemented — no upload-side
   converter exists yet).
2. **Filename/extension convention: device files carry no extension at
   all** — UID is the sole type identifier, confirmed. So: append the
   appropriate extension (`.md`/`.png`/`.wav`) locally on download, and
   **strip it back off on upload** before writing to the device (a `.md`
   file uploads to the device with no extension, matching how the device
   itself names things) — updates §3's filename-convention note from open
   question to settled behavior.
3. **Fixtures**: real files now exist in `examples/`, more available on
   request (e.g. a Series 7 Sketch for color) — see §8. This doesn't close
   the byte-layout research gaps below by itself, but it's what unblocks
   closing them once we start building, rather than guessing from docs
   alone.
4. **The UID2 `0x1000006D` coincidence** (§2): **tbd**, left open — doesn't
   block anything either way.
5. **PNG → Sketch** (and any other upload-direction image path): **could
   be interesting in a future phase**; decode-only is confirmed sufficient
   for v3.
6. **MP3 for Record**: **not needed** — WAV is sufficient. No new
   dependency, no MP3 encoder.

**Still genuinely open, not yet answered by the above**: Word's paragraph/
character layer byte layout and Sketch's pixel encoding (bit depth/
palette/compression) — the two real implementation-risk items in §4/§5.
Not a scoping question anymore so much as the actual next work item, now
that real fixtures exist to reverse-engineer against.

---

## Appendix: key references

- psiconv file format docs (ground truth for this spec):
  https://frodo.looijaard.name/project/psifiles
- psiconv project itself (reference implementation only — GPL C, not
  portable to a browser as-is): https://software.old.frodo.looijaard.name/psiconv/
- SPECSv2.md — shares this spec's UI anchor point (the overflow menu next
  to `ConnectButton`) and its "framework-free, `bun test`-covered module"
  architecture pattern.
