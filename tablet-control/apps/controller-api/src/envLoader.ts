import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(currentDir: string): string {
  let dir = currentDir;
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg.name === "tablet-control") {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not find repository root.");
    }
    dir = parent;
  }
}

export function loadEnv() {
  try {
    const rootDir = findRepoRoot(__dirname);
    const envPath = path.join(rootDir, ".env.local");

    if (!fs.existsSync(envPath)) {
      return;
    }

    const content = fs.readFileSync(envPath, "utf8");
    // Handle BOM if present
    const cleanContent = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const lines = cleanContent.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }

      const equalsIdx = trimmed.indexOf("=");
      if (equalsIdx !== -1) {
        const key = trimmed.substring(0, equalsIdx).trim();
        let value = trimmed.substring(equalsIdx + 1).trim();

        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.substring(1, value.length - 1);
        }

        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  } catch (error) {
    console.warn("Failed to load .env.local:", error);
  }
}
