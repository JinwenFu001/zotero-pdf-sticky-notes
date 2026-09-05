import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = path.resolve("addon/licenses");
await mkdir(destination, { recursive: true });

const packages = [
  ["pdf-lib", ["LICENSE.md", "LICENSE"]],
  ["@pdf-lib/standard-fonts", ["LICENSE.md", "LICENSE"]],
  ["@pdf-lib/upng", ["LICENSE.md", "LICENSE"]],
  ["pako", ["LICENSE", "LICENSE.md"]],
  ["tslib", ["CopyrightNotice.txt", "LICENSE.txt", "LICENSE"]],
];

const copied = [];
for (const [packageName, candidates] of packages) {
  let source;
  for (const candidate of candidates) {
    const possible = path.resolve("node_modules", packageName, candidate);
    try {
      await readFile(possible);
      source = possible;
      break;
    } catch {
      // Try the next common license filename.
    }
  }
  if (!source) throw new Error(`No license file found for ${packageName}`);
  const filename = `${packageName.replaceAll("/", "-").replaceAll("@", "")}.txt`;
  await copyFile(source, path.join(destination, filename));
  copied.push(`${packageName}: licenses/${filename}`);
}

const notice = [
  "# Third-party notices",
  "",
  "The production bundle includes the following packages. Their license texts are shipped next to this file.",
  "",
  ...copied.map((entry) => `- ${entry}`),
  "",
].join("\n");
await writeFile(path.join(destination, "THIRD-PARTY-NOTICES.md"), notice);
