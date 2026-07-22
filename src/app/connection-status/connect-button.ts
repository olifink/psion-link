import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { PsionLinkService } from '../core/psion-link.service';

/** The Connect/Disconnect action, kept on the top toolbar. Status detail lives in `ConnectionStatus`, in the bottom status bar. */
@Component({
  selector: 'app-connect-button',
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './connect-button.html',
  styleUrl: './connect-button.scss',
})
export class ConnectButton {
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
