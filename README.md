# claude

My Claude Code things, in one place: [mods](https://code.claude.com/docs/en/plugins/mods), plugins and whatever else turns up. The repository is a plugin marketplace, so anything under `plugins/` installs with one line.

## Install

In a Claude Code terminal session, add the marketplace once:

```
/plugin marketplace add ref/claude
```

Then install what you want from it:

```
/plugin install usage-pacer@ref
```

Pick the user scope when asked, and the plugin is active in that session and every one after. `/plugin` → **Installed** lists what you have; `claude plugin update usage-pacer@ref` pulls a new version.

## Plugins

| Plugin | What it does |
| --- | --- |
| [usage-pacer](plugins/usage-pacer) | Mod. Paces the weekly usage limit day by day for the projects you mark with `/pacer on`: a side project is paused once the account runs ahead of its daily share, so your main work keeps its budget. One bar above the prompt shows where you stand. |

Each plugin's folder has its own README with settings and details.

## Layout

```
.claude-plugin/marketplace.json   the catalog: one entry per plugin
plugins/<name>/                   one plugin per folder
```

Other kinds of things get their own top-level folder as they appear.

## Develop

From a plugin's folder:

```
claude plugin validate .
claude plugin test
claude --plugin-dir .      # run it for one session without installing
```

`claude plugin validate .` at the repository root checks the marketplace file and every listed plugin in one run.

## License

MIT
