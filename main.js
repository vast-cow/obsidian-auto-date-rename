'use strict';

const { Plugin, PluginSettingTab, Setting, TFile, moment } = require('obsidian');

const DEFAULT_FILENAME_FORMAT = 'YYYY-MM-DD_HH-mm-ss-SSS';

function pad(number, width = 2) {
  return String(number).padStart(width, '0');
}

function formatLocalDateTime(date) {
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

function normalizeFormat(format) {
  return (typeof format === 'string' && format.trim()) || DEFAULT_FILENAME_FORMAT;
}

function formatFilename(date, format) {
  if (format === DEFAULT_FILENAME_FORMAT) return formatLocalDateTime(date);
  return moment(date).format(format).normalize('NFC');
}

function getFilenameError(name) {
  if (!name.trim()) return 'The filename cannot be empty.';
  if (name.trimStart().startsWith('.')) return 'The filename cannot start with a period.';
  if (/[<>:"/\\|?*#^\[\]\u0000-\u001f]|%%/.test(name)) {
    return 'The filename contains characters that are unsafe in file paths or Obsidian links.';
  }
  if (/[. ]$/.test(name)) return 'The filename cannot end with a space or period.';

  const deviceName = name.split('.', 1)[0].trimEnd();
  if (/^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])$/i.test(deviceName)) {
    return 'The filename is reserved on Windows.';
  }
  return '';
}

class AutoDateRenameSettingTab extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
    this.draft = plugin.filenameFormat;
    this.feedback = '';
    this.saving = false;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    let input;
    let saveButton;
    new Setting(containerEl)
      .setName('File name format')
      .setDesc('Use Moment.js format tokens. Clear the field and save to restore the default.')
      .addText((text) => {
        input = text.setPlaceholder(DEFAULT_FILENAME_FORMAT).setValue(this.draft);
        input.inputEl.setAttribute('aria-label', 'File name format');
        input.onChange((value) => {
          this.draft = value;
          this.feedback = '';
          this.updatePreview();
        });
      })
      .addButton((button) => {
        saveButton = button.setButtonText('Save').setCta().onClick(() => this.save());
      });

    const preview = containerEl.createDiv();
    const status = containerEl.createDiv({ attr: { role: 'status' } });
    this.updatePreview = () => {
      const name = formatFilename(new Date(), normalizeFormat(this.draft));
      const error = getFilenameError(name);
      preview.textContent = `Preview: ${name}.md`;
      status.textContent = error || this.feedback;
      input.inputEl.setAttribute('aria-invalid', String(Boolean(error)));
      input.setDisabled(this.saving);
      saveButton.setDisabled(this.saving || Boolean(error));
    };
    this.updatePreview();
  }

  async save() {
    if (this.saving) return;

    const filenameFormat = normalizeFormat(this.draft);
    if (getFilenameError(formatFilename(new Date(), filenameFormat))) {
      this.updatePreview();
      return;
    }

    this.saving = true;
    this.feedback = '';
    this.updatePreview();
    try {
      const stored = await this.plugin.loadData();
      if (stored?.filenameFormat !== filenameFormat) {
        await this.plugin.saveData({ filenameFormat });
        const saved = await this.plugin.loadData();
        if (saved?.filenameFormat !== filenameFormat) {
          throw new Error('The stored file name format did not match the requested format.');
        }
      }
      this.plugin.filenameFormat = filenameFormat;
      this.feedback = 'File name format saved.';
    } catch (error) {
      this.feedback = 'Could not save the file name format. The previous format is still active.';
      console.error('[Auto Date Rename] Could not save the file name format:', error);
    } finally {
      this.saving = false;
      this.updatePreview();
    }
  }
}

module.exports = class AutoDateRenamePlugin extends Plugin {
  async onload() {
    // Process one event at a time to avoid conflicting filenames.
    this.renameQueue = Promise.resolve();

    const data = await this.loadData();
    this.filenameFormat = normalizeFormat(data?.filenameFormat);
    this.addSettingTab(new AutoDateRenameSettingTab(this));

    // During vault initialization Obsidian emits "create" for existing files.
    // Registering after the layout is ready prevents accidental mass renaming.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const filenameFormat = this.filenameFormat;
        this.renameQueue = this.renameQueue
          .then(() => this.renameNewNote(file, filenameFormat))
          .catch((error) => console.error('[Auto Date Rename] Could not rename note:', error));
      }));
    });
  }

  async renameNewNote(file, filenameFormat = this.filenameFormat) {
    // Skip notes already removed before the queued handler runs.
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;

    const folder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    const { ctime } = file.stat;
    const date = new Date(Number.isFinite(ctime) && ctime > 0 ? ctime : Date.now());
    const formattedName = formatFilename(date, filenameFormat);
    const baseName = getFilenameError(formattedName) ? formatLocalDateTime(date) : formattedName;

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
