import { Component, computed, effect, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import {
  DriveListEntry,
  RfsvClient,
  RfsvDirEntry,
  downloadFile,
  driveRootPath,
  isDriveRoot,
  joinEpocPath,
  listPattern,
  parentPath,
  pathSegments,
  uploadFile,
} from '../../protocol';
import { PsionLinkService } from '../core/psion-link.service';
import { formatBytes, formatDateTime } from '../shared/format';
import { ConfirmDialog } from './confirm-dialog';
import { TextPromptDialog } from './text-prompt-dialog';

export interface Transfer {
  id: number;
  name: string;
  direction: 'upload' | 'download';
  bytesTransferred: number;
  totalBytes: number;
  status: 'active' | 'done' | 'error';
  error?: string;
  controller: AbortController;
}

let nextTransferId = 0;

function compareEntries(a: RfsvDirEntry, b: RfsvDirEntry): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * EPOC identifies a file's type via UID3 (the owning application's UID)
 * rather than (just) its extension. Sourced from a real Series 5's
 * \System listing rather than guessed from incomplete public docs —
 * extend as more get confirmed. 0x1000007D is Sketch, not Paint;
 * 0x1000007E is Record (voice memos), not Data.
 */
const KNOWN_APP_UIDS: Record<number, string> = {
  0x10000076: 'SHELL',
  0x1000007d: 'Sketch',
  0x1000007e: 'Record',
  0x1000007f: 'Word',
  0x10000080: 'TimeW',
  0x10000083: 'Calc',
  0x10000084: 'Agenda',
  0x10000085: 'Program',
  0x10000086: 'Data',
  0x10000087: 'Comms',
  0x10000088: 'Sheet',
};

const APP_ICONS: Record<string, string> = {
  Word: 'description',
  Sheet: 'table_chart',
  Record: 'mic',
  Data: 'storage',
  Agenda: 'event',
  Sketch: 'brush',
  Calc: 'calculate',
  Comms: 'call',
};

/** UID3 as hex, for the tooltip — always available regardless of whether we recognize it. */
function formatUid(entry: RfsvDirEntry): string {
  return entry.uid ? hex32(entry.uid[2]) : '';
}

/** Friendly app name when UID3 is recognized, otherwise the raw hex UID3 as a fallback. */
function fileTypeLabel(entry: RfsvDirEntry): string {
  if (!entry.uid) {
    return '';
  }
  return KNOWN_APP_UIDS[entry.uid[2]] ?? hex32(entry.uid[2]);
}

function fileIcon(entry: RfsvDirEntry): string {
  if (entry.isDirectory) {
    return 'folder';
  }
  const label = entry.uid ? KNOWN_APP_UIDS[entry.uid[2]] : undefined;
  return (label && APP_ICONS[label]) || 'insert_drive_file';
}

