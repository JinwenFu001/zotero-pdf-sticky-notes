import { defineConfig } from "zotero-plugin-scaffold";

import pkg from "./package.json";

const hasReleaseRepository = !/(?:\/OWNER\/|example\.invalid)/i.test(pkg.repository.url);
const updateURL = hasReleaseRepository
  ? "https://github.com/{{owner}}/{{repo}}/releases/download/release/update.json"
  : "https://example.invalid/zotero-pdf-sticky-notes/update.json";
const xpiDownloadLink = hasReleaseRepository
  ? "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi"
  : "https://example.invalid/zotero-pdf-sticky-notes/v{{version}}/{{xpiName}}.xpi";

export default defineConfig({
  source: ["src", "addon"],
  dist: "dist",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  xpiName: `${pkg.name}-${pkg.version}`,
  updateURL,
  xpiDownloadLink,
  build: {
    assets: ["addon/**/*.*"],
    fluent: {
      dts: false,
    },
    prefs: {
      dts: false,
    },
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    makeUpdateJson: {
      hash: true,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: JSON.stringify(
            process.env.NODE_ENV === "development" ? "development" : "production",
          ),
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        target: "firefox140",
        treeShaking: true,
        legalComments: "eof",
        outfile: `dist/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },
});
