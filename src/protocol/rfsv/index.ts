/**
 * Presentation layer: RFSV32 file service. Command
 * `[reason:u16][opId:u16][data]` / reply `[0x11][opId:u16][status:u32][data]`,
 * `opId` a per-request nonce matched on reply. MVP command set (open/read
 * dir, open/create/read/write/close file, delete, rename, mkdir, rmdir,
 * path test, drive list, volume info) is tabulated in BRIEF.md §4.4-5.
 *
 * Framework-free: no `@angular/*` imports. See CLAUDE.md "Architecture".
 */
export {};
