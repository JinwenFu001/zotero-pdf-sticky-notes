import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const problems = [];
const repositoryURL = pkg.repository?.url ?? "";
const homepage = pkg.homepage ?? "";
const issuesURL = pkg.bugs?.url ?? "";
const expectedTag = `v${pkg.version}`;
const pushedTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;

if (!repositoryURL || /(?:OWNER|REPLACE|example\.invalid)/i.test(repositoryURL)) {
  problems.push("package.json repository.url must point to the real release repository");
}
if (!homepage || /(?:OWNER|REPLACE|example\.invalid)/i.test(homepage)) {
  problems.push("package.json homepage must point to the real project homepage");
}
if (!issuesURL || /(?:OWNER|REPLACE|example\.invalid)/i.test(issuesURL)) {
  problems.push("package.json bugs.url must point to the real issue tracker");
}
if (!pkg.author?.trim()) {
  problems.push("package.json author must be set");
}
if (!pkg.license || pkg.license === "UNLICENSED") {
  problems.push("choose and declare the project license");
}
if (!pkg.config?.addonID || /(?:prototype|local|example)\.invalid$/i.test(pkg.config.addonID)) {
  problems.push("config.addonID must be replaced with the permanent public plugin ID");
}
if (pushedTag && pushedTag !== expectedTag) {
  problems.push(`release tag ${pushedTag} must exactly match package version ${expectedTag}`);
}

if (problems.length) {
  console.error("Release metadata is incomplete:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log("Release metadata is ready");
}
