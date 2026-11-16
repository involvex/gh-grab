import { mkdir, readdir, unlink, stat } from "node:fs/promises";
import { join, relative } from "node:path";
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
};

function expandEnvDir(dir: string | undefined): string {
  if (dir) return dir;
  return process.env.GH_GRAB_DIR || "./artifacts";
}

function matchGlob(name: string, pattern: string): boolean {
  // Simple glob: * and ? only, case-insensitive for Windows friendliness
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
    const base = file.split(/[/\\]/).pop() || file;
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

async function waitForSuccess(repo: string): Promise<GhRun> {
  console.log("Waiting for a successful workflow run...");

  // Prefer watching an in-progress run if one exists
  const recent = await listRecentRuns(repo, 10);
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
    // Poll until a completed success appears (or timeout ~30 min)
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const completed = await listCompletedRuns(repo, 5);
      const success = pickLatestSuccess(completed);
      if (success) return success;
      await Bun.sleep(15_000);
    }
    throw new Error("Timed out waiting for a successful workflow run.");
  }

  const completed = await listCompletedRuns(repo, 30);
  const success = pickLatestSuccess(completed);
  if (!success) {
    throw new Error("No successful workflow run found after waiting.");
  }
  return success;
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

  await mkdir(dir, { recursive: true });

  console.log(`Repo: ${repo}`);
  console.log(`Dir:  ${dir}`);

  if (options.release) {
    console.log(
      `Downloading latest release assets (patterns: ${patterns.join(", ")})...`,
    );
    await downloadRelease(repo, dir, patterns);
    const files = await walkFiles(dir);
    console.log(`Downloaded ${files.length} file(s) into ${dir}`);
    for (const f of files) console.log(`  ${relative(dir, f)}`);
    return;
  }

  let candidates: GhRun[];

  if (options.wait) {
    candidates = [await waitForSuccess(repo)];
  } else {
    const runs = await listCompletedRuns(repo, 30);
    candidates = runs.filter((r) => r.conclusion === "success");
  }

  if (candidates.length === 0) {
    throw new Error(
      `No successful workflow run found for ${repo}. Push a build workflow or pass --wait / --release.`,
    );
  }

  let downloaded = false;

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
      downloaded = true;
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

  if (!downloaded) {
    throw new Error(
      `No workflow artifacts found among the latest successful runs for ${repo}. Try --release or trigger a build workflow.`,
    );
  }

  if (keepAll) {
    const files = await walkFiles(dir);
    console.log(`Kept all ${files.length} file(s) in ${dir}`);
    for (const f of files) console.log(`  ${relative(dir, f)}`);
    return;
  }

  const { kept, removed } = await filterArtifacts(dir, patterns);
  console.log(
    `Kept ${kept.length} matching file(s), removed ${removed} other file(s)`,
  );
  for (const f of kept) console.log(`  ${f}`);

  try {
    await stat(dir);
  } catch {
    /* ignore */
  }
}
