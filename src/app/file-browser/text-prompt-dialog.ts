import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export interface TextPromptDialogData {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
}

/** A single-field text prompt, used for "new folder" and "rename". */
@Component({
  selector: 'app-text-prompt-dialog',
  imports: [MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="text-prompt-dialog__field">
        <mat-label>{{ data.label }}</mat-label>
        <input matInput [value]="value()" (input)="onInput($event)" (keydown.enter)="submit()" />
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="!value().trim()" (click)="submit()">
        {{ data.confirmLabel ?? 'OK' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .text-prompt-dialog__field {
      width: 100%;
    }
  `,
})
export class TextPromptDialog {
  protected readonly data = inject<TextPromptDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<TextPromptDialog, string>);
  protected readonly value = signal(this.data.initialValue ?? '');

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  protected submit(): void {
    const trimmed = this.value().trim();
    if (trimmed) {
      this.dialogRef.close(trimmed);
    }
  }
}
