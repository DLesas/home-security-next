/**
 * A file the app made, handed over on a phone, the phone's side of `save-file.ts`
 * (`save-file-share.ts` says how): written to the app's cache with expo-file-system, handed to the
 * share sheet with expo-sharing, deleted from the cache when the sheet closes.
 */
import { File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { shareFile } from "./save-file-share";
import type { SaveFiles } from "./save-file-types";

export const saveFile: SaveFiles["saveFile"] = (name, bytes) =>
  shareFile(
    {
      available: isAvailableAsync,
      write: async (fileName, data) => {
        const file = new File(Paths.cache, fileName);
        await file.write(data);
        return file.uri;
      },
      share: (uri, mimeType) => shareAsync(uri, { mimeType }),
      remove: (uri) =>
        Promise.resolve().then(() => {
          new File(uri).delete();
        }),
    },
    name,
    bytes,
  );
