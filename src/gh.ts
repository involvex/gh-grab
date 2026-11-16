export class GhError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GhError";
  }
}

export type GhRun = {
  databaseId: number;
  conclusion: string | null;
  status: string;
  name: string;
  headBranch: string;
  displayTitle: string;
  createdAt: string;
  url?: string;
};

async function runGh(
  args: string[],
  options: { allowFail?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 && !options.allowFail) {
    throw new GhError(
      `gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim() || "unknown error"}`,
      exitCode,
      stderr,
    );
  }

  return { stdout, stderr, exitCode };
}

export async function ensureGhAvailable(): Promise<void> {
  try {
    await runGh(["--version"]);
  } catch {
    throw new Error(
      "gh CLI not found in PATH. Install from https://cli.github.com/ and run `gh auth login`.",
    );
  }
}

export async function ensureGhAuth(): Promise<void> {
  const { exitCode, stderr } = await runGh(["auth", "status"], {
    allowFail: true,
  });
  if (exitCode !== 0) {
    throw new Error(
      `gh is not authenticated. Run \`gh auth login\`.\n${stderr.trim()}`,
    );
  }
}

export async function resolveRepo(repo?: string): Promise<string> {
  if (repo) return repo;

  const { stdout } = await runGh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  const name = stdout.trim();
  if (!name) {
    throw new Error(
      "Could not detect repository. Run inside a GitHub checkout or pass -R owner/repo.",
    );
  }
  return name;
}

export async function listCompletedRuns(
  repo: string,
  limit = 30,
  workflow?: string,
): Promise<GhRun[]> {
  const args = [
    "run",
    "list",
    "--repo",
    repo,
    "--status",
    "completed",
    "--limit",
    String(limit),
    "--json",
    "databaseId,conclusion,status,name,headBranch,displayTitle,createdAt,url",
  ];
  if (workflow) {
    args.push("--workflow", workflow);
  }
  const { stdout } = await runGh(args);
  return JSON.parse(stdout || "[]") as GhRun[];
}

export async function listRecentRuns(
  repo: string,
  limit = 10,
  workflow?: string,
): Promise<GhRun[]> {
  const args = [
    "run",
    "list",
    "--repo",
    repo,
    "--limit",
    String(limit),
    "--json",
    "databaseId,conclusion,status,name,headBranch,displayTitle,createdAt,url",
  ];
  if (workflow) {
    args.push("--workflow", workflow);
  }
  const { stdout } = await runGh(args);
  return JSON.parse(stdout || "[]") as GhRun[];
}

export async function watchRun(repo: string, runId: number): Promise<void> {
  await runGh(["run", "watch", String(runId), "--repo", repo, "--exit-status"]);
}

export async function listRunArtifactNames(
  repo: string,
  runId: number,
): Promise<string[]> {
  const { stdout, exitCode } = await runGh(
    [
      "api",
      `repos/${repo}/actions/runs/${runId}/artifacts`,
      "--jq",
      "[.artifacts[].name]",
    ],
    { allowFail: true },
  );
  if (exitCode !== 0) return [];
  try {
    return JSON.parse(stdout || "[]") as string[];
  } catch {
    return [];
  }
}

export async function downloadRun(
  repo: string,
  runId: number,
  dir: string,
): Promise<void> {
  await runGh(["run", "download", String(runId), "--repo", repo, "--dir", dir]);
}

export async function downloadRelease(
  repo: string,
  dir: string,
  patterns: string[],
): Promise<void> {
  const args = [
    "release",
    "download",
    "--repo",
    repo,
    "--dir",
    dir,
    "--clobber",
  ];
  for (const pattern of patterns) {
    args.push("--pattern", pattern);
  }
  await runGh(args);
}
