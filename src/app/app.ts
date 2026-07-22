import { Component } from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { ConnectButton } from './connection-status/connect-button';
import { ConnectionStatus } from './connection-status/connection-status';
import { ConversionStatus } from './conversion-status/conversion-status';
import { FileBrowser } from './file-browser/file-browser';
import { OverflowMenu } from './overflow-menu/overflow-menu';

@Component({
  selector: 'app-root',
  imports: [MatToolbarModule, ConnectButton, ConnectionStatus, ConversionStatus, FileBrowser, OverflowMenu],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
