import type { FileOps } from "../types";

export const zoteroFileOps: FileOps = {
  exists: (path) => IOUtils.exists(path),
  read: async (path) => {
    const bytes = await IOUtils.read(path);
    // IOUtils belongs to Zotero's privileged global. Its typed arrays are from
    // a different JavaScript realm, so libraries such as pdf-lib reject them
    // when they use `instanceof Uint8Array`. Copy into the plugin realm at the
    // file boundary, matching Zotero 9's own PDF worker bridge.
    return new Uint8Array(bytes);
  },
  write: async (path, data) => {
    await IOUtils.write(path, data);
  },
  copy: async (source, destination, overwrite = false) => {
    await IOUtils.copy(source, destination, { noOverwrite: !overwrite });
  },
  move: async (source, destination, overwrite) => {
    await IOUtils.move(source, destination, { noOverwrite: !overwrite });
  },
  remove: async (path) => {
    await IOUtils.remove(path, { ignoreAbsent: true });
  },
  parent: (path) => PathUtils.parent(path) ?? path,
  filename: (path) => PathUtils.filename(path),
  join: (...parts) => PathUtils.join(...parts),
};
