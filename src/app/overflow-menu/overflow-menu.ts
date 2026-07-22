import { Component, inject } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SettingsService } from '../core/settings.service';

/**
 * The toolbar overflow menu (SPECSv3.md §6): currently just the
 * "Convert files on transfer" toggle, anchored next to `ConnectButton`.
 */
@Component({
  selector: 'app-overflow-menu',
  imports: [MatIconButton, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './overflow-menu.html',
})
export class OverflowMenu {
  protected readonly settings = inject(SettingsService);

  protected toggleConvertOnTransfer(): void {
    this.settings.toggleConvertOnTransfer();
  }
}
