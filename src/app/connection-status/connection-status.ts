import { Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PsionLinkService } from '../core/psion-link.service';

/**
 * The "quiet persistent connection-status indicator" CLAUDE.md's UI
 * sensibility asks for, in place of a modal: negotiated baud once known,
 * and the last failure reason if there is one. Info only — the
 * Connect/Disconnect action lives in `ConnectButton`, on the toolbar.
 */
@Component({
  selector: 'app-connection-status',
  imports: [MatIconModule, MatTooltipModule],
  templateUrl: './connection-status.html',
  styleUrl: './connection-status.scss',
})
export class ConnectionStatus {
  protected readonly psionLink = inject(PsionLinkService);
}
