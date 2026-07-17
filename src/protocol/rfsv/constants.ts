/**
 * RFSV32 reason codes (EPOC command frames), BRIEF.md §4.4 + PLP spec
 * §"Presentation Layer" / "EPOC Command Frames". Only the MVP command set
 * BRIEF.md tabulates is implemented; the rest of the spec's RFSV32_*
 * reasons are out of scope for now.
 */
export enum RfsvReason {
  CloseHandle = 0x01,
  OpenDir = 0x10,
  ReadDir = 0x12,
  GetDriveList = 0x13,
  Volume = 0x14,
  OpenFile = 0x16,
  ReadFile = 0x18,
  WriteFile = 0x19,
  Delete = 0x1b,
  Rename = 0x1f,
  MkDirAll = 0x20,
  RmDir = 0x21,
  CreateFile = 0x29,
  PathTest = 0x2b,
}

/** PLP spec: the reply marker is a 2-byte word, not a single byte. */
export const RFSV_REPLY_MARKER = 0x11;

/**
 * EPOC error codes (PLP spec §"Error Codes" / §"EPOC Error Codes").
 * Status fields are signed 32-bit; 0 is success, negative values are
 * errors. Cross-checked against plptools' `rfsv.h` (`RFSV::errs`).
 */
export enum EpocStatus {
  None = 0,
  NotFound = -1,
  General = -2,
  Cancel = -3,
  NoMemory = -4,
  NotSupported = -5,
  Argument = -6,
  TotalLossOfPrecision = -7,
  BadHandle = -8,
  Overflow = -9,
  Underflow = -10,
  AlreadyExists = -11,
  PathNotFound = -12,
  Died = -13,
  InUse = -14,
  ServerTerminated = -15,
  ServerBusy = -16,
  Completion = -17,
  NotReady = -18,
  Unknown = -19,
  Corrupt = -20,
  AccessDenied = -21,
  Locked = -22,
  Write = -23,
  Dismounted = -24,
  Eof = -25,
  DiskFull = -26,
  BadDriver = -27,
  BadName = -28,
  CommsLineFail = -29,
  CommsFrame = -30,
  CommsOverrun = -31,
  CommsParity = -32,
  Timeout = -33,
  CouldNotConnect = -34,
  CouldNotDisconnect = -35,
  Disconnected = -36,
  BadLibraryEntryPoint = -37,
  BadDescriptor = -38,
  Abort = -39,
  TooBig = -40,
  DivideByZero = -41,
  BadPower = -42,
  DirFull = -43,
}

/** PLP spec §"RFSV32_READ_DIR": file attribute flags (also used by SET_ATT/ATT). */
export enum FileAttribute {
  ReadOnly = 0x0001,
  Hidden = 0x0002,
  System = 0x0004,
  Directory = 0x0010,
  Archive = 0x0020,
  VolumeLabel = 0x0040,
  Normal = 0x0080,
  Temporary = 0x0100,
  Compressed = 0x0800,
}

/**
 * Request-only flag for RFSV32_OPEN_DIR: populate UID1-3 in RFSV32_READ_DIR
 * replies. plptools' `fopendir()` always ORs this in.
 */
export const ATTR_GET_UID = 0x10000000;

/** PLP spec §"RFSV32_OPEN_FILE": sharing mode, OR'd with a stream type and optional flags. */
export enum OpenShareMode {
  Exclusive = 0x0000,
  ShareRead = 0x0001,
  ShareAny = 0x0002,
}

export enum OpenStreamType {
  Binary = 0x0000,
  Text = 0x0020,
}

export const OPEN_READ_WRITE = 0x0200;

/** PLP spec §"RFSV32_VOLUME": Media type field. */
export enum MediaType {
  NotPresent = 0,
  Unknown = 1,
  Floppy = 2,
  HardDisk = 3,
  CdRom = 4,
  Ram = 5,
  FlashDisk = 6,
  Rom = 7,
  Remote = 8,
}

/** PLP spec §"RFSV32_VOLUME": Battery status field. */
export enum BatteryStatus {
  Dead = 0,
  VeryLow = 1,
  Low = 2,
  Good = 3,
}

/** PLP spec §"RFSV32_VOLUME": Drive attributes flags. */
export enum DriveAttribute {
  Local = 0x01,
  Rom = 0x02,
  Redirected = 0x04,
  Substituted = 0x08,
  Internal = 0x10,
  Removable = 0x20,
}

/** PLP spec §"RFSV32_VOLUME": Media attributes flags. */
export enum MediaAttribute {
  VariableSize = 0x01,
  DualDensity = 0x02,
  Formattable = 0x04,
  WriteProtected = 0x08,
}

/** BRIEF.md §4.4 / PLP spec: recommended (not enforced) max bytes per READ_FILE/WRITE_FILE op. */
export const RFSV_RECOMMENDED_TRANSFER_SIZE = 2048;