function saveBlobAsFile(data: Uint8Array, name: string): void {
  // `data` may be typed `Uint8Array<ArrayBufferLike>`; Blob wants a concrete `ArrayBuffer`-backed view.
  const blob = new Blob([new Uint8Array(data)]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * The single-pane file browser (CLAUDE.md "UI sensibility"): breadcrumb
 * path, drag-and-drop upload, per-file determinate progress. Talks
 * directly to the `RfsvClient` exposed by `PsionLinkService.rfsv()` — the
 * one seam onto the framework-free protocol core.
 */
@Component({
  selector: 'app-file-browser',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatProgressBarModule, MatTooltipModule],
  templateUrl: './file-browser.html',
  styleUrl: './file-browser.scss',
})
export class FileBrowser {
  protected readonly psionLink = inject(PsionLinkService);
  private readonly dialog = inject(MatDialog);

  protected readonly formatBytes = formatBytes;
  protected readonly formatDateTime = formatDateTime;
  protected readonly formatUid = formatUid;
  protected readonly fileTypeLabel = fileTypeLabel;
  protected readonly fileIcon = fileIcon;

  protected readonly drives = signal<DriveListEntry[]>([]);
  protected readonly currentDrive = signal<string | null>(null);
  protected readonly currentPath = signal<string | null>(null);
  protected readonly entries = signal<RfsvDirEntry[]>([]);
  protected readonly loading = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly dragActive = signal(false);
  protected readonly transfers = signal<Transfer[]>([]);

  protected readonly presentDrives = computed(() => this.drives().filter((drive) => drive.present));
  protected readonly breadcrumbs = computed(() => {
    const path = this.currentPath();
    return path === null ? [] : pathSegments(path);
  });
  protected readonly canGoUp = computed(() => {
    const path = this.currentPath();
    return path !== null && !isDriveRoot(path);
  });

  constructor() {
    effect(() => {
      const client = this.psionLink.rfsv();
      if (client) {
        void this.onConnected(client);
      } else {
        this.reset();
      }
    });
  }

  private reset(): void {
    this.drives.set([]);
    this.currentDrive.set(null);
    this.currentPath.set(null);
    this.entries.set([]);
    this.errorMessage.set(null);
    this.transfers.set([]);
  }

  private async onConnected(client: RfsvClient): Promise<void> {
    try {
      const drives = await client.getDriveList();
      this.drives.set(drives);
      const first = drives.find((drive) => drive.present);
      if (first) {
        await this.selectDrive(first.letter);
      }
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    }
  }

  protected async selectDrive(letter: string): Promise<void> {
    this.currentDrive.set(letter);
    await this.navigateTo(driveRootPath(letter));
  }

  protected async navigateTo(path: string): Promise<void> {
    const client = this.psionLink.rfsv();
    if (!client) {
      return;
    }
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const entries = await client.listDir(listPattern(path));
      entries.sort(compareEntries);
      this.currentPath.set(path);
      this.entries.set(entries);
    } catch (err) {
      this.errorMessage.set(`Couldn't list ${path}: ${(err as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  protected open(entry: RfsvDirEntry): void {
    const path = this.currentPath();
    if (path === null) {
      return;
    }
    if (entry.isDirectory) {
      void this.navigateTo(joinEpocPath(path, entry.name));
    } else {
      void this.startDownload(entry);
    }
  }

  protected goUp(): void {
    const path = this.currentPath();
    if (path !== null) {
      void this.navigateTo(parentPath(path));
    }
  }

  protected refresh(): void {
    const path = this.currentPath();
    if (path !== null) {
      void this.navigateTo(path);
    }
  }

  protected async newFolder(): Promise<void> {
    const client = this.psionLink.rfsv();
    const path = this.currentPath();
    if (!client || path === null) {
      return;
    }
    const name = await firstValueFrom(
      this.dialog
        .open(TextPromptDialog, {
          data: { title: 'New folder', label: 'Folder name', confirmLabel: 'Create' },
        })
        .afterClosed(),
    );
    if (!name) {
      return;
    }
    try {
      await client.mkDirAll(joinEpocPath(path, name));
      this.refresh();
    } catch (err) {
      this.errorMessage.set(`Couldn't create folder: ${(err as Error).message}`);
    }
  }

  protected async rename(entry: RfsvDirEntry): Promise<void> {
    const client = this.psionLink.rfsv();
    const path = this.currentPath();
    if (!client || path === null) {
      return;
    }
    const name = await firstValueFrom(
      this.dialog
        .open(TextPromptDialog, {
          data: {
            title: `Rename ${entry.name}`,
            label: 'New name',
            initialValue: entry.name,
            confirmLabel: 'Rename',
          },
        })
        .afterClosed(),
    );
    if (!name || name === entry.name) {
      return;
    }
    try {
      await client.rename(joinEpocPath(path, entry.name), joinEpocPath(path, name));
      this.refresh();
    } catch (err) {
      this.errorMessage.set(`Couldn't rename ${entry.name}: ${(err as Error).message}`);
    }
  }

  protected async deleteEntry(entry: RfsvDirEntry): Promise<void> {
    const client = this.psionLink.rfsv();
    const path = this.currentPath();
    if (!client || path === null) {
      return;
    }
    const confirmed = await firstValueFrom(
      this.dialog
        .open(ConfirmDialog, {
          data: {
            title: entry.isDirectory ? 'Delete folder' : 'Delete file',
            message: `Delete "${entry.name}" from the device? This can't be undone.`,
          },
        })
        .afterClosed(),
    );
    if (!confirmed) {
      return;
    }
    try {
      const fullPath = joinEpocPath(path, entry.name);
      if (entry.isDirectory) {
        await client.rmDir(fullPath);
      } else {
        await client.deleteFile(fullPath);
      }
      this.refresh();
    } catch (err) {
      this.errorMessage.set(`Couldn't delete ${entry.name}: ${(err as Error).message}`);
    }
  }

  private async startDownload(entry: RfsvDirEntry): Promise<void> {
    const client = this.psionLink.rfsv();
    const path = this.currentPath();
    if (!client || path === null) {
      return;
    }
    const controller = new AbortController();
    const transfer: Transfer = {
      id: nextTransferId++,
      name: entry.name,
      direction: 'download',
      bytesTransferred: 0,
      totalBytes: entry.sizeBytes,
      status: 'active',
      controller,
    };
    this.transfers.update((list) => [...list, transfer]);
    try {
      const data = await downloadFile(client, joinEpocPath(path, entry.name), entry.sizeBytes, {
        signal: controller.signal,
        onProgress: (p) => this.updateTransfer(transfer.id, { bytesTransferred: p.bytesTransferred, totalBytes: p.totalBytes }),
      });
      this.updateTransfer(transfer.id, { status: 'done', bytesTransferred: data.length });
      saveBlobAsFile(data, entry.name);
    } catch (err) {
      this.updateTransfer(transfer.id, { status: 'error', error: (err as Error).message });
    }
  }

  protected async uploadFiles(files: FileList | File[]): Promise<void> {
    const client = this.psionLink.rfsv();
    const path = this.currentPath();
    if (!client || path === null) {
      return;
    }
    for (const file of Array.from(files)) {
      await this.uploadOne(client, path, file);
    }
    this.refresh();
  }

  private async uploadOne(client: RfsvClient, path: string, file: File): Promise<void> {
    const controller = new AbortController();
    const transfer: Transfer = {
      id: nextTransferId++,
      name: file.name,
      direction: 'upload',
      bytesTransferred: 0,
      totalBytes: file.size,
      status: 'active',
      controller,
    };
    this.transfers.update((list) => [...list, transfer]);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await uploadFile(client, joinEpocPath(path, file.name), data, {
        signal: controller.signal,
        onProgress: (p) => this.updateTransfer(transfer.id, { bytesTransferred: p.bytesTransferred, totalBytes: p.totalBytes }),
      });
      this.updateTransfer(transfer.id, { status: 'done' });
    } catch (err) {
      this.updateTransfer(transfer.id, { status: 'error', error: (err as Error).message });
    }
  }

  private updateTransfer(id: number, patch: Partial<Transfer>): void {
    this.transfers.update((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  protected cancelTransfer(transfer: Transfer): void {
    transfer.controller.abort();
  }

  protected dismissTransfer(transfer: Transfer): void {
    this.transfers.update((list) => list.filter((t) => t.id !== transfer.id));
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragActive.set(true);
  }

  protected onDragLeave(): void {
    this.dragActive.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragActive.set(false);
    if (event.dataTransfer?.files.length) {
      void this.uploadFiles(event.dataTransfer.files);
    }
  }

  protected onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) {
      void this.uploadFiles(input.files);
      input.value = '';
    }
  }
}
