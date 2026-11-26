'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { setImmediate: flushQueue } = require('node:timers/promises');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../main.js'), 'utf8');
const creationTime = new Date(2026, 10, 20, 12, 1, 30, 123).getTime();
const defaultFilename = '2026-11-20_12-01-30-123.md';
const pluginId = 'obsidian-auto-date-rename';
const pluginDir = `custom-config/plugins/${pluginId}`;
const recoveryPath = `${pluginDir}/data.recovery.json`;
const filenameLabel = 'File name format';
const titleLabel = 'Target title';
const settings = (filenameFormat, targetTitle = '') => ({ filenameFormat, targetTitle });
const oldRecovery = JSON.stringify(settings('[Old]'));

function normalizePath(path) {
  const normalized = path.replace(/[\\/]+/g, '/').replace(/^\/|\/$/g, '');
  return (normalized || '/').replace(/\u00a0/g, ' ').normalize('NFC');
}

class Plugin {
  subscriptions = [];

  constructor(app, storage) {
    this.app = app;
    this.storage = storage;
    this.manifest = { id: pluginId, dir: pluginDir };
  }

  async loadData() {
    const { data } = this.storage;
    return typeof data === 'string' ? JSON.parse(data) : structuredClone(data);
  }

  async saveData(data) {
    this.storage.data = structuredClone(data);
  }

  addSettingTab(tab) {
    this.tab = tab;
  }

  registerEvent(unsubscribe) {
    this.subscriptions.push(unsubscribe);
  }

  unload() {
    this.onunload();
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    delete this.tab;
  }
}

class TFile {
  constructor(stat) {
    this.stat = stat;
  }
}

class FileSystemAdapter {
  getFullPath(path) {
    return `/vault/${path}`;
  }
}

class PluginSettingTab {
  constructor() {
    this.containerEl = {
      empty() {
        this.children = [];
        this.inputs = {};
      },
      createDiv() {
        const div = { textContent: '' };
        this.children.push(div);
        return div;
      },
    };
  }
}

class Setting {
  constructor(container) {
    this.container = container;
  }

  setName(name) { this.name = name; return this; }
  setDesc() { return this; }

  addText(build) {
    const attributes = {};
    const input = {
      attributes,
      inputEl: { setAttribute(name, value) { attributes[name] = value; } },
      setPlaceholder(placeholder) { this.placeholder = placeholder; return this; },
      setValue(value) { this.value = value; return this; },
      onChange(change) { this.change = change; return this; },
      setDisabled(disabled) { this.disabled = disabled; },
    };
    build(input);
    this.container.inputs[this.name] = input;
    return this;
  }

  addButton(build) {
    const button = {
      setButtonText() { return this; },
      setCta() { return this; },
      onClick(click) { this.click = click; return this; },
      setDisabled(disabled) { this.disabled = disabled; },
    };
    build(button);
    this.container.button = button;
    return this;
  }
}

