#!/usr/bin/env bun
import { grab, DEFAULT_PATTERNS } from "./grab.ts";
import { setup, type SetupPreset } from "./setup.ts";

const HELP = `gh-grab — download GitHub Actions / release artifacts

Usage:
  gh-grab [options]
  gh-grab setup --rust|--tauri|--android [--force]

Options:
  -R, --repo owner/repo   Target repository (default: current checkout)
  -D, --dir <path>        Download directory (default: ./artifacts or $GH_GRAB_DIR)
  -p, --pattern <glob>    Keep only matching files (repeatable)
                          Default: ${DEFAULT_PATTERNS.join(", ")}
      --release           Download latest GitHub Release assets instead of a run
      --wait              Wait for an in-progress/queued run (or poll) then download
      --keep-all          Keep every downloaded file (same as -p '*')
  -h, --help              Show this help

Setup:
  gh-grab setup --rust       Write .github/workflows/gh-grab-rust.yml
  gh-grab setup --tauri      Write .github/workflows/gh-grab-tauri.yml
  gh-grab setup --android    Write .github/workflows/gh-grab-android.yml
  gh-grab setup --rust --tauri --force

Examples:
  gh-grab
  gh-grab -p "*.exe" -p "*.apk"
  gh-grab --release -D ./downloads
  gh-grab --wait -R owner/repo
  gh-grab setup --tauri
`;

type Parsed = {
  command: "grab" | "setup" | "help";
  repo?: string;
  dir?: string;
  patterns: string[];
  release: boolean;
  wait: boolean;
  keepAll: boolean;
  force: boolean;
  presets: SetupPreset[];
};

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    command: "grab",
    patterns: [],
    release: false,
    wait: false,
    keepAll: false,
    force: false,
    presets: [],
  };

  const args = argv.slice(2);
  let i = 0;

  if (args[0] === "setup") {
    out.command = "setup";
    i = 1;
  }

  while (i < args.length) {
    const a = args[i]!;
    switch (a) {
      case "-h":
      case "--help":
        out.command = "help";
        return out;
      case "-R":
      case "--repo":
        out.repo = args[++i];
        break;
      case "-D":
      case "--dir":
        out.dir = args[++i];
        break;
      case "-p":
      case "--pattern":
        out.patterns.push(args[++i]!);
        break;
      case "--release":
        out.release = true;
        break;
      case "--wait":
        out.wait = true;
        break;
      case "--keep-all":
        out.keepAll = true;
        break;
      case "--force":
        out.force = true;
        break;
      case "--rust":
        out.presets.push("rust");
        break;
      case "--tauri":
        out.presets.push("tauri");
        break;
      case "--android":
        out.presets.push("android");
        break;
      default:
        throw new Error(`Unknown argument: ${a}\n\n${HELP}`);
    }
    i++;
  }

  return out;
}

async function main() {
  let parsed: Parsed;
  try {
    parsed = parseArgs(Bun.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  if (parsed.command === "help") {
    console.log(HELP);
    return;
  }

  try {
    if (parsed.command === "setup") {
      await setup({
        presets: [...new Set(parsed.presets)],
        force: parsed.force,
      });
      return;
    }

    await grab({
      repo: parsed.repo,
      dir: parsed.dir,
      patterns: parsed.patterns.length ? parsed.patterns : undefined,
      release: parsed.release,
      wait: parsed.wait,
      keepAll: parsed.keepAll,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

await main();
