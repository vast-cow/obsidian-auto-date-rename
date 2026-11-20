'use strict';

const { Plugin, PluginSettingTab, Setting, TFile, moment, normalizePath } = require('obsidian');

const DEFAULT_FILENAME_FORMAT = 'YYYY-MM-DD_HH-mm-ss-SSS';
const MAX_BASENAME_BYTES = 247; // 255 bytes minus ".md" and "-9999".
const RENAME_TIMEOUT_MS = 10_000;
const utf8 = new TextEncoder();

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

function getFormattedFilename(date, format) {
  const rawName = format === DEFAULT_FILENAME_FORMAT
    ? formatLocalDateTime(date)
    : moment(date).format(format);
  if (/[<>:"/\\|?*#^\[\]\u0000-\u001f]|%%/.test(rawName)) {
    return {
      name: rawName,
      error: 'The filename contains characters that are unsafe in file paths or Obsidian links.',
    };
  }

  const name = normalizePath(rawName);
  return { name, error: getFilenameError(name) };
}

function getFilenameError(name) {
  if (name === '/' || !name.trim()) return 'The filename cannot be empty.';
  if (name.trimStart().startsWith('.')) return 'The filename cannot start with a period.';
  if (/[. ]$/.test(name)) return 'The filename cannot end with a space or period.';

  const deviceName = name.split('.', 1)[0].trimEnd();
  if (/^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])$/i.test(deviceName)) {
    return 'The filename is reserved on Windows.';
  }
  if (utf8.encode(name).length > MAX_BASENAME_BYTES) {
    return `Shorten the format to keep the base filename within ${MAX_BASENAME_BYTES} UTF-8 bytes.`;
  }
  return '';
}

function pathKey(path) {
  return normalizePath(path).toLowerCase();
}

class AutoDateRenameSettingTab extends PluginSettingTab {
  constructor(plugin, loadToken) {
    super(plugin.app, plugin);
    this.plugin = plugin;
    this.loadToken = loadToken;
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
      const { name, error } = getFormattedFilename(new Date(), normalizeFormat(this.draft));
      preview.textContent = `Preview: ${name}.md`;
      status.textContent = error || this.feedback;
      input.inputEl.setAttribute('aria-invalid', String(Boolean(error)));
      input.setDisabled(this.saving);
      saveButton.setDisabled(this.saving || Boolean(error));
    };
    this.updatePreview();
  }

  async save() {
    if (this.saving || this.plugin.loadToken !== this.loadToken) return;

    const filenameFormat = normalizeFormat(this.draft);
    if (getFormattedFilename(new Date(), filenameFormat).error) {
      this.updatePreview();
      return;
    }

    this.saving = true;
    this.feedback = '';
    this.updatePreview();
    try {
      await this.plugin.persistFilenameFormat(filenameFormat, this.loadToken);
      if (this.plugin.loadToken !== this.loadToken) return;
      this.plugin.filenameFormat = filenameFormat;
      this.feedback = 'File name format saved.';
    } catch (error) {
      if (this.plugin.loadToken !== this.loadToken) return;
      this.feedback = 'Could not save the file name format. The previous format is still active.';
      console.error('[Auto Date Rename] Could not save the file name format:', error);
    } finally {
      this.saving = false;
      if (this.plugin.loadToken === this.loadToken) this.updatePreview();
    }
  }
}