function setup(storage = { data: { filenameFormat: '[Old]' } },
  { lstat, language = 'en', legacyLanguage } = {}) {
  const errors = [];
  const warnings = [];
  const timers = new Set();
  const module = {};
  runInNewContext(source, {
    module,
    TextEncoder,
    Date: class extends Date {
      static now() { return creationTime; }
    },
    localStorage: {
      getItem(key) {
        assert.equal(key, 'language');
        return legacyLanguage;
      },
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 10_000);
      timers.add(callback);
      return callback;
    },
    clearTimeout(callback) { timers.delete(callback); },
    require(name) {
      if (name === 'fs' && lstat) return { promises: { lstat } };
      assert.equal(name, 'obsidian');
      return {
        FileSystemAdapter,
        Platform: { isDesktopApp: Boolean(lstat) },
        Plugin,
        PluginSettingTab,
        Setting,
        TFile,
        normalizePath,
        getLanguage: legacyLanguage === undefined ? () => language : undefined,
        moment: () => ({ format: (format) => format.replace(/\[([^\]]*)\]/g, '$1') }),
      };
    },
    console: {
      error: (...args) => errors.push(args),
      warn: (...args) => warnings.push(args),
    },
  }, { filename: 'main.js' });

  const layoutCallbacks = [];
  const listeners = { create: new Set(), rename: new Set(), delete: new Set() };
  const files = new Map();
  const disk = new Set();
  const parents = new Map();
  const renamedPaths = [];
  let layoutReady = false;
  const parentPath = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/';
  function attach(file, path) {
    const folder = parentPath(path);
    if (!parents.has(folder)) parents.set(folder, { path: folder, children: [] });
    file.parent = parents.get(folder);
    file.parent.children.push(file);
    file.path = path;
    file.extension = path.split('.').at(-1);
    file.basename = path.split('/').at(-1).slice(0, -(file.extension.length + 1));
    files.set(path, file);
    disk.add(path);
  }
  function detach(file) {
    files.delete(file.path);
    disk.delete(file.path);
    file.parent.children.splice(file.parent.children.indexOf(file), 1);
  }
  function move(file, path) {
    assert.equal(path, normalizePath(path));
    assert.equal(disk.has(path), false, `Cannot overwrite ${path}`);
    const oldPath = file.path;
    detach(file);
    attach(file, path);
    renamedPaths.push(path);
    for (const callback of listeners.rename) callback(file, oldPath);
  }
  const app = {
    workspace: {
      onLayoutReady(callback) {
        if (layoutReady) callback();
        else layoutCallbacks.push(callback);
      },
    },
    vault: {
      configDir: 'custom-config',
      adapter: Object.assign(lstat ? new FileSystemAdapter() : {}, {
        async exists(path) {
          return path === recoveryPath ? storage.recovery !== undefined : disk.has(path);
        },
        async list(folder) {
          return {
            files: [...disk].filter((path) => parentPath(path) === folder),
            folders: [],
          };
        },
        async read(path) {
          assert.equal(path, recoveryPath);
          return storage.recovery;
        },
        async write(path, content) {
          assert.equal(path, recoveryPath);
          storage.recovery = content;
        },
        async remove(path) {
          assert.equal(path, recoveryPath);
          delete storage.recovery;
        },
      }),
      on(event, callback) {
        listeners[event].add(callback);
        return () => listeners[event].delete(callback);
      },
      offref(unsubscribe) {
        unsubscribe();
      },
      getAbstractFileByPath(path) {
        return files.get(path) ?? null;
      },
    },
    fileManager: {
      async renameFile(file, path) {
        move(file, path);
      },
    },
  };
  function create(path, stat = { ctime: creationTime }) {
    assert.equal(files.has(path), false, `File already exists at ${path}`);
    const file = new TFile(stat);
    attach(file, path);
    for (const callback of listeners.create) callback(file);
    return file;
  }

  const plugin = new module.exports(app, storage);
  return {
    plugin, storage, errors, warnings, listeners, timers, disk, renamedPaths, move,
    createListeners: listeners.create,
    expireRename() {
      assert.equal(timers.size, 1);
      const [callback] = timers;
      timers.delete(callback);
      callback();
    },
    remove(file) {
      detach(file);
      for (const callback of listeners.delete) callback(file);
    },
    finishLayout() {
      layoutReady = true;
      for (const callback of layoutCallbacks.splice(0)) callback();
    },
    create,
    createMatching(path) {
      // Keep several distinct source names eligible in the same folder for queue tests.
      plugin.settings.targetTitle = path.split('/').at(-1).slice(0, -3);
      return create(path);
    },
  };
}

async function openSettings(plugin) {
  await plugin.onload();
  plugin.tab.display();
  return plugin.tab.containerEl;
}

test('uses the display-language default when the target is unspecified', async () => {
  for (const [options, match, other] of [
    [{ language: 'ja' }, '無題のファイル', 'Untitled'],
    [{ language: 'en' }, 'Untitled', '無題のファイル'],
    [{ language: 'de' }, 'Untitled', '無題のファイル'],
    [{ legacyLanguage: 'ja' }, '無題のファイル', 'Untitled'],
  ]) {
    const { plugin, create, finishLayout } = setup({}, options);
    const ui = await openSettings(plugin);
    assert.deepEqual(Object.keys(ui.inputs), [filenameLabel, titleLabel]);
    assert.equal(ui.inputs[titleLabel].value, '');
    assert.equal(ui.inputs[titleLabel].placeholder, match);

    finishLayout();
    const matching = create(`${match}.md`);
    const different = create(`${other}.md`);
    await flushQueue();
    assert.equal(matching.path, defaultFilename);
    assert.equal(different.path, `${other}.md`);
  }
});

test('saves the title verbatim with the format and applies both after reload', async () => {
  const { plugin, storage, create, finishLayout } = setup(undefined, { language: 'ja' });
  const ui = await openSettings(plugin);
  ui.inputs[filenameLabel].change('[New]');
  ui.inputs[titleLabel].change(' Meeting Notes ');
  assert.equal(ui.children[0].textContent, 'Preview: New.md');
  await ui.button.click();

  assert.deepEqual(storage.data, settings('[New]', ' Meeting Notes '));
  assert.equal(storage.recovery, undefined);
  assert.equal(ui.children[1].textContent, 'Settings saved.');
  finishLayout();
  const matching = create(' Meeting Notes .md');
  const trimmed = create('Meeting Notes.md');
  const differentCase = create(' meeting Notes .md');
  await flushQueue();
  assert.deepEqual([matching.path, trimmed.path, differentCase.path], [
    'New.md', 'Meeting Notes.md', ' meeting Notes .md',
  ]);

  plugin.unload();
  const reopened = setup(storage, { language: 'ja' });
  const reopenedUi = await openSettings(reopened.plugin);
  assert.equal(reopenedUi.inputs[filenameLabel].value, '[New]');
  assert.equal(reopenedUi.inputs[titleLabel].value, ' Meeting Notes ');
  reopened.finishLayout();
  const note = reopened.create(' Meeting Notes .md');
  await flushQueue();
  assert.equal(note.path, 'New.md');
});

