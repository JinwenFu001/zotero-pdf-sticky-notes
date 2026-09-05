import type { FileOps } from "../types";

export const zoteroFileOps: FileOps = {
  exists: (path) => IOUtils.exists(path),
  read: (path) => IOUtils.read(path),
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
