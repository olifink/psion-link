import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PsionLinkService } from '../core/psion-link.service';

/**
 * The "quiet persistent connection-status indicator" CLAUDE.md's UI
 * sensibility asks for, in place of a modal: negotiated baud once known,
 * a Connect/Disconnect action, and the last failure reason if there is one.
 */
@Component({
  selector: 'app-connection-status',
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule],
  templateUrl: './connection-status.html',
  styleUrl: './connection-status.scss',
})
export class ConnectionStatus {
  protected readonly psionLink = inject(PsionLinkService);

  protected async connect(): Promise<void> {
    try {
      await this.psionLink.connect();
    } catch {
      // Surfaced via psionLink.lastError(); nothing further to do here.
    }
  }

  protected async disconnect(): Promise<void> {
    await this.psionLink.disconnect();
  }
}