test('clearing the target restores the display-language default immediately and after reload', async () => {
  const { plugin, storage, create, finishLayout } = setup({
    data: settings('[Old]', 'Untitled'),
  }, { language: 'ja' });
  const ui = await openSettings(plugin);
  ui.inputs[titleLabel].change('');
  await ui.button.click();
  assert.deepEqual(storage.data, settings('[Old]'));

  finishLayout();
  const japanese = create('無題のファイル.md');
  const previous = create('Untitled.md');
  await flushQueue();
  assert.deepEqual([japanese.path, previous.path], ['Old.md', 'Untitled.md']);

  plugin.unload();
  const reopened = setup(storage);
  const reopenedUi = await openSettings(reopened.plugin);
  assert.equal(reopenedUi.inputs[titleLabel].value, '');
  reopened.finishLayout();
  const note = reopened.create('Untitled.md');
  await flushQueue();
  assert.equal(note.path, 'Old.md');
});

test('inherits the date format from legacy settings and recovery files', async () => {
  for (const legacy of [
    { filenameFormat: '[Legacy]' },
    { filenameFormat: '[Legacy]', maxCreationAgeMs: 0, maxFutureSkewMs: 125 },
  ]) {
    for (const storage of [
      { data: legacy },
      { data: settings('[Unconfirmed]', 'Other'), recovery: JSON.stringify(legacy) },
    ]) {
      const { plugin, create, finishLayout } = setup(storage, { language: 'ja' });
      const ui = await openSettings(plugin);
      assert.deepEqual({ ...plugin.settings }, settings('[Legacy]'));
      assert.equal(ui.inputs[filenameLabel].value, '[Legacy]');
      finishLayout();
      const note = create('無題のファイル.md');
      await flushQueue();
      assert.equal(note.path, 'Legacy.md');

      await ui.button.click();
      assert.deepEqual(storage.data, settings('[Legacy]'));
      assert.equal(storage.recovery, undefined);
    }
  }
});

test('skips the write when all requested settings are already stored', async () => {
  const { plugin, storage } = setup();
  const ui = await openSettings(plugin);
  storage.data = settings('[New]');
  plugin.saveData = () => assert.fail('unexpected write');

  ui.inputs[filenameLabel].change('[New]');
  await ui.button.click();
  assert.equal(plugin.settings.filenameFormat, '[New]');
  assert.equal(ui.children[1].textContent, 'Settings saved.');
});

test('retains the active format and allows retry after a rejected write', async () => {
  const { plugin, storage, errors } = setup();
  const ui = await openSettings(plugin);
  plugin.saveData = async () => { throw new Error('write failed'); };

  ui.inputs[filenameLabel].change('[New]');
  await ui.button.click();
  assertSaveFailed(plugin, ui, errors);
  assert.deepEqual(storage.data, { filenameFormat: '[Old]' });
  assert.equal(storage.recovery, oldRecovery);

  plugin.saveData = Plugin.prototype.saveData;
  await ui.button.click();
  assert.equal(plugin.settings.filenameFormat, '[New]');
  assert.equal(storage.recovery, undefined);
  assert.equal(ui.children[1].textContent, 'Settings saved.');
});

test('retains the active format when a resolved write does not persist', async () => {
  const { plugin, storage, errors } = setup();
  const ui = await openSettings(plugin);
  plugin.saveData = async () => {};

  ui.inputs[filenameLabel].change('[New]');
  await ui.button.click();
  assertSaveFailed(plugin, ui, errors);
  assert.deepEqual(storage.data, { filenameFormat: '[Old]' });
});

test('requires an exact readback match for both settings', async () => {
  for (const mismatch of [
    { filenameFormat: '[New] ' }, { targetTitle: 'New title ' }, { targetTitle: undefined },
  ]) {
    const { plugin, storage, errors } = setup();
    const ui = await openSettings(plugin);
    plugin.saveData = async (requested) => {
      storage.data = { ...requested, ...mismatch };
    };

    ui.inputs[filenameLabel].change('[New]');
    ui.inputs[titleLabel].change('New title');
    await ui.button.click();
    assertSaveFailed(plugin, ui, errors);
    assert.equal(storage.recovery, oldRecovery);
  }
});

test('leaves data.json untouched when the recovery write fails or cannot be verified', async () => {
  for (const rejects of [true, false]) {
    const { plugin, storage, errors } = setup();
    delete plugin.manifest.dir;
    const ui = await openSettings(plugin);
    const adapter = plugin.app.vault.adapter;
    const write = adapter.write;
    adapter.write = async (path, content) => {
      await write(path, content.slice(0, 15));
      if (rejects) throw new Error('Recovery write failed');
    };
    let attempted = false;
    plugin.saveData = async () => { attempted = true; };

    ui.inputs[filenameLabel].change('[New]');
    await ui.button.click();
    assertSaveFailed(plugin, ui, errors);
    assert.equal(attempted, false);
    assert.deepEqual(storage.data, { filenameFormat: '[Old]' });
    assert.equal((await openSettings(setup(storage).plugin)).inputs[filenameLabel].value, '[Old]');

    adapter.write = write;
    plugin.saveData = Plugin.prototype.saveData;
    await ui.button.click();
    assert.deepEqual(storage.data, settings('[New]'));
    assert.equal(storage.recovery, undefined);
  }
});

