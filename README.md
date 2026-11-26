# Auto Date Rename (Obsidian Local Plugin)

This plugin automatically renames new Markdown notes in Obsidian when their title exactly matches the configured target. It uses the note's creation date and time for the new name.

Example: `2026-11-20_12-01-30-123.md`

## Installation

1. Open your Obsidian vault folder.
2. Open the `<vault>/.obsidian/plugins/` folder (create it if it doesn't exist). `.obsidian` may be a hidden folder.
3. Copy the entire `obsidian-auto-date-rename` folder into the `plugins` folder.
4. Restart (or reload) Obsidian.
5. In **Settings → Community plugins**, enable community plugins and turn on **Auto Date Rename**.

Folder structure:

```
<vault>/.obsidian/plugins/obsidian-auto-date-rename/
  manifest.json
  main.js
  README.md
```

## Features

- Listens for new `.md` files after Obsidian's workspace is ready. Existing notes are left as they are at startup.
- Preserves the original folder structure.
- If a file with the same name already exists, it appends a suffix like `-01`, `-02`, etc.
- Renames files using Obsidian's `fileManager.renameFile()` (internal link updates depend on Obsidian's settings and behavior).
- Checks the title at the time of the create event, including case and whitespace. The plugin skips the automatic rename if you rename or move the note before it starts.
- Uses the file's creation timestamp (`ctime`) in the local time of the device running Obsidian. The plugin skips the rename if the timestamp is missing or invalid, or if the note already has the generated name.

## File name format

Open **Settings → Auto Date Rename**, enter a Moment.js format in **File name format**, and check the `.md` preview. Click **Save** to apply the format and the target title together. See the [Moment.js format tokens](https://momentjs.com/docs/#/displaying/format/).

- `YYYY-MM-DD` produces `2026-11-20.md`.
- `YYYYMMDD_HHmm` produces `20261120_1201.md`.

The normalized base filename can be up to **247 UTF-8 bytes**, leaving room for `.md` and a collision suffix as long as `-9999` within the 255-byte filename limit. If a saved format produces a longer name, the plugin uses the default format for that note.

To restore the default `YYYY-MM-DD_HH-mm-ss-SSS`, clear the field and click **Save**.

Saved date formats from earlier versions are carried over, including formats in the settings recovery file.

## Target title

Enter the exact file name without `.md` in **Target title**. To restore the default, clear the field and click **Save**. The default is `無題のファイル` when Obsidian's display language is Japanese and `Untitled` in all other display languages.

For example, with Obsidian set to Japanese, enter `Untitled` in **Target title** to rename new `Untitled.md` files. A new `Untitled 1.md`, `untitled.md`, or `Copy of Meeting Notes.md` keeps its original name with that setting.

## Notes

Files added by copying or syncing follow the same exact-title rule when Obsidian emits a create event. A matching file with an older creation timestamp is renamed using that timestamp.

Please test the plugin in a test vault first. There is no function to rename existing notes in bulk. The behavior regarding new file events and conflicts with other plugins may vary depending on your environment.
