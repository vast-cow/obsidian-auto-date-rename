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
const oldRecovery = JSON.stringify({ filenameFormat: '[Old]' });

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
  constructor(path, stat) {
    this.path = path;
    this.extension = path.split('.').at(-1);
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

  setName() { return this; }
  setDesc() { return this; }

  addText(build) {
    const input = {
      inputEl: { setAttribute() {} },
      setPlaceholder() { return this; },
      setValue(value) { this.value = value; return this; },
      onChange(change) { this.change = change; return this; },
      setDisabled(disabled) { this.disabled = disabled; },
    };
    build(input);
    this.container.input = input;
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

function setup(storage = { data: { filenameFormat: '[Old]' } }, { lstat } = {}) {
  const errors = [];
  const warnings = [];
  const timers = new Set();
  const module = {};
  let now = creationTime;
  runInNewContext(source, {
    module,
    TextEncoder,
    Date: class extends Date {
      static now() { return now; }
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
  const plugin = new module.exports(app, storage);
  return {
    plugin, storage, errors, warnings, listeners, timers, disk, renamedPaths, move,
    createListeners: listeners.create,
    advanceTime(milliseconds) {
      now += milliseconds;
    },
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
    create(path, stat = { ctime: creationTime }) {
      const file = new TFile(path, stat);
      attach(file, path);
      for (const callback of listeners.create) callback(file);
      return file;
    },
  };
}

async function openSettings(plugin) {
  await plugin.onload();
  plugin.tab.display();
  return plugin.tab.containerEl;
}

test('applies a confirmed save and loads it on the next enable', async () => {
  const { plugin, storage } = setup();
  const ui = await openSettings(plugin);
  ui.input.change('[New]');
  await ui.button.click();

  assert.deepEqual(storage.data, { filenameFormat: '[New]' });
  assert.equal(storage.recovery, undefined);
  assert.equal(plugin.filenameFormat, '[New]');
  assert.equal(ui.children[1].textContent, 'File name format saved.');
  const reopened = await openSettings(setup(storage).plugin);
  assert.equal(reopened.input.value, '[New]');
});

test('skips the write when the exact requested format is already stored', async () => {
  const { plugin, storage } = setup();
  const ui = await openSettings(plugin);
  storage.data = { filenameFormat: '[New]' };
  plugin.saveData = () => assert.fail('unexpected write');

  ui.input.change('[New]');
  await ui.button.click();
  assert.equal(plugin.filenameFormat, '[New]');
  assert.equal(ui.children[1].textContent, 'File name format saved.');
});

test('retains the active format and allows retry after a rejected write', async () => {
  const { plugin, storage, errors } = setup();
  const ui = await openSettings(plugin);
  plugin.saveData = async () => { throw new Error('write failed'); };

  ui.input.change('[New]');
  await ui.button.click();
  assertSaveFailed(plugin, ui, errors);
  assert.deepEqual(storage.data, { filenameFormat: '[Old]' });
  assert.equal(storage.recovery, oldRecovery);

  plugin.saveData = Plugin.prototype.saveData;
  await ui.button.click();
  assert.equal(plugin.filenameFormat, '[New]');
  assert.equal(storage.recovery, undefined);
  assert.equal(ui.children[1].textContent, 'File name format saved.');
});

test('retains the active format when a resolved write does not persist', async () => {
  const { plugin, storage, errors } = setup();
  const ui = await openSettings(plugin);
  plugin.saveData = async () => {};

  ui.input.change('[New]');
  await ui.button.click();
  assertSaveFailed(plugin, ui, errors);
  assert.deepEqual(storage.data, { filenameFormat: '[Old]' });
});

test('requires an exact readback match', async () => {
  const { plugin, storage, errors } = setup();
  const ui = await openSettings(plugin);
  plugin.saveData = async ({ filenameFormat }) => {
    storage.data = { filenameFormat: filenameFormat + ' ' };
  };

  ui.input.change('[New]');
  await ui.button.click();
  assertSaveFailed(plugin, ui, errors);
  assert.equal(storage.recovery, oldRecovery);
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

    ui.input.change('[New]');
    await ui.button.click();
    assertSaveFailed(plugin, ui, errors);
    assert.equal(attempted, false);
    assert.deepEqual(storage.data, { filenameFormat: '[Old]' });
    assert.equal((await openSettings(setup(storage).plugin)).input.value, '[Old]');

    adapter.write = write;
    plugin.saveData = Plugin.prototype.saveData;
    await ui.button.click();
    assert.deepEqual(storage.data, { filenameFormat: '[New]' });
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
  ui.input.change('[New]');
  await ui.button.click();
  assertSaveFailed(plugin, ui, errors);
  assert.equal(storage.data, truncated);
  assert.equal(storage.recovery, oldRecovery);
  plugin.unload();

  const reopened = setup(storage);
  const recoveredUi = await openSettings(reopened.plugin);
  assert.equal(recoveredUi.input.value, '[Old]');
  reopened.finishLayout();
  const note = reopened.create('AfterEnable.md');
  await flushQueue();
  assert.equal(note.path, 'Old.md');

  let rewroteRecovery = false;
  reopened.plugin.app.vault.adapter.write = async () => { rewroteRecovery = true; };
  recoveredUi.input.change('[New]');
  await recoveredUi.button.click();
  assert.equal(rewroteRecovery, false);
  assert.deepEqual(storage.data, { filenameFormat: '[New]' });
  assert.equal(storage.recovery, undefined);
  assert.equal(reopened.plugin.filenameFormat, '[New]');
  assert.equal((await openSettings(setup(storage).plugin)).input.value, '[New]');
});

test('keeps the recovery authoritative until a verified save clears it', async () => {
  const { plugin, storage, errors } = setup();
  const ui = await openSettings(plugin);
  const adapter = plugin.app.vault.adapter;
  const remove = adapter.remove;
  adapter.remove = async () => { throw new Error('Recovery removal failed'); };
  ui.input.change('[New]');
  await ui.button.click();
  assertSaveFailed(plugin, ui, errors);
  assert.deepEqual(storage.data, { filenameFormat: '[New]' });
  assert.equal(storage.recovery, oldRecovery);
  assert.equal((await openSettings(setup(storage).plugin)).input.value, '[Old]');

  adapter.remove = remove;
  await ui.button.click();
  assert.equal(storage.recovery, undefined);
  assert.equal(plugin.filenameFormat, '[New]');
});

function assertSaveFailed(plugin, ui, errors) {
  assert.equal(plugin.filenameFormat, '[Old]');
  assert.match(ui.children[1].textContent, /Could not save the file name format/);
  assert.equal(ui.input.disabled, false);
  assert.equal(ui.button.disabled, false);
  assert.equal(errors.length, 1);
}

test('notes created after layout readiness wait for the loaded format', async () => {
  const { plugin, create, finishLayout } = setup();
  const loading = deferred();
  plugin.loadData = () => loading.promise;
  const renames = [];
  plugin.renameNewNote = (file, format) => renames.push([file.path, format]);
  const startup = plugin.onload();

  create('Existing.md');
  finishLayout();
  create('Early.md');
  await flushQueue();
  assert.deepEqual(renames, []);

  loading.resolve({ filenameFormat: '[Loaded]' });
  await startup;
  await flushQueue();
  assert.deepEqual(renames, [['Early.md', '[Loaded]']]);
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
  plugin.renameNewNote = (file) => renames.push(file.path);
  const startup = plugin.onload();

  finishLayout();
  create('Early.md');
  await flushQueue();
  plugin.unload();
  loading.resolve({ filenameFormat: '[Stale]' });
  await startup;
  await flushQueue();
  assert.deepEqual(renames, []);
});

test('queued notes use the active format at creation and are discarded on disable', async () => {
  const { plugin, create, finishLayout } = setup();
  const ui = await openSettings(plugin);
  finishLayout();
  const firstRename = deferred();
  const secondRename = deferred();
  const renames = [];
  plugin.renameNewNote = (file, format) => {
    renames.push([file.path, format]);
    if (file.path === 'First.md') return firstRename.promise;
    if (file.path === 'Second.md') return secondRename.promise;
  };

  create('First.md');
  create('Second.md');
  await flushQueue();
  assert.deepEqual(renames, [['First.md', '[Old]']]);

  ui.input.change('[New]');
  await ui.button.click();
  create('Discarded.md');
  firstRename.resolve();
  await flushQueue();
  assert.deepEqual(renames, [['First.md', '[Old]'], ['Second.md', '[Old]']]);

  plugin.unload();
  const reopened = await openSettings(plugin);
  assert.equal(reopened.input.value, '[New]');
  create('AfterEnable.md');
  secondRename.resolve();
  await flushQueue();
  assert.deepEqual(renames, [
    ['First.md', '[Old]'], ['Second.md', '[Old]'], ['AfterEnable.md', '[New]'],
  ]);
});

test('a save awaiting readback cannot replace the active format of a later enable', async () => {
  const { plugin, storage } = setup();
  const ui = await openSettings(plugin);
  const readback = deferred();
  const initialRead = plugin.loadData.bind(plugin);
  plugin.saveData = async () => {
    plugin.loadData = () => readback.promise;
  };

  ui.input.change('[Stale]');
  const saving = ui.button.click();
  await flushQueue();
  plugin.unload();
  plugin.loadData = initialRead;
  storage.data = { filenameFormat: '[Reloaded]' };
  await plugin.onload();
  assert.equal(plugin.filenameFormat, '[Old]');
  plugin.tab.display();
  plugin.tab.containerEl.input.change('[Reloaded]');
  plugin.saveData = Plugin.prototype.saveData;
  await plugin.tab.containerEl.button.click();
  readback.resolve({ filenameFormat: '[Stale]' });
  await saving;
  assert.equal(plugin.filenameFormat, '[Reloaded]');
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

test('renames a recent note using its creation time and skips an older synced note', async () => {
  const { plugin, create, finishLayout, renamedPaths } = setup({});
  await plugin.onload();
  finishLayout();

  const synced = create('Inbox/Synced.md', { ctime: creationTime - 5001 });
  const local = create('Inbox/Untitled.md', { ctime: creationTime - 1000 });
  await flushQueue();

  assert.equal(synced.path, 'Inbox/Synced.md');
  assert.equal(local.path, 'Inbox/2026-11-20_12-01-29-123.md');
  assert.deepEqual(renamedPaths, [local.path]);
});

test('skips missing, invalid, non-positive, and excessively future creation times', async () => {
  const { plugin, create, finishLayout, renamedPaths, errors } = setup();
  await plugin.onload();
  finishLayout();

  const invalidStats = [
    null, {}, { ctime: null }, { ctime: NaN }, { ctime: Infinity },
    { ctime: String(creationTime) }, { ctime: 0 }, { ctime: -1 },
    { ctime: creationTime + 2001 },
  ];
  const paths = invalidStats.map((_, index) => `Inbox/Note ${index}.md`);
  const notes = invalidStats.map((stat, index) => create(paths[index], stat));
  await flushQueue();

  assert.deepEqual(notes.map((file) => file.path), paths);
  assert.deepEqual(renamedPaths, []);
  assert.deepEqual(errors, []);
});

test('accepts both endpoints of the creation-time window and suffixes collisions', async () => {
  const { plugin, create, finishLayout, renamedPaths } = setup();
  await plugin.onload();
  finishLayout();

  create('Oldest eligible.md', { ctime: creationTime - 5000 });
  create('Furthest eligible future.md', { ctime: creationTime + 2000 });
  await flushQueue();

  assert.deepEqual(renamedPaths, ['Old.md', 'Old-01.md']);
});

test('uses the normalized preview name on disk and numbers collisions', async () => {
  const { plugin, create, finishLayout, renamedPaths, errors } = setup();
  const ui = await openSettings(plugin);
  ui.input.change('[New\u00a0Note]');
  assert.equal(ui.children[0].textContent, 'Preview: New Note.md');
  await ui.button.click();

  finishLayout();
  const first = create('Inbox/Untitled.md');
  const second = create('Inbox/Untitled 1.md');
  const third = create('Inbox/Untitled 2.md');
  await flushQueue();
  assert.deepEqual([first.path, second.path, third.path], [
    'Inbox/New Note.md', 'Inbox/New Note-01.md', 'Inbox/New Note-02.md',
  ]);
  assert.equal(renamedPaths.length, 3);
  assert.deepEqual(errors, []);
});

test('eligible notes stay queued past the age limit and continue while link updates are pending', async () => {
  const { plugin, create, move, finishLayout, advanceTime, listeners, timers, errors } = setup();
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
  const first = create('First.md');
  const second = create('Second.md');
  const third = create('Third.md');
  await flushQueue();
  assert.deepEqual(calls, [[first, 'Old.md']]);
  advanceTime(6000);
  move(other, 'Unrelated.md');
  await flushQueue();
  assert.equal(calls.length, 1);

  move(first, 'Old.md');
  await flushQueue();
  assert.deepEqual([first.path, second.path, third.path], ['Old.md', 'Old-01.md', 'Old-02.md']);
  assert.equal(timers.size, 0);
  assert.equal(listeners.rename.size, 0);
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
  const second = create('Inbox/Untitled 1.md');
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
    const { plugin, create, disk, finishLayout } = setup();
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
    const { plugin, create, move, remove, expireRename, finishLayout, listeners, timers, warnings } = setup();
    const delayed = deferred();
    plugin.app.fileManager.renameFile = (file, path) => {
      if (file.path === 'Delayed.md') return delayed.promise;
      move(file, path);
      return Promise.resolve();
    };
    await plugin.onload();
    finishLayout();
    const first = create('Delayed.md');
    const second = create('Second.md');
    await flushQueue();
    assert.equal(second.path, 'Second.md');
    expireRename();
    await flushQueue();
    assert.equal(second.path, 'Old-01.md');
    assert.equal(warnings.length, 1);
    assert.equal(listeners.rename.size, 1);
    assert.equal(listeners.delete.size, 1);

    if (change === 'move') move(first, 'Moved.md');
    else remove(first);
    const third = create('Third.md');
    await flushQueue();
    assert.equal(third.path, 'Old.md');
    assert.equal(timers.size, 0);
    assert.equal(listeners.rename.size, 0);
    assert.equal(listeners.delete.size, 0);
  }
});

test('a rejection after timeout releases the destination and both listeners', async () => {
  const { plugin, create, move, expireRename, finishLayout, listeners, errors } = setup();
  const delayed = deferred();
  plugin.app.fileManager.renameFile = async (file, path) => {
    if (file.path === 'Delayed.md') return delayed.promise;
    move(file, path);
  };
  await plugin.onload();
  finishLayout();
  const first = create('Delayed.md');
  await flushQueue();
  expireRename();
  const second = create('Second.md');
  await flushQueue();
  assert.equal(second.path, 'Old-01.md');
  assert.equal(listeners.rename.size, 1);
  assert.equal(listeners.delete.size, 1);

  delayed.reject(new Error('late rename rejection'));
  await flushQueue();
  assert.equal(listeners.rename.size, 0);
  assert.equal(listeners.delete.size, 0);
  const third = create('Third.md');
  await flushQueue();
  assert.equal(first.path, 'Delayed.md');
  assert.equal(third.path, 'Old.md');
  assert.deepEqual(errors, []);
});

test('unload releases pending and timed-out renames and discards the queued notes', async () => {
  const { plugin, create, finishLayout, expireRename, listeners, timers, warnings } = setup();
  const delayed = deferred();
  const calls = [];
  plugin.app.fileManager.renameFile = (file) => {
    calls.push(file.path);
    return delayed.promise;
  };
  await plugin.onload();
  finishLayout();
  create('First.md');
  create('Second.md');
  create('Third.md');
  await flushQueue();
  expireRename();
  await flushQueue();
  assert.equal(listeners.rename.size, 2);
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
  const first = create('First.md');
  await flushQueue();
  move(first, 'Moved.md');
  firstCheck.resolve(false);
  await flushQueue();
  assert.equal(first.path, 'Moved.md');

  const secondCheck = deferred();
  adapter.exists = () => secondCheck.promise;
  const second = create('Second.md');
  await flushQueue();
  plugin.unload();
  adapter.exists = exists;
  await plugin.onload();
  const third = create('Third.md');
  secondCheck.resolve(false);
  await flushQueue();
  assert.equal(second.path, 'Second.md');
  assert.equal(third.path, 'Old.md');
  assert.deepEqual(renamedPaths, ['Moved.md', 'Old.md']);
});

test('skips renaming a note that already has the normalized name', async () => {
  const storage = { data: { filenameFormat: '[New\u00a0Note]' } };
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
    ui.input.change(draft);
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
  ui.input.change(`[${raw}]`);
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
  ui.input.change(oversized);
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