test('uses the verified recovery after a short data.json write and repairs it on retry', async () => {
  const { plugin, storage, errors } = setup();
  const ui = await openSettings(plugin);
  const truncated = '{"filenameFormat":';
  plugin.saveData = async () => {
    assert.equal(storage.recovery, oldRecovery);
    storage.data = truncated;
  };
  ui.inputs[filenameLabel].change('[New]');
  await ui.button.click();
  assertSaveFailed(plugin, ui, errors);
  assert.equal(storage.data, truncated);
  assert.equal(storage.recovery, oldRecovery);
  plugin.unload();

  const reopened = setup(storage);
  const recoveredUi = await openSettings(reopened.plugin);
  assert.equal(recoveredUi.inputs[filenameLabel].value, '[Old]');
  reopened.finishLayout();
  const note = reopened.create('Untitled.md');
  await flushQueue();
  assert.equal(note.path, 'Old.md');

  let rewroteRecovery = false;
  reopened.plugin.app.vault.adapter.write = async () => { rewroteRecovery = true; };
  recoveredUi.inputs[filenameLabel].change('[New]');
  await recoveredUi.button.click();
  assert.equal(rewroteRecovery, false);
  assert.deepEqual(storage.data, settings('[New]'));
  assert.equal(storage.recovery, undefined);
  assert.equal(reopened.plugin.settings.filenameFormat, '[New]');
  assert.equal((await openSettings(setup(storage).plugin)).inputs[filenameLabel].value, '[New]');
});

test('keeps confirmed settings active until a verified save clears the recovery file', async () => {
  const confirmed = settings('[Old]', 'Confirmed');
  const requested = settings('[New]', 'Requested');
  const { plugin, storage, errors, create, finishLayout } = setup({ data: confirmed });
  const ui = await openSettings(plugin);
  finishLayout();
  const adapter = plugin.app.vault.adapter;
  const remove = adapter.remove;
  const removing = deferred();
  adapter.remove = () => removing.promise;
  ui.inputs[filenameLabel].change('[New]');
  ui.inputs[titleLabel].change('Requested');
  const saving = ui.button.click();
  await flushQueue();

  assert.equal(ui.button.disabled, true);
  assert.deepEqual(storage.data, requested);
  assert.equal(storage.recovery, JSON.stringify(confirmed));
  const duringSave = create('Confirmed.md');
  await flushQueue();
  assert.equal(duringSave.path, 'Old.md');
  removing.reject(new Error('Recovery removal failed'));
  await saving;
  assertSaveFailed(plugin, ui, errors, confirmed);
  const afterFailure = create('Requested.md');
  await flushQueue();
  assert.equal(afterFailure.path, 'Requested.md');

  const reopened = setup(storage);
  await reopened.plugin.onload();
  assert.deepEqual({ ...reopened.plugin.settings }, confirmed);

  adapter.remove = remove;
  await ui.button.click();
  assert.equal(storage.recovery, undefined);
  assert.deepEqual({ ...plugin.settings }, requested);
  const afterRetry = create('Inbox/Requested.md');
  const oldTitle = create('Inbox/Confirmed.md');
  await flushQueue();
  assert.deepEqual([afterRetry.path, oldTitle.path], ['Inbox/New.md', 'Inbox/Confirmed.md']);
});

function assertSaveFailed(plugin, ui, errors, confirmed = settings('[Old]')) {
  assert.deepEqual({ ...plugin.settings }, confirmed);
  assert.match(ui.children[1].textContent, /Could not save the settings/);
  assert.ok(Object.values(ui.inputs).every((input) => !input.disabled));
  assert.equal(ui.button.disabled, false);
  assert.equal(errors.length, 1);
}

test('processes matching events received after layout readiness in order once settings load', async () => {
  const { plugin, create, move, finishLayout, renamedPaths } = setup();
  const loading = deferred();
  plugin.loadData = () => loading.promise;
  const startup = plugin.onload();

  const existing = create('Existing/Target.md');
  finishLayout();
  const renamed = create('Renamed/Target.md');
  move(renamed, 'Renamed/Manual.md');
  const moved = create('Moved/Target.md');
  move(moved, 'Other/Target.md');
  const renamedToMatch = create('Incoming/Other.md');
  move(renamedToMatch, 'Incoming/Target.md');
  const movedBack = create('Returned/Target.md');
  move(movedBack, 'Returned/Manual.md');
  move(movedBack, 'Returned/Target.md');
  const first = create('First/Target.md', { ctime: creationTime - 1000 });
  const second = create('Second/Target.md');
  first.stat.ctime = creationTime;
  const manualPaths = [...renamedPaths];

  await flushQueue();
  assert.deepEqual(renamedPaths, manualPaths);

  loading.resolve(settings('YYYY-MM-DD_HH-mm-ss-SSS', 'Target'));
  await startup;
  await flushQueue();
  assert.equal(first.path, 'First/2026-11-20_12-01-29-123.md');
  assert.equal(second.path, `Second/${defaultFilename}`);
  assert.equal(existing.path, 'Existing/Target.md');
  assert.deepEqual(renamedPaths, [...manualPaths, first.path, second.path]);
});

