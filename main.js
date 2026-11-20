'use strict';

const { Plugin, TFile } = require('obsidian');

function pad(number, width = 2) {
  return String(number).padStart(width, '0');
}

function formatLocalDateTime(timestamp) {
  const date = new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now());
  return [
    date.getFullYear(),
    '-', pad(date.getMonth() + 1),
    '-', pad(date.getDate()),
    '_', pad(date.getHours()),
    '-', pad(date.getMinutes()),
    '-', pad(date.getSeconds()),
    '-', pad(date.getMilliseconds(), 3)
  ].join('');
}

module.exports = class AutoDateRenamePlugin extends Plugin {
  onload() {
    // Process one event at a time to avoid conflicting filenames.
    this.renameQueue = Promise.resolve();

    // During vault initialization Obsidian emits "create" for existing files.
    // Registering after the layout is ready prevents accidental mass renaming.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        this.renameQueue = this.renameQueue
          .then(() => this.renameNewNote(file))
          .catch((error) => console.error('[Auto Date Rename] Could not rename note:', error));
      }));
    });
  }

  async renameNewNote(file) {
    // Skip notes already removed before the queued handler runs.
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;

    const folder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    const baseName = formatLocalDateTime(file.stat.ctime);

    // If several notes are created simultaneously, suffix the duplicates.
    for (let index = 0; index < 10000; index++) {
      const suffix = index === 0 ? '' : `-${pad(index, 2)}`;
      const candidate = `${folder ? folder + '/' : ''}${baseName}${suffix}.md`;
      if (candidate === file.path) return;
      if (this.app.vault.getAbstractFileByPath(candidate) !== null) continue;
      await this.app.fileManager.renameFile(file, candidate);
      return;
    }
    console.warn('[Auto Date Rename] Could not find an unused filename for:', file.path);
  }
};
