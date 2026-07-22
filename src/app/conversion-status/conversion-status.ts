import { Component, inject } from '@angular/core';
import { SettingsService } from '../core/settings.service';

/**
 * A quiet status-bar readout of the "convert files on transfer" setting
 * (toggled from `OverflowMenu`) — info only, same split as
 * `ConnectionStatus`/`ConnectButton`: the action lives in the toolbar
 * menu, this just reflects current state.
 */
@Component({
  selector: 'app-conversion-status',
  templateUrl: './conversion-status.html',
  styleUrl: './conversion-status.scss',
})
export class ConversionStatus {
  protected readonly settings = inject(SettingsService);
}
