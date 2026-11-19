import { Directory, File, Paths, type FileHandle } from "expo-file-system";
import type { ImageCache } from "../download";

let swept = false;

/** Removes the cache when a session ends or opening its handle fails. */
function removeFile(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    /* The next process can sweep leftovers. */
  }
}

/** Opens a per-session cache file and removes leftovers from an earlier process on first use. */
export function imageCache(image: string): ImageCache | undefined {
  if (!/^[a-f0-9]{16}$/u.test(image)) return undefined;
  let handle: FileHandle | undefined;
  let file: File | undefined;
  try {
    const dir = new Directory(Paths.cache, "bluetooth-firmware");
    if (!swept) {
      if (dir.exists) dir.delete();
      dir.create({ idempotent: true });
      swept = true;
    }
    file = new File(dir, image);
    file.create({ overwrite: true });
    handle = file.open();
  } catch {
    if (file !== undefined) removeFile(file);
    return undefined;
  }
  const cached = file;
  const writer = handle;
  let size = 0;
  return {
    get size() {
      return size;
    },
    /** Reads exactly the requested span at the current file's offset. */
    read(offset, length) {
      try {
        writer.offset = offset;
        return writer.readBytesSync(length);
      } catch {
        return undefined;
      }
    },
    /** Appends an ordered, validated chunk of the hub's stream. */
    append(bytes) {
      try {
        writer.offset = size;
        writer.writeBytesSync(bytes);
        size += bytes.length;
        return true;
      } catch {
        return false;
      }
    },
    /** Releases the handle before deleting the temporary firmware image. */
    remove() {
      try {
        writer.close();
      } catch {
        /* It may already be closed. */
      }
      removeFile(cached);
    },
  };
}