module.exports = class AutoDateRenamePlugin extends Plugin {
  get recoveryPath() {
    const directory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${directory}/data.recovery.json`);
  }

  async readRecoveryFormat() {
    const { adapter } = this.app.vault;
    const path = this.recoveryPath;
    if (!await adapter.exists(path)) return;

    const raw = await adapter.read(path);
    try {
      const format = JSON.parse(raw)?.filenameFormat;
      if (typeof format === 'string' && format === normalizeFormat(format)) return format;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  async loadFilenameFormat(loadToken) {
    try {
      const recovery = await this.readRecoveryFormat();
      if (recovery !== undefined) return recovery;
    } catch (error) {
      if (this.loadToken === loadToken) {
        console.error('[Auto Date Rename] Could not read the file name format recovery file:', error);
      }
    }

    try {
      return normalizeFormat((await this.loadData())?.filenameFormat);
    } catch (error) {
      if (this.loadToken === loadToken) {
        console.error('[Auto Date Rename] Could not load the file name format:', error);
      }
      return DEFAULT_FILENAME_FORMAT;
    }
  }

  async persistFilenameFormat(filenameFormat, loadToken) {
    const { adapter } = this.app.vault;
    const path = this.recoveryPath;
    const recovery = await this.readRecoveryFormat();
    if (this.loadToken !== loadToken) return;

    if (recovery === undefined) {
      const stored = await this.loadData();
      if (this.loadToken !== loadToken || stored?.filenameFormat === filenameFormat) return;

      const backup = JSON.stringify({ filenameFormat: this.filenameFormat });
      await adapter.write(path, backup);
      if (this.loadToken !== loadToken) return;
      const verified = await adapter.read(path);
      if (this.loadToken !== loadToken) return;
      if (verified !== backup) throw new Error('Could not verify the file name format recovery file.');
    }

    await this.saveData({ filenameFormat });
    if (this.loadToken !== loadToken) return;
    const saved = await this.loadData();
    if (this.loadToken !== loadToken) return;
    if (saved?.filenameFormat !== filenameFormat) {
      throw new Error('The stored file name format did not match the requested format.');
    }
    await adapter.remove(path);
  }

  async onload() {
    const loadToken = Symbol();
    this.loadToken = loadToken;
    this.renameReservations = new Map();
    this.filenameFormat = undefined;
    // Process one event at a time to avoid conflicting filenames.
    let renameQueue = Promise.resolve();
    const settingsReady = this.loadFilenameFormat(loadToken);

    // During vault initialization Obsidian emits "create" for existing files.
    // Registering after the layout is ready prevents accidental mass renaming.
    this.app.workspace.onLayoutReady(() => {
      if (this.loadToken !== loadToken) return;
      this.registerEvent(this.app.vault.on('create', (file) => {
        if (this.loadToken !== loadToken) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const filenameFormat = this.filenameFormat;
        renameQueue = renameQueue.then(async () => {
          if (this.loadToken !== loadToken) return;
          const format = filenameFormat ?? await settingsReady;
          if (this.loadToken !== loadToken) return;
          await this.renameNewNote(file, format, loadToken);
        }).catch((error) => console.error('[Auto Date Rename] Could not rename note:', error));
      }));
    });

    const filenameFormat = await settingsReady;
    if (this.loadToken !== loadToken) return;
    this.filenameFormat = filenameFormat;
    this.addSettingTab(new AutoDateRenameSettingTab(this, loadToken));
  }

  onunload() {
    this.loadToken = undefined;
    for (const release of this.renameReservations.values()) release();
  }

  async renameNewNote(file, filenameFormat, loadToken) {
    const { vault } = this.app;
    const sourcePath = file.path;
    const sourceIsCurrent = () => this.loadToken === loadToken &&
      file.path === sourcePath && vault.getAbstractFileByPath(sourcePath) === file;
    if (!sourceIsCurrent()) return;

    const folder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    const { ctime } = file.stat;
    const date = new Date(Number.isFinite(ctime) && ctime > 0 ? ctime : Date.now());
    const { name, error } = getFormattedFilename(date, filenameFormat);
    const baseName = error ? formatLocalDateTime(date) : name;

    // If several notes are created simultaneously, suffix the duplicates.
    for (let index = 0; index < 10000; index++) {
      const suffix = index === 0 ? '' : `-${pad(index, 2)}`;
      const candidate = normalizePath(`${folder ? folder + '/' : ''}${baseName}${suffix}.md`);
      if (candidate === sourcePath) return;
      if (this.renameReservations.has(pathKey(candidate))) continue;

      const occupied = await this.destinationIsOccupied(file, sourcePath, candidate);
      if (!sourceIsCurrent()) return;
      if (occupied) continue;

      try {
        await this.waitForRename(file, sourcePath, candidate);
        return;
      } catch (error) {
        if (!sourceIsCurrent()) return;
        const collided = await this.destinationIsOccupied(file, sourcePath, candidate);
        if (!sourceIsCurrent()) return;
        if (!collided) throw error;
      }
    }
    console.warn('[Auto Date Rename] Could not find an unused filename for:', file.path);
  }

  async destinationIsOccupied(file, sourcePath, candidate) {
    const { vault } = this.app;
    const key = pathKey(candidate);
    const indexedCollision = () => {
      const exact = vault.getAbstractFileByPath(candidate);
      return (exact && exact !== file) ||
        file.parent?.children.some((entry) => entry !== file && pathKey(entry.path) === key);
    };
    if (indexedCollision()) return true;

    if (await vault.adapter.exists(candidate)) {
      // A case-insensitive filesystem can report the source under the destination spelling.
      if (key !== pathKey(sourcePath) || await vault.adapter.exists(candidate, true)) return true;
    }
    return indexedCollision();
  }

  waitForRename(file, sourcePath, candidate) {
    const { vault, fileManager } = this.app;
    const reservations = this.renameReservations;
    const key = pathKey(candidate);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        vault.offref(renameRef);
        vault.offref(deleteRef);
        reservations.delete(key);
      };
      const release = () => {
        cleanup();
        resolve();
      };
      const renameRef = vault.on('rename', (renamed) => {
        if (renamed === file && file.path !== sourcePath) release();
      });
      const deleteRef = vault.on('delete', (deleted) => {
        if (deleted === file) release();
      });
      const timeout = setTimeout(() => {
        console.warn('[Auto Date Rename] Could not confirm rename within 10 seconds:', sourcePath, candidate);
        // Advance the queue while keeping the destination reserved until the attempt is resolved.
        resolve();
      }, RENAME_TIMEOUT_MS);
      reservations.set(key, release);

      const onError = (error) => {
        if (reservations.get(key) !== release) return;
        cleanup();
        // The queue promise has already settled if this rejection arrived after the timeout.
        reject(error);
      };
      try {
        Promise.resolve(fileManager.renameFile(file, candidate)).then(() => {
          if (reservations.get(key) === release && file.path === candidate &&
              vault.getAbstractFileByPath(candidate) === file) release();
        }, onError);
      } catch (error) {
        onError(error);
      }
    });
  }
};
