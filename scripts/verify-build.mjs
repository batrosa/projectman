import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const runtimeJavaScript = [
  join(root, "script.js"),
  join(root, "sw.js"),
  ...["api", "lib"].flatMap((directory) => walk(join(root, directory))),
].filter((path) => path.endsWith(".js") && !path.endsWith(".test.js"));

for (const path of runtimeJavaScript) {
  const check = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (check.status !== 0) failures.push(`${relative(root, path)}: ${check.stderr.trim()}`);
}

for (const filename of ["package.json", "vercel.json", "firebase.json", "firestore.indexes.json"]) {
  try {
    JSON.parse(readFileSync(join(root, filename), "utf8"));
  } catch (error) {
    failures.push(`${filename}: invalid JSON (${error.message})`);
  }
}

const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
for (const source of Object.keys(vercel.functions || {})) {
  if (!existsSync(join(root, source))) failures.push(`vercel.json: missing function ${source}`);
}

const htmlFiles = [join(root, "index.html"), join(root, "landing.html"), join(root, "firebase-hosting/google-auth.html")];
for (const htmlPath of htmlFiles) {
  const html = readFileSync(htmlPath, "utf8").replace(/<!--[\s\S]*?-->/gu, "");
  const deployRoot = htmlPath.startsWith(join(root, "firebase-hosting"))
    ? join(root, "firebase-hosting")
    : root;
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/giu)) {
    const reference = match[1].trim();
    if (!reference || /^(?:https?:|\/\/|#|data:|mailto:|tel:|javascript:|blob:)/iu.test(reference)) continue;
    const clean = reference.split(/[?#]/u)[0];
    if (!clean) continue;
    const target = clean.startsWith("/") ? join(deployRoot, clean) : resolve(dirname(htmlPath), clean);
    if (!existsSync(target) || statSync(target).isDirectory()) {
      failures.push(`${relative(root, htmlPath)}: missing local resource ${reference}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Deploy build verification failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`Deploy build verified: ${runtimeJavaScript.length} runtime JS files, ${htmlFiles.length} HTML entry points.`);