test('disabling during load invalidates the layout callback and settings registration', async () => {
  const { plugin, createListeners, finishLayout } = setup();
  const loading = deferred();
  plugin.loadData = () => loading.promise;
  const startup = plugin.onload();

  plugin.unload();
  finishLayout();
  loading.resolve({ filenameFormat: '[Stale]' });
  await startup;
  assert.equal(createListeners.size, 0);
  assert.equal(plugin.tab, undefined);
});

test('disabling while a note waits for settings discards that rename', async () => {
  const { plugin, create, finishLayout } = setup();
  const loading = deferred();
  plugin.loadData = () => loading.promise;
  const renames = [];
  plugin.renameNewNote = ({ file }) => renames.push(file.path);
  const startup = plugin.onload();

  finishLayout();
  create('Untitled.md');
  await flushQueue();
  plugin.unload();
  loading.resolve({ filenameFormat: '[Stale]' });
  await startup;
  await flushQueue();
  assert.deepEqual(renames, []);
});

test('queued notes use the settings at reception and are discarded on disable', async () => {
  const { plugin, create, finishLayout } = setup();
  const ui = await openSettings(plugin);
  finishLayout();
  const firstRename = deferred();
  const secondRename = deferred();
  const renames = [];
  plugin.renameNewNote = ({ sourcePath }, format) => {
    renames.push([sourcePath, format]);
    if (sourcePath === 'First/Untitled.md') return firstRename.promise;
    if (sourcePath === 'Second/Untitled.md') return secondRename.promise;
  };

  create('First/Untitled.md');
  create('Second/Untitled.md');
  create('New title.md');
  await flushQueue();
  assert.deepEqual(renames, [['First/Untitled.md', '[Old]']]);

  ui.inputs[filenameLabel].change('[New]');
  ui.inputs[titleLabel].change('New title');
  await ui.button.click();
  create('Third/Untitled.md');
  create('Discarded/New title.md');
  firstRename.resolve();
  await flushQueue();
  assert.deepEqual(renames, [['First/Untitled.md', '[Old]'], ['Second/Untitled.md', '[Old]']]);

  plugin.unload();
  const reopened = await openSettings(plugin);
  assert.equal(reopened.inputs[filenameLabel].value, '[New]');
  create('AfterEnable/New title.md');
  secondRename.resolve();
  await flushQueue();
  assert.deepEqual(renames, [
    ['First/Untitled.md', '[Old]'], ['Second/Untitled.md', '[Old]'], ['AfterEnable/New title.md', '[New]'],
  ]);
});

test('skips a matching note manually renamed or moved while waiting in the queue', async () => {
  const { plugin, create, move, finishLayout, renamedPaths } = setup();
  const calls = [];
  plugin.app.fileManager.renameFile = (file, path) => {
    calls.push([file, path]);
    return Promise.resolve();
  };
  await plugin.onload();
  finishLayout();
  const first = create('First/Untitled.md');
  const renamed = create('Second/Untitled.md');
  const moved = create('Third/Untitled.md');
  await flushQueue();

  move(renamed, 'Second/Manual.md');
  move(moved, 'Other/Untitled.md');
  move(first, 'First/Old.md');
  await flushQueue();

  assert.deepEqual(calls, [[first, 'First/Old.md']]);
  assert.deepEqual(renamedPaths, ['Second/Manual.md', 'Other/Untitled.md', 'First/Old.md']);
});

