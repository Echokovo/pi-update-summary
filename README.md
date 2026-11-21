# pi-update-summary

Fetches changelogs for Pi packages with updates waiting — including pi itself — or for one npm package or GitHub repository, writes every source to local files, and asks the model to summarize them.

> [!IMPORTANT]
> This is a fork of [`mblarsen/pi-extensions`](https://github.com/mblarsen/pi-extensions), package [`@mblarsen/pi-update-changelog`](https://www.npmjs.com/package/@mblarsen/pi-update-changelog) by [Michael Bøcker-Larsen](https://github.com/mblarsen). It is extracted from that monorepo and keeps only the on-demand changelog summarizer. The `package_changelog` tool is not registered by default. Everything else is upstream work under the original MIT license.

## Install

From git:

```bash
pi install git:github.com/Echokovo/pi-update-summary
pi install git:github.com/Echokovo/pi-update-summary@v0.3.0  # pin a release
```

Or clone it and point Pi at the directory:

```bash
git clone git@github.com:Echokovo/pi-update-summary.git ~/pi-update-summary
pi install ~/pi-update-summary
```

## Usage

| Command | Description |
|---|---|
| `/update-summary [package]` | Fetch changelogs to local files and ask the model to summarize them from those files |

`package` is optional. Without it the command checks every installed package and summarizes the ones with a pending update. With it, the command summarizes exactly one target:

```
/update-summary            # every package with a pending update, plus pi itself
/update-summary pi-task-ui # one npm package
/update-summary owner/repo # one GitHub repository
/update-summary pi         # the running pi build
```

For npm packages the command collects published GitHub releases, `CHANGELOG.md`, the commits between the installed and latest version, and a changelog section from the readme. When none of those exist it falls back to recent commits and then to the readme. For git-installed packages it reads the pending commits, recent commits, and a local `CHANGELOG.md`.

pi itself is not listed in `settings.json`. The command compares the running build against `@earendil-works/pi-coding-agent` on npm, reports it as `pi` when a newer version exists, and uses GitHub releases only — the repository is a monorepo whose commit log mixes unrelated packages.

Each run writes one directory per package under `os.tmpdir()/pi/update-summary/<run-id>/`, with one file per source (`releases.md`, `changelog.md`, `commits.md`, `readme-changelog.md`, `recent-commits.md`, `readme.md`). Nothing is truncated. The injected message is visible in the transcript, expands to the file list, and tells the model to read the files instead of fetching the same sources again over the network. A package where nothing could be fetched is listed without a file, so an empty result is distinguishable from "nothing changed". The directory lives under the OS temp directory and is left in place for the session.

On the first run in a fresh session the command also names the session `[YYMMDD] Update Summary`, so it is easy to spot in the session list.

## LLM tool

`package_changelog` — fetch changelog and release notes for an npm package or GitHub repository. Shows version history and recent changes.

**The tool is not registered by default.** A registered tool is part of every request, even when unused, so the default keeps it out and `/update-summary` does the same job on demand.

To put the tool back in every request, opt in from `~/.pi/agent/settings.json`:

```json
{
  "updateSummary": {
    "tool": true
  }
}
```

`true` (or `"always"`) registers the tool. `false`, `"auto"`, `"off"`, or no setting at all leaves it unregistered. The legacy `updateChangelog` block is still read when `updateSummary` is absent. An unrecognized value is reported as a warning instead of being guessed at. Restart Pi for a change to take effect.

> [!TIP]
> Set `export PI_OFFLINE=1` to disable Pi's built-in startup package update check and fetch changelogs on demand with `/update-summary` instead.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs the typecheck, the tests, and a `npm pack --dry-run` that verifies which files would be published.
