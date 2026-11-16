# gh-grab

Download GitHub Actions run artifacts (or release assets) from the current repo, and scaffold CI build workflows for Rust / Tauri / Android.

Built for the workflow: **edit locally → push → CI builds → grab binaries**, so large release compiles do not eat your SSD or block on a shared Cargo target dir.

## Requirements

- [Bun](https://bun.sh/) ≥ 1.1
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated (`gh auth login`)

## Install

```bash
bun install
bun link
```

Or run without linking:

```bash
bun run src/cli.ts --help
```

## Verify

```bash
bun check      # typecheck
bun lint       # lint
bun fmt        # format
bun run verify # check + lint + fmt --check
```


## Grab artifacts

From inside a GitHub checkout:

```bash
gh-grab
```

Finds the latest **successful** workflow run and downloads its artifacts into `./artifacts` (override with `--dir` or `GH_GRAB_DIR`). By default only keeps:

`*.exe` `*.apk` `*.msi` `*.dmg` `*.AppImage`

```bash
gh-grab -p "*.exe" -p "*.apk"
gh-grab --keep-all
gh-grab --release -D ./downloads
gh-grab --wait
gh-grab -R owner/repo
```

| Flag            | Meaning                                          |
| --------------- | ------------------------------------------------ |
| `-R, --repo`    | Another repository                               |
| `-D, --dir`     | Download directory                               |
| `-p, --pattern` | Glob filter (repeatable)                         |
| `--release`     | Latest GitHub Release assets instead of a run    |
| `--wait`        | Watch/poll until a successful run, then download |
| `--keep-all`    | Do not filter downloaded files                   |

## Setup CI workflows

```bash
gh-grab setup --rust
gh-grab setup --tauri
gh-grab setup --android
gh-grab setup --rust --tauri --force
```

Writes under `.github/workflows/`:

- `gh-grab-rust.yml` — Windows `cargo build --release`, upload `*.exe`
- `gh-grab-tauri.yml` — Windows Tauri build, upload bundle/`*.exe`/`*.msi`
- `gh-grab-android.yml` — Gradle or Tauri Android APK upload

Templates are starters. Adjust paths for your layout, then:

```bash
git add .github && git commit -m "ci: add gh-grab build workflows" && git push
gh-grab --wait
```

## Strategy tip

Keep source + registry on SSD. Prefer CI for `--release` binaries. Store downloaded artifacts on HDD if you need space. Use local `cargo check` / debug builds only when you need a debugger.
