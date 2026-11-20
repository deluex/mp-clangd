import * as vscode from 'vscode';

const COMMAND_SELECT_PROFILE = 'mpClangd.selectProfile';
const COMMAND_SELECT_UNIT = 'mpClangd.selectUnit';

export class StatusBar implements vscode.Disposable {
  private readonly profileItem: vscode.StatusBarItem;
  private readonly unitItem: vscode.StatusBarItem;

  constructor() {
    this.profileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.profileItem.name = 'mp_clangd profile';
    this.profileItem.text = '$(symbol-structure) mp_clangd: no profile';
    this.profileItem.tooltip = 'Select mp_clangd profile';
    this.profileItem.command = COMMAND_SELECT_PROFILE;
    this.profileItem.show();

    this.unitItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.unitItem.name = 'mp_clangd unit';
    this.unitItem.tooltip = 'Select mp_clangd compile unit';
    this.unitItem.command = COMMAND_SELECT_UNIT;
  }

  update(profileId: string | undefined, unitLabel?: string): void {
    this.profileItem.text = profileId === undefined
      ? '$(symbol-structure) mp_clangd: no profile'
      : `$(symbol-structure) ${profileId}`;

    if (unitLabel === undefined) {
      this.unitItem.hide();
      return;
    }
    this.unitItem.text = `$(list-selection) ${unitLabel}`;
    this.unitItem.show();
  }

  dispose(): void {
    this.profileItem.dispose();
    this.unitItem.dispose();
  }
}
