import { Component } from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { ConnectionStatus } from './connection-status/connection-status';
import { FileBrowser } from './file-browser/file-browser';

@Component({
  selector: 'app-root',
  imports: [MatToolbarModule, ConnectionStatus, FileBrowser],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
