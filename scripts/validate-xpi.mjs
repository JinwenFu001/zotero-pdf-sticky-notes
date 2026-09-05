import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const version = JSON.parse(await readFile("package.json", "utf8")).version;
const xpiPath = path.resolve(`dist/zotero-pdf-sticky-notes-${version}.xpi`);
const archive = await readFile(xpiPath);

function entriesFromZip(bytes) {
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("XPI has no ZIP central directory");
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid central directory");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + filenameLength).toString("utf8");
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + filenameLength + extraLength + commentLength;
  }
  return entries;
}

function extract(bytes, entry) {
  const offset = entry.localOffset;
  if (bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error("Invalid local ZIP entry");
  const filenameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const start = offset + 30 + filenameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${entry.method}`);
}

const entries = entriesFromZip(archive);
const required = [
  "manifest.json",
  "bootstrap.js",
  "content/scripts/zoteropdfstickynotes.js",
  "licenses/THIRD-PARTY-NOTICES.md",
  "licenses/pdf-lib.txt",
];
for (const name of required) {
  if (!entries.has(name)) throw new Error(`XPI is missing ${name}`);
}
if ([...entries.keys()].some((name) => name.includes("node_modules/"))) {
  throw new Error("XPI must not contain node_modules");
}

const manifestText = extract(archive, entries.get("manifest.json")).toString("utf8");
if (/__[A-Za-z][A-Za-z0-9]*__/.test(manifestText)) {
  throw new Error("manifest.json contains an unreplaced build placeholder");
}
const manifest = JSON.parse(manifestText);
if (manifest.version !== version) throw new Error("Manifest/package versions differ");
if (manifest.applications?.zotero?.strict_min_version !== "9.0.6") {
  throw new Error("Prototype compatibility must remain locked to tested Zotero 9.0.6");
}
if (manifest.applications?.zotero?.strict_max_version !== "9.0.6") {
  throw new Error("Prototype compatibility must remain locked to tested Zotero 9.0.6");
}

const bootstrapText = extract(archive, entries.get("bootstrap.js")).toString("utf8");
if (!bootstrapText.includes("AbortController: hiddenDOMWindow.AbortController")) {
  throw new Error("Bootstrap must inject AbortController into Zotero 9's plugin context");
}

const bundle = extract(archive, entries.get("content/scripts/zoteropdfstickynotes.js"));
const bundleSize = bundle.byteLength;
if (bundleSize < 200_000)
  throw new Error("Runtime bundle is unexpectedly small; pdf-lib may be missing");
const bundleText = bundle.toString("utf8");
for (const requiredRuntimeMarker of [
  "urn:zotero-pdf-sticky-notes:sticky:v1",
  "exportFunction",
  "in_conflict",
  "failed to save an erased handwritten annotation",
  "PDF worker serialization is unavailable",
]) {
  if (!bundleText.includes(requiredRuntimeMarker)) {
    throw new Error(`Runtime bundle is missing ${requiredRuntimeMarker}`);
  }
}

console.log(`Validated ${path.relative(process.cwd(), xpiPath)} (${entries.size} files)`);