test('a save awaiting readback cannot replace settings of a later enable', async () => {
  const { plugin, storage } = setup();
  const ui = await openSettings(plugin);
  const readback = deferred();
  const initialRead = plugin.loadData.bind(plugin);
  plugin.saveData = async () => {
    plugin.loadData = () => readback.promise;
  };

  ui.inputs[filenameLabel].change('[Stale]');
  ui.inputs[titleLabel].change('Stale');
  const saving = ui.button.click();
  await flushQueue();
  plugin.unload();
  plugin.loadData = initialRead;
  storage.data = { filenameFormat: '[Reloaded]' };
  await plugin.onload();
  assert.deepEqual({ ...plugin.settings }, settings('[Old]'));
  plugin.tab.display();
  plugin.tab.containerEl.inputs[filenameLabel].change('[Reloaded]');
  plugin.tab.containerEl.inputs[titleLabel].change('Reloaded');
  plugin.saveData = Plugin.prototype.saveData;
  await plugin.tab.containerEl.button.click();
  readback.resolve(settings('[Stale]', 'Stale'));
  await saving;
  assert.deepEqual({ ...plugin.settings }, settings('[Reloaded]', 'Reloaded'));
  assert.equal(storage.recovery, undefined);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('renames exact matches with old or future timestamps and preserves other new names', async () => {
  const { plugin, create, finishLayout, renamedPaths } = setup({});
  await plugin.onload();
  finishLayout();

  const synced = create('Inbox/Untitled.md', { ctime: new Date(2026, 10, 19, 12, 1, 30, 123).getTime() });
  const future = create('Other/Untitled.md', { ctime: creationTime + 1000 });
  const untouchedPaths = [
    'Inbox/Copy of Meeting Notes.md', 'Inbox/Untitled 1.md', 'Inbox/untitled.md',
    'Inbox/Untitled .md', 'Inbox/Untitled.txt',
  ];
  const untouched = untouchedPaths.map((path) => create(path));
  await flushQueue();

  assert.equal(synced.path, 'Inbox/2026-11-19_12-01-30-123.md');
  assert.equal(future.path, 'Other/2026-11-20_12-01-31-123.md');
  assert.deepEqual(untouched.map(({ path }) => path), untouchedPaths);
  assert.deepEqual(renamedPaths, [synced.path, future.path]);
});

test('skips matching notes with missing, invalid, or non-positive creation times', async () => {
  const { plugin, create, finishLayout, renamedPaths, errors } = setup();
  await plugin.onload();
  finishLayout();

  const invalidStats = [
    null, {}, { ctime: null }, { ctime: NaN }, { ctime: Infinity },
    { ctime: String(creationTime) }, { ctime: Number.MAX_SAFE_INTEGER },
    { ctime: 0 }, { ctime: -1 },
  ];
  const paths = invalidStats.map((_, index) => `Inbox/${index}/Untitled.md`);
  const notes = invalidStats.map((stat, index) => create(paths[index], stat));
  await flushQueue();

  assert.deepEqual(notes.map((file) => file.path), paths);
  assert.deepEqual(renamedPaths, []);
  assert.deepEqual(errors, []);
});

test('uses the normalized preview name on disk and numbers collisions', async () => {
  const { plugin, create, finishLayout, renamedPaths, errors } = setup();
  const ui = await openSettings(plugin);
  ui.inputs[filenameLabel].change('[New\u00a0Note]');
  assert.equal(ui.children[0].textContent, 'Preview: New Note.md');
  await ui.button.click();

  finishLayout();
  const first = create('Inbox/Untitled.md');
  await flushQueue();
  const second = create('Inbox/Untitled.md');
  await flushQueue();
  const third = create('Inbox/Untitled.md');
  await flushQueue();
  assert.deepEqual([first.path, second.path, third.path], [
    'Inbox/New Note.md', 'Inbox/New Note-01.md', 'Inbox/New Note-02.md',
  ]);
  assert.equal(renamedPaths.length, 3);
  assert.deepEqual(errors, []);
});

test('eligible notes continue while link updates are pending', async () => {
  const { plugin, create, createMatching, move, finishLayout, listeners, timers, errors } = setup();
  const calls = [];
  const links = deferred();
  const lastRename = deferred();
  plugin.app.fileManager.renameFile = (file, path) => {
    calls.push([file, path]);
    if (calls.length === 1) return Promise.resolve();
    move(file, path);
    return calls.length === 2 ? links.promise : lastRename.promise;
  };
  await plugin.onload();
  const other = create('Other.md');
  finishLayout();
  const first = createMatching('First.md');
  const second = createMatching('Second.md');
  const third = createMatching('Third.md');
  await flushQueue();
  assert.deepEqual(calls, [[first, 'Old.md']]);
  move(other, 'Unrelated.md');
  await flushQueue();
  assert.equal(calls.length, 1);

  move(first, 'Old.md');
  await flushQueue();
  assert.deepEqual([first.path, second.path, third.path], ['Old.md', 'Old-01.md', 'Old-02.md']);
  assert.equal(timers.size, 0);
  assert.equal(listeners.rename.size, 1);
  assert.equal(listeners.delete.size, 0);
  links.resolve();
  lastRename.reject(new Error('late link update failure'));
  await flushQueue();
  assert.deepEqual(errors, []);
});

test('suffixes case-insensitive indexed matches and exact disk-only matches', async () => {
  const { plugin, create, disk, finishLayout } = setup();
  await plugin.onload();
  const existing = create('Inbox/OLD.md');
  disk.add('Inbox/Old-01.md');
  const adapter = plugin.app.vault.adapter;
  const exists = adapter.exists;
  adapter.exists = (path, sensitive) => {
    assert.equal(sensitive, undefined);
    return exists(path);
  };
  finishLayout();
  const note = create('Inbox/Untitled.md');
  await flushQueue();
  assert.equal(note.path, 'Inbox/Old-02.md');
  assert.equal(existing.path, 'Inbox/OLD.md');
  assert.ok(disk.has('Inbox/Old-01.md'));
});

test('renames notes in a folder whose listing fails due to an unrelated broken symlink', async () => {
  const { plugin, create, finishLayout, errors } = setup();
  await plugin.onload();
  const adapter = plugin.app.vault.adapter;
  adapter.list = async () => {
    throw Object.assign(new Error('Missing target for Inbox/Unrelated.png'), { code: 'ENOENT' });
  };
  finishLayout();
  const first = create('Inbox/Untitled.md');
  await flushQueue();
  const second = create('Inbox/Untitled.md');
  await flushQueue();
  assert.deepEqual([first.path, second.path], ['Inbox/Old.md', 'Inbox/Old-01.md']);
  assert.deepEqual(errors, []);
});

test('suffixes the name when its desktop destination is a dangling symlink', async () => {
  const checked = [];
  const { plugin, create, finishLayout, renamedPaths, errors } = setup(undefined, {
    async lstat(path) {
      checked.push(path);
      if (path !== '/vault/Inbox/Old.md') {
        throw Object.assign(new Error(`No directory entry at ${path}`), { code: 'ENOENT' });
      }
      return { isSymbolicLink: () => true };
    },
  });
  await plugin.onload();
  finishLayout();

  const note = create('Inbox/Untitled.md');
  await flushQueue();
  assert.equal(note.path, 'Inbox/Old-01.md');
  assert.deepEqual(renamedPaths, ['Inbox/Old-01.md']);
  assert.deepEqual(checked, ['/vault/Inbox/Old.md', '/vault/Inbox/Old-01.md']);
  assert.deepEqual(errors, []);
});

test('skips a desktop rename when the destination entry cannot be checked', async () => {
  const denied = Object.assign(new Error('Cannot inspect the destination'), { code: 'EACCES' });
  const { plugin, create, finishLayout, renamedPaths, errors } = setup(undefined, {
    async lstat() { throw denied; },
  });
  await plugin.onload();
  finishLayout();

  const note = create('Inbox/Untitled.md');
  await flushQueue();
  assert.equal(note.path, 'Inbox/Untitled.md');
  assert.deepEqual(renamedPaths, []);
  assert.deepEqual(errors, [['[Auto Date Rename] Could not rename note:', denied]]);
});

test('uses a case-sensitive check to distinguish the source from a case-only destination', async () => {
  for (const destinationExists of [false, true]) {
    const { plugin, create, disk, finishLayout } = setup({ data: settings('[Old]', 'OLD') });
    await plugin.onload();
    if (destinationExists) disk.add('Inbox/Old.md');
    const adapter = plugin.app.vault.adapter;
    const exists = adapter.exists;
    const checks = [];
    adapter.exists = (path, sensitive) => {
      checks.push([path, sensitive]);
      return path === 'Inbox/Old.md' && !sensitive ? Promise.resolve(true) : exists(path);
    };
    finishLayout();
    const note = create('Inbox/OLD.md');
    await flushQueue();
    assert.equal(note.path, destinationExists ? 'Inbox/Old-01.md' : 'Inbox/Old.md');
    assert.deepEqual(checks, [
      ['Inbox/Old.md', undefined],
      ['Inbox/Old.md', true],
      ...(destinationExists ? [['Inbox/Old-01.md', undefined]] : []),
    ]);
    assert.ok(disk.has('Inbox/Old.md'));
  }
});

test('retries when a rejected rename encounters a newly occupied destination', async () => {
  const { plugin, create, disk, finishLayout, move, errors } = setup();
  const calls = [];
  plugin.app.fileManager.renameFile = async (file, path) => {
    calls.push(path);
    if (calls.length === 1) {
      disk.add('Old.md');
      throw new Error('Destination file already exists');
    }
    move(file, path);
  };
  await plugin.onload();
  finishLayout();
  const note = create('Untitled.md');
  await flushQueue();
  assert.deepEqual(calls, ['Old.md', 'Old-01.md']);
  assert.equal(note.path, 'Old-01.md');
  assert.deepEqual(errors, []);
});

test('a timeout advances the queue and reserves the destination until the source moves or is deleted', async () => {
  for (const change of ['move', 'delete']) {
    const { plugin, createMatching, move, remove, expireRename, finishLayout, listeners, timers, warnings } = setup();
    const delayed = deferred();
    plugin.app.fileManager.renameFile = (file, path) => {
      if (file.path === 'Delayed.md') return delayed.promise;
      move(file, path);
      return Promise.resolve();
    };
    await plugin.onload();
    finishLayout();
    const first = createMatching('Delayed.md');
    const second = createMatching('Second.md');
    await flushQueue();
    assert.equal(second.path, 'Second.md');
    expireRename();
    await flushQueue();
    assert.equal(second.path, 'Old-01.md');
    assert.equal(warnings.length, 1);
    assert.equal(listeners.rename.size, 2);
    assert.equal(listeners.delete.size, 1);

    if (change === 'move') move(first, 'Moved.md');
    else remove(first);
    const third = createMatching('Third.md');
    await flushQueue();
    assert.equal(third.path, 'Old.md');
    assert.equal(timers.size, 0);
    assert.equal(listeners.rename.size, 1);
    assert.equal(listeners.delete.size, 0);
  }
});

test('a rejection after timeout releases the destination and both listeners', async () => {
  const { plugin, createMatching, move, expireRename, finishLayout, listeners, errors } = setup();
  const delayed = deferred();
  plugin.app.fileManager.renameFile = async (file, path) => {
    if (file.path === 'Delayed.md') return delayed.promise;
    move(file, path);
  };
  await plugin.onload();
  finishLayout();
  const first = createMatching('Delayed.md');
  await flushQueue();
  expireRename();
  const second = createMatching('Second.md');
  await flushQueue();
  assert.equal(second.path, 'Old-01.md');
  assert.equal(listeners.rename.size, 2);
  assert.equal(listeners.delete.size, 1);

  delayed.reject(new Error('late rename rejection'));
  await flushQueue();
  assert.equal(listeners.rename.size, 1);
  assert.equal(listeners.delete.size, 0);
  const third = createMatching('Third.md');
  await flushQueue();
  assert.equal(first.path, 'Delayed.md');
  assert.equal(third.path, 'Old.md');
  assert.deepEqual(errors, []);
});

test('unload releases pending and timed-out renames and discards the queued notes', async () => {
  const { plugin, createMatching, finishLayout, expireRename, listeners, timers, warnings } = setup();
  const delayed = deferred();
  const calls = [];
  plugin.app.fileManager.renameFile = (file) => {
    calls.push(file.path);
    return delayed.promise;
  };
  await plugin.onload();
  finishLayout();
  createMatching('First.md');
  createMatching('Second.md');
  createMatching('Third.md');
  await flushQueue();
  expireRename();
  await flushQueue();
  assert.equal(listeners.rename.size, 3);
  assert.equal(timers.size, 1);

  plugin.unload();
  delayed.reject(new Error('late rejection after unload'));
  await flushQueue();
  assert.deepEqual(calls, ['First.md', 'Second.md']);
  assert.equal(warnings.length, 1);
  assert.equal(timers.size, 0);
  assert.ok(Object.values(listeners).every((registered) => registered.size === 0));
});

test('skips a source moved during the disk check and discards checks from an earlier enable', async () => {
  const { plugin, create, move, finishLayout, renamedPaths } = setup();
  const adapter = plugin.app.vault.adapter;
  const exists = adapter.exists;
  await plugin.onload();
  finishLayout();

  const firstCheck = deferred();
  adapter.exists = () => firstCheck.promise;
  const first = create('First/Untitled.md');
  await flushQueue();
  move(first, 'Moved.md');
  firstCheck.resolve(false);
  await flushQueue();
  assert.equal(first.path, 'Moved.md');

  const secondCheck = deferred();
  adapter.exists = () => secondCheck.promise;
  const second = create('Second/Untitled.md');
  await flushQueue();
  plugin.unload();
  adapter.exists = exists;
  await plugin.onload();
  const third = create('Untitled.md');
  secondCheck.resolve(false);
  await flushQueue();
  assert.equal(second.path, 'Second/Untitled.md');
  assert.equal(third.path, 'Old.md');
  assert.deepEqual(renamedPaths, ['Moved.md', 'Old.md']);
});

test('skips renaming a note that already has the normalized name', async () => {
  const storage = { data: settings('[New\u00a0Note]', 'New Note') };
  const { plugin, create, finishLayout, renamedPaths } = setup(storage);
  await plugin.onload();
  finishLayout();
  const note = create('Inbox/New Note.md');
  await flushQueue();

  assert.equal(note.path, 'Inbox/New Note.md');
  assert.deepEqual(renamedPaths, []);
});

test('rejects raw separators that normalizePath would remove', async () => {
  const storage = { data: { filenameFormat: '[New/]' } };
  const { plugin, create, finishLayout } = setup(storage);
  const ui = await openSettings(plugin);
  for (const draft of ['[New/]', '[New\\]']) {
    ui.inputs[filenameLabel].change(draft);
    assert.equal(ui.button.disabled, true);
    assert.match(ui.children[1].textContent, /unsafe/);
  }

  finishLayout();
  const note = create('Inbox/Untitled.md');
  await flushQueue();
  assert.equal(note.path, `Inbox/${defaultFilename}`);
});

test('accepts 247 normalized UTF-8 bytes with room for the longest suffix', async () => {
  const { plugin, create, finishLayout } = setup();
  const ui = await openSettings(plugin);
  const raw = 'e\u0301'.repeat(123) + 'x';
  const base = 'é'.repeat(123) + 'x';
  assert.equal(Buffer.byteLength(base), 247);
  ui.inputs[filenameLabel].change(`[${raw}]`);
  assert.equal(ui.children[0].textContent, `Preview: ${base}.md`);
  assert.equal(ui.button.disabled, false);
  await ui.button.click();

  create(`Inbox/${base}.md`);
  for (let index = 1; index < 9999; index++) {
    create(`Inbox/${base}-${String(index).padStart(2, '0')}.md`);
  }
  finishLayout();
  const note = create('Inbox/Untitled.md');
  await flushQueue();

  assert.equal(note.path, `Inbox/${base}-9999.md`);
  assert.equal(Buffer.byteLength(note.path.split('/').at(-1)), 255);
});

test('blocks a 248-byte draft and falls back when that format is already stored', async () => {
  const oversized = `[${'é'.repeat(124)}]`;
  const storage = { data: { filenameFormat: '[Old]' } };
  const ui = await openSettings(setup(storage).plugin);
  ui.inputs[filenameLabel].change(oversized);
  assert.equal(ui.button.disabled, true);
  assert.match(ui.children[1].textContent, /Shorten the format.*247 UTF-8 bytes/);
  await ui.button.click();
  assert.deepEqual(storage.data, { filenameFormat: '[Old]' });

  storage.data = { filenameFormat: oversized };
  const { plugin, create, finishLayout } = setup(storage);
  await plugin.onload();
  finishLayout();
  const note = create('Inbox/Untitled.md');
  await flushQueue();
  assert.equal(note.path, `Inbox/${defaultFilename}`);
  assert.deepEqual(storage.data, { filenameFormat: oversized });
});
