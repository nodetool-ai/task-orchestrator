#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { generateSpriteBaseline } from "../lib/runner/sprites-baseline-recipe";

async function main() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(repo|ref|recipe|out)=(.+)$/.exec(arg);
    if (!match || args.has(match[1])) throw new Error("Usage: npm run sprite:baseline -- --repo=/checkout --ref=HEAD --recipe=recipe.json [--out=baselines.json]");
    args.set(match[1], match[2]);
  }
  if (!args.has("repo") || !args.has("recipe")) throw new Error("--repo and --recipe are required; use --key=value arguments");
  const recipe = JSON.parse(await readFile(args.get("recipe")!, "utf8"));
  const baseline = await generateSpriteBaseline(args.get("repo")!, args.get("ref") ?? "HEAD", recipe);
  const output = JSON.stringify([baseline], null, 2) + "\n";
  if (args.has("out")) await writeFile(args.get("out")!, output, { flag: "wx" });
  else process.stdout.write(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
