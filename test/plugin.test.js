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

function normalizePath(path) {
  const normalized = path.replace(/[\\/]+/g, '/').replace(/^\/|\/$/g, '');
  return (normalized || '/').replace(/\u00a0/g, ' ').normalize('NFC');
}

class Plugin {
  subscriptions = [];

  constructor(app, storage) {
    this.app = app;
    this.storage = storage;
  }

  async loadData() {
    return structuredClone(this.storage.data);
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
  constructor(path) {
    this.path = path;
    this.extension = path.split('.').at(-1);
    this.parent = { path: path.slice(0, path.lastIndexOf('/') + 1).replace(/\/$/, '') || '/' };
    this.stat = { ctime: creationTime };
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

function setup(storage = { data: { filenameFormat: '[Old]' } }) {
  const errors = [];
  const module = {};
  runInNewContext(source, {
    module,
    TextEncoder,
    require(name) {
      assert.equal(name, 'obsidian');
      return {
        Plugin,
        PluginSettingTab,
        Setting,
        TFile,
        normalizePath,
        moment: () => ({ format: (format) => format.replace(/\[([^\]]*)\]/g, '$1') }),
      };
    },
    console: { error: (...args) => errors.push(args) },
  }, { filename: 'main.js' });

  const layoutCallbacks = [];
  const createListeners = new Set();
  const files = new Map();
  const renamedPaths = [];
  let layoutReady = false;
  const app = {
    workspace: {
      onLayoutReady(callback) {
        if (layoutReady) callback();
        else layoutCallbacks.push(callback);
      },
    },
    vault: {
      on(event, callback) {
        assert.equal(event, 'create');
        createListeners.add(callback);
        return () => createListeners.delete(callback);
      },
      getAbstractFileByPath(path) {
        return files.get(path) ?? null;
      },
    },
    fileManager: {
      async renameFile(file, path) {
        assert.equal(path, normalizePath(path));
        assert.equal(files.has(path), false, `Cannot overwrite ${path}`);
        files.delete(file.path);
        file.path = path;
        files.set(path, file);
        renamedPaths.push(path);
      },
    },
  };
  const plugin = new module.exports(app, storage);
  return {
    plugin, storage, errors, createListeners, renamedPaths,
    finishLayout() {
      layoutReady = true;
      for (const callback of layoutCallbacks.splice(0)) callback();
    },
    create(path) {
      const file = new TFile(path);
      files.set(path, file);
      for (const callback of createListeners) callback(file);
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

  plugin.saveData = Plugin.prototype.saveData;
  await ui.button.click();
  assert.equal(plugin.filenameFormat, '[New]');
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
  readback.resolve({ filenameFormat: '[Stale]' });
  await saving;
  assert.equal(plugin.filenameFormat, '[Reloaded]');
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

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
