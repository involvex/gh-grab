import { copyFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  downloadRelease,
  downloadRun,
  ensureGhAuth,
  ensureGhAvailable,
  listCompletedRuns,
  listRecentRuns,
  listRunArtifactNames,
  resolveRepo,
  watchRun,
  type GhRun,
} from "./gh.ts";

export const DEFAULT_PATTERNS = [
  "*.exe",
  "*.apk",
  "*.msi",
  "*.dmg",
  "*.AppImage",
];

export type GrabOptions = {
  repo?: string;
  dir?: string;
  patterns?: string[];
  release?: boolean;
  wait?: boolean;
  keepAll?: boolean;
  workflow?: string;
  intoTarget?: boolean;
};

function expandEnvDir(dir: string | undefined): string {
  if (dir) return dir;
  return process.env.GH_GRAB_DIR || "./artifacts";
}

function cargoReleaseDir(): string {
  const target = process.env.CARGO_TARGET_DIR || "./target";
  return join(target, "release");
}

function matchGlob(name: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(name, p));
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function filterArtifacts(
  dir: string,
  patterns: string[],
): Promise<{ kept: string[]; removed: number }> {
  if (patterns.includes("*")) {
    const files = await walkFiles(dir);
    return { kept: files.map((f) => relative(dir, f)), removed: 0 };
  }

  const files = await walkFiles(dir);
  const kept: string[] = [];
  let removed = 0;

  for (const file of files) {
    const base = basename(file);
    if (matchesAny(base, patterns)) {
      kept.push(relative(dir, file));
    } else {
      await unlink(file);
      removed++;
    }
  }

  return { kept, removed };
}

function pickLatestSuccess(runs: GhRun[]): GhRun | undefined {
  return runs.find((r) => r.conclusion === "success");
}

async function waitForSuccess(repo: string, workflow?: string): Promise<GhRun> {
  console.log(
    workflow
      ? `Waiting for a successful run of workflow "${workflow}"...`
      : "Waiting for a successful workflow run...",
  );

  const recent = await listRecentRuns(repo, 10, workflow);
  const inProgress = recent.find(
    (r) =>
      r.status === "in_progress" ||
      r.status === "queued" ||
      r.status === "pending",
  );

  if (inProgress) {
    console.log(
      `Watching run ${inProgress.databaseId}: ${inProgress.displayTitle || inProgress.name}`,
    );
    try {
      await watchRun(repo, inProgress.databaseId);
    } catch {
      // watch exits non-zero on failure; re-check below
    }
  } else {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const completed = await listCompletedRuns(repo, 5, workflow);
      const success = pickLatestSuccess(completed);
      if (success) return success;
      await Bun.sleep(15_000);
    }
    throw new Error("Timed out waiting for a successful workflow run.");
  }

  const completed = await listCompletedRuns(repo, 30, workflow);
  const success = pickLatestSuccess(completed);
  if (!success) {
    throw new Error("No successful workflow run found after waiting.");
  }
  return success;
}

async function copyExesIntoTarget(
  artifactDir: string,
  keptRelPaths: string[],
): Promise<string[]> {
  const destDir = cargoReleaseDir();
  await mkdir(destDir, { recursive: true });
  const copied: string[] = [];

  for (const rel of keptRelPaths) {
    const base = basename(rel);
    if (!matchGlob(base, "*.exe")) continue;
    const src = join(artifactDir, rel);
    const dest = join(destDir, base);
    await copyFile(src, dest);
    copied.push(dest);
  }

  return copied;
}

