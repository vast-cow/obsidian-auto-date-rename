# Auto Date Rename (Obsidian Local Plugin)

This plugin automatically renames all newly created Markdown note files in Obsidian to include the file creation date and time.

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
- Applies to new Markdown notes created by templates or other plugins. File additions via synchronization or external apps may also be detected as "newly created."
- Uses the file's `ctime` for the date and time and displays it in the local time of the device running Obsidian. For files brought in via synchronization, this value may differ from the current time.

## Notes

Please test the plugin in a test vault first. There is no function to rename existing notes in bulk. The behavior regarding new file events and conflicts with other plugins may vary depending on your environment.
