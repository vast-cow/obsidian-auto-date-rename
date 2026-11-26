'use strict';

const {
  FileSystemAdapter, Platform, Plugin, PluginSettingTab, Setting, TFile, getLanguage, moment, normalizePath
} = require('obsidian');

const DEFAULT_FILENAME_FORMAT = 'YYYYMMDD HHmm';
const DEFAULT_SETTINGS = {
  filenameFormat: DEFAULT_FILENAME_FORMAT,
  targetTitle: '',
};
const MAX_BASENAME_BYTES = 247; // 255 bytes minus ".md" and "-9999".
const RENAME_TIMEOUT_MS = 10_000;
const utf8 = new TextEncoder();

function pad(number, width = 2) {
  return String(number).padStart(width, '0');
}

function formatLocalDateTime(date) {
  const day = `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${day} ${time}`;
}

function normalizeFormat(format) {
  return (typeof format === 'string' && format.trim()) || DEFAULT_FILENAME_FORMAT;
}

function getDefaultTargetTitle() {
  // Older Obsidian versions expose the display language through local storage.
  const language = getLanguage?.() ?? globalThis.localStorage?.getItem('language');
  return language === 'ja' ? '無題のファイル' : 'Untitled';
}

function normalizeSettings(data) {
  return {
    filenameFormat: normalizeFormat(data?.filenameFormat),
    targetTitle: typeof data?.targetTitle === 'string' ? data.targetTitle : DEFAULT_SETTINGS.targetTitle,
  };
}

function settingsMatch(stored, requested) {
  return Object.keys(DEFAULT_SETTINGS).every((key) => stored?.[key] === requested[key]);
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
    this.draft = { ...plugin.settings };
    this.feedback = '';
    this.saving = false;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const inputs = {};
    let saveButton;
    const addInput = (key, label, placeholder) => (text) => {
      inputs[key] = text.setPlaceholder(placeholder).setValue(this.draft[key]);
      text.inputEl.setAttribute('aria-label', label);
      text.onChange((value) => {
        this.draft[key] = value;
        this.feedback = '';
        this.updateDisplay();
      });
    };

    new Setting(containerEl)
      .setName('File name format')
      .setDesc('Use Moment.js format tokens. Clear the field and save to restore the default.')
      .addText(addInput('filenameFormat', 'File name format', DEFAULT_FILENAME_FORMAT));
    const preview = containerEl.createDiv();
    new Setting(containerEl)
      .setName('Target title')
      .setDesc('Enter the exact title without .md. Clear the field and save to use the default for your display language.')
      .addText(addInput('targetTitle', 'Target title', getDefaultTargetTitle()));
    new Setting(containerEl)
      .addButton((button) => {
        saveButton = button.setButtonText('Save').setCta().onClick(() => this.save());
      });

    const status = containerEl.createDiv({ attr: { role: 'status' } });
    this.updateDisplay = () => {
      const settings = normalizeSettings(this.draft);
      const { name, error } = getFormattedFilename(new Date(), settings.filenameFormat);
      preview.textContent = `Preview: ${name}.md`;
      status.textContent = error ? `File name format — ${error}` : this.feedback;
      inputs.filenameFormat.inputEl.setAttribute('aria-invalid', String(Boolean(error)));
      for (const input of Object.values(inputs)) input.setDisabled(this.saving);
      saveButton.setDisabled(this.saving || Boolean(error));
      return error ? undefined : settings;
    };
    this.updateDisplay();
  }

  async save() {
    if (this.saving || this.plugin.loadToken !== this.loadToken) return;

    const settings = this.updateDisplay();
    if (!settings) return;

    this.saving = true;
    this.feedback = '';
    this.updateDisplay();
    try {
      await this.plugin.persistSettings(settings, this.loadToken);
      if (this.plugin.loadToken !== this.loadToken) return;
      this.plugin.settings = settings;
      this.feedback = 'Settings saved.';
    } catch (error) {
      if (this.plugin.loadToken !== this.loadToken) return;
      this.feedback = 'Could not save the settings. The previous settings are still active.';
      console.error('[Auto Date Rename] Could not save the settings:', error);
    } finally {
      this.saving = false;
      if (this.plugin.loadToken === this.loadToken) this.updateDisplay();
    }
  }
}

