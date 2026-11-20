'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../main.js'), 'utf8');

class Plugin {
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
    require(name) {
      assert.equal(name, 'obsidian');
      return {
        Plugin,
        PluginSettingTab,
        Setting,
        moment: () => ({ format: (format) => format.replace(/\[([^\]]*)\]/g, '$1') }),
      };
    },
    console: { error: (...args) => errors.push(args) },
  }, { filename: 'main.js' });

  const app = { workspace: { onLayoutReady() {} } };
  const plugin = new module.exports(app, storage);
  return { plugin, storage, errors };
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
