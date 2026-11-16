# gh-grab

Download GitHub Actions run artifacts (or release assets) from the current repo, and scaffold CI build workflows for Rust / Tauri / Android.

Built for the workflow: **edit locally → push → CI builds → grab binaries**, so large release compiles do not eat your SSD or block on a shared Cargo target dir.

## Requirements

- [Bun](https://bun.sh/) ≥ 1.1 (CI / `bun run verify` needs a build with `bun lint` + `bun fmt`, e.g. canary)
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated (`gh auth login`)

## Install

Global (from GitHub):

```bash
bun add -g github:involvex/gh-grab
gh-grab --help
```

Local checkout:

```bash
bun install
bun link
# or: bun run src/cli.ts --help
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
gh-grab --workflow gh-grab-rust
gh-grab --into-target
gh-grab --keep-all
gh-grab --release -D ./downloads
gh-grab --wait
gh-grab -R owner/repo
```

| Flag | Meaning |
| --- | --- |
| `-R, --repo` | Another repository |
| `-D, --dir` | Download directory (cache) |
| `-p, --pattern` | Glob filter (repeatable) |
| `--workflow <name>` | Only consider runs of this workflow |
| `--into-target` | Copy kept `*.exe` into `$CARGO_TARGET_DIR/release` (fallback `./target/release`) |
| `--release` | Latest GitHub Release assets instead of a run |
| `--wait` | Watch/poll until a successful run, then download |
| `--keep-all` | Do not filter downloaded files |

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
gh-grab --wait --workflow gh-grab-rust --into-target
```

## Strategy tip

Keep source + registry on SSD. Prefer CI for release binaries. Store downloaded artifacts on HDD if you need space (`--dir`). Use `--into-target` so tools that expect `target/release/*.exe` still find them. Use local `cargo check` / debug builds only when you need a debugger.