module.exports = class AutoDateRenamePlugin extends Plugin {
  get recoveryPath() {
    const directory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${directory}/data.recovery.json`);
  }

  async readRecoverySettings() {
    const { adapter } = this.app.vault;
    const path = this.recoveryPath;
    if (!await adapter.exists(path)) return;

    const raw = await adapter.read(path);
    try {
      const data = JSON.parse(raw);
      const format = data?.filenameFormat;
      if (typeof format === 'string' && format === normalizeFormat(format)) {
        return normalizeSettings(data);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  async loadSettings(loadToken) {
    try {
      const recovery = await this.readRecoverySettings();
      if (recovery) return recovery;
    } catch (error) {
      if (this.loadToken === loadToken) {
        console.error('[Auto Date Rename] Could not read the settings recovery file:', error);
      }
    }

    try {
      return normalizeSettings(await this.loadData());
    } catch (error) {
      if (this.loadToken === loadToken) {
        console.error('[Auto Date Rename] Could not load the settings:', error);
      }
      return { ...DEFAULT_SETTINGS };
    }
  }

  async persistSettings(settings, loadToken) {
    const { adapter } = this.app.vault;
    const path = this.recoveryPath;
    const recovery = await this.readRecoverySettings();
    if (this.loadToken !== loadToken) return;

    if (!recovery) {
      const stored = await this.loadData();
      if (this.loadToken !== loadToken || settingsMatch(stored, settings)) return;

      const backup = JSON.stringify(this.settings);
      await adapter.write(path, backup);
      if (this.loadToken !== loadToken) return;
      const verified = await adapter.read(path);
      if (this.loadToken !== loadToken) return;
      if (verified !== backup) throw new Error('Could not verify the settings recovery file.');
    }

    await this.saveData(settings);
    if (this.loadToken !== loadToken) return;
    const saved = await this.loadData();
    if (this.loadToken !== loadToken) return;
    if (!settingsMatch(saved, settings)) {
      throw new Error('The stored settings did not match the requested settings.');
    }
    await adapter.remove(path);
  }

  async onload() {
    const loadToken = Symbol();
    this.loadToken = loadToken;
    this.renameReservations = new Map();
    this.settings = undefined;
    // Process one event at a time to avoid conflicting filenames.
    let renameQueue = Promise.resolve();
    const pendingCreates = [];
    const renameVersions = new WeakMap();
    const { vault } = this.app;
    const queueRename = (event, { filenameFormat, targetTitle }) => {
      const { file, sourcePath, title, defaultTitle, renameVersion } = event;
      if (title !== (targetTitle || defaultTitle)) return;
      const sourceIsCurrent = () => this.loadToken === loadToken &&
        renameVersions.get(file) === renameVersion && file.path === sourcePath &&
        vault.getAbstractFileByPath(sourcePath) === file;
      renameQueue = renameQueue.then(async () => {
        if (!sourceIsCurrent()) return;
        await this.renameNewNote(event, filenameFormat, sourceIsCurrent);
      }).catch((error) => console.error('[Auto Date Rename] Could not rename note:', error));
    };
    const settingsReady = this.loadSettings(loadToken);

    // During vault initialization Obsidian emits "create" for existing files.
    // Registering after the layout is ready prevents accidental mass renaming.
    this.app.workspace.onLayoutReady(() => {
      if (this.loadToken !== loadToken) return;
      // A note moved away and back should also be left alone.
      this.registerEvent(vault.on('rename', (file) => renameVersions.set(file, Symbol())));
      this.registerEvent(vault.on('create', (file) => {
        if (this.loadToken !== loadToken) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        const ctime = file.stat?.ctime;
        if (!Number.isFinite(ctime) || ctime <= 0) return;
        const date = new Date(ctime);
        if (Number.isNaN(date.getTime())) return;
        const event = {
          file, date, sourcePath: file.path, title: file.basename,
          defaultTitle: getDefaultTargetTitle(), renameVersion: renameVersions.get(file),
        };
        if (this.settings) queueRename(event, this.settings);
        else pendingCreates.push(event);
      }));
    });

    const settings = await settingsReady;
    if (this.loadToken !== loadToken) return;
    this.settings = settings;
    for (const event of pendingCreates) queueRename(event, settings);
    pendingCreates.length = 0;
    this.addSettingTab(new AutoDateRenameSettingTab(this, loadToken));
  }

  onunload() {
    this.loadToken = undefined;
    for (const release of this.renameReservations.values()) release();
  }

  async renameNewNote({ file, sourcePath, date }, filenameFormat, sourceIsCurrent) {
    const folder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    const { name, error } = getFormattedFilename(date, filenameFormat);
    const baseName = error ? formatLocalDateTime(date) : name;

    // Suffix duplicates within the same folder.
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
    const { adapter } = vault;
    const key = pathKey(candidate);
    const indexedCollision = () => {
      const exact = vault.getAbstractFileByPath(candidate);
      return (exact && exact !== file) ||
        file.parent?.children.some((entry) => entry !== file && pathKey(entry.path) === key);
    };
    if (indexedCollision()) return true;

    if (await adapter.exists(candidate)) {
      // A case-insensitive filesystem can report the source under the destination spelling.
      if (key !== pathKey(sourcePath) || await adapter.exists(candidate, true)) return true;
    } else if (Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
      // The adapter follows symlinks and can miss a dangling destination entry.
      try {
        await require('fs').promises.lstat(adapter.getFullPath(candidate));
        return true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
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
