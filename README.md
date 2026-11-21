# Auto Date Rename (Obsidian Local Plugin)

This plugin automatically renames eligible new Markdown notes in Obsidian using their creation date and time.

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

- Only applies to `.md` files created **after** the plugin is enabled (existing notes are not modified).
- Preserves the original folder structure.
- If a file with the same name already exists, it appends a suffix like `-01`, `-02`, etc.
- Renames files using Obsidian's `fileManager.renameFile()` (internal link updates depend on Obsidian's settings and behavior).
- Checks the file's creation timestamp (`ctime`) when Obsidian delivers the create event, before queuing the rename. The timestamp must be a finite, positive number and fall between **5 seconds before** and **2 seconds after** the event is received, inclusive.
- Uses that timestamp to generate the filename in the local time of the device running Obsidian. If the note already has the generated name, it is left as is.

## File name format

Open **Settings → Auto Date Rename**, enter a Moment.js format in **File name format**, and check the `.md` preview. Click **Save** to apply the format to new Markdown notes. See the [Moment.js format tokens](https://momentjs.com/docs/#/displaying/format/).

- `YYYY-MM-DD` produces `2026-11-20.md`.
- `YYYYMMDD_HHmm` produces `20261120_1201.md`.

The normalized base filename can be up to **247 UTF-8 bytes**, leaving room for `.md` and a collision suffix as long as `-9999` within the 255-byte filename limit. If a saved format produces a longer name, the plugin uses the default format for that note.

To restore the default `YYYY-MM-DD_HH-mm-ss-SSS`, clear the field and click **Save**.

## Notes

The timestamp check helps skip older notes from Self-hosted LiveSync or other sync tools that preserve the original creation time. It is a best-effort filter. A synced note can still be renamed if it arrives within the five-second window or if the sync tool assigns it a fresh timestamp. A local note can be skipped if its create event arrives more than five seconds after its recorded creation time.

Please test the plugin in a test vault first. There is no function to rename existing notes in bulk. The behavior regarding new file events and conflicts with other plugins may vary depending on your environment.