function printSummary(opts: {
  run?: GhRun;
  dir: string;
  kept: string[];
  removed?: number;
  intoTargetPaths?: string[];
}) {
  if (opts.run?.url) {
    console.log(`Run:  ${opts.run.url}`);
  } else if (opts.run) {
    console.log(`Run:  ${opts.run.databaseId} (${opts.run.name})`);
  }
  if (opts.removed !== undefined) {
    console.log(
      `Kept ${opts.kept.length} matching file(s), removed ${opts.removed} other file(s)`,
    );
  } else {
    console.log(`Kept ${opts.kept.length} file(s) in ${opts.dir}`);
  }
  for (const f of opts.kept) {
    console.log(`  ${join(opts.dir, f)}`);
  }
  if (opts.intoTargetPaths && opts.intoTargetPaths.length > 0) {
    console.log(
      `Copied ${opts.intoTargetPaths.length} exe(s) into cargo release:`,
    );
    for (const p of opts.intoTargetPaths) console.log(`  ${p}`);
  } else if (opts.intoTargetPaths) {
    console.log("No *.exe matched for --into-target");
  }
}

export async function grab(options: GrabOptions = {}): Promise<void> {
  await ensureGhAvailable();
  await ensureGhAuth();

  const repo = await resolveRepo(options.repo);
  const dir = expandEnvDir(options.dir);
  const patterns =
    options.patterns && options.patterns.length > 0
      ? options.patterns
      : DEFAULT_PATTERNS;
  const keepAll = options.keepAll || patterns.includes("*");
  const workflow = options.workflow;

  await mkdir(dir, { recursive: true });

  console.log(`Repo: ${repo}`);
  console.log(`Dir:  ${dir}`);
  if (workflow) console.log(`Workflow: ${workflow}`);

  if (options.release) {
    console.log(
      `Downloading latest release assets (patterns: ${patterns.join(", ")})...`,
    );
    await downloadRelease(repo, dir, patterns);
    const files = await walkFiles(dir);
    const kept = files.map((f) => relative(dir, f));
    let intoTargetPaths: string[] | undefined;
    if (options.intoTarget) {
      intoTargetPaths = await copyExesIntoTarget(dir, kept);
    }
    printSummary({ dir, kept, intoTargetPaths });
    return;
  }

  let candidates: GhRun[];

  if (options.wait) {
    candidates = [await waitForSuccess(repo, workflow)];
  } else {
    const runs = await listCompletedRuns(repo, 30, workflow);
    candidates = runs.filter((r) => r.conclusion === "success");
  }

  if (candidates.length === 0) {
    throw new Error(
      workflow
        ? `No successful run found for workflow "${workflow}" in ${repo}.`
        : `No successful workflow run found for ${repo}. Push a build workflow or pass --wait / --release.`,
    );
  }

  let downloadedRun: GhRun | undefined;

  for (const run of candidates) {
    const label = `${run.displayTitle || run.name} (${run.headBranch})`;
    const names = await listRunArtifactNames(repo, run.databaseId);
    if (names.length === 0) {
      console.log(`Skip run ${run.databaseId}: ${label} — no artifacts`);
      continue;
    }

    console.log(
      `Downloading run ${run.databaseId}: ${label} [${names.join(", ")}]`,
    );
    try {
      await downloadRun(repo, run.databaseId, dir);
      downloadedRun = run;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no valid artifacts/i.test(msg)) {
        console.log("  (download reported no artifacts — trying older run)");
        continue;
      }
      throw err;
    }
  }

  if (!downloadedRun) {
    throw new Error(
      `No workflow artifacts found among the latest successful runs for ${repo}. Try --release or trigger a build workflow.`,
    );
  }

  let kept: string[];
  let removed: number | undefined;

  if (keepAll) {
    const files = await walkFiles(dir);
    kept = files.map((f) => relative(dir, f));
  } else {
    const filtered = await filterArtifacts(dir, patterns);
    kept = filtered.kept;
    removed = filtered.removed;
  }

  let intoTargetPaths: string[] | undefined;
  if (options.intoTarget) {
    intoTargetPaths = await copyExesIntoTarget(dir, kept);
  }

  printSummary({
    run: downloadedRun,
    dir,
    kept,
    removed,
    intoTargetPaths,
  });

  try {
    await stat(dir);
  } catch {
    /* ignore */
  }
}
