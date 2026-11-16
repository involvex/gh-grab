import { mkdir, access, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SetupPreset = "rust" | "tauri" | "android";

const TEMPLATE_FILES: Record<SetupPreset, { filename: string; asset: string }> =
  {
    rust: { filename: "gh-grab-rust.yml", asset: "rust.yml" },
    tauri: { filename: "gh-grab-tauri.yml", asset: "tauri.yml" },
    android: { filename: "gh-grab-android.yml", asset: "android.yml" },
  };

async function loadTemplate(asset: string): Promise<string> {
  const url = new URL(`./templates/${asset}`, import.meta.url);
  const file = Bun.file(url);
  if (!(await file.exists())) {
    throw new Error(`Missing template: ${asset}`);
  }
  return await file.text();
}

export type SetupOptions = {
  presets: SetupPreset[];
  force?: boolean;
  cwd?: string;
};

export async function setup(options: SetupOptions): Promise<void> {
  if (options.presets.length === 0) {
    throw new Error(
      "Specify at least one preset: --rust, --tauri, and/or --android",
    );
  }

  const cwd = options.cwd || process.cwd();
  const workflowsDir = join(cwd, ".github", "workflows");
  await mkdir(workflowsDir, { recursive: true });

  for (const preset of options.presets) {
    const meta = TEMPLATE_FILES[preset];
    const target = join(workflowsDir, meta.filename);

    try {
      await access(target);
      if (!options.force) {
        throw new Error(
          `${meta.filename} already exists. Pass --force to overwrite.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("already exists")) {
        throw err;
      }
      // file does not exist — continue
    }

    const body = await loadTemplate(meta.asset);
    await writeFile(target, body, "utf8");
    console.log(`Wrote ${join(".github", "workflows", meta.filename)}`);
  }

  console.log("");
  console.log("Next:");
  console.log("  1. Review/adjust the workflow for your project layout");
  console.log("  2. git add .github && git commit && git push");
  console.log(
    "  3. gh-grab --wait   # download artifacts when the run succeeds",
  );
}
