/**
 * The control socket's `fileChunk` requests (m2-design.md section 6, "Commands that carry a
 * file"): the shell answers them itself and keeps the upload for the operation that names its
 * `job`, as `UploadRef {conn, job}`. The upload store is owner A2's in step 1; until then every
 * chunk is answered `notBuilt`, by the socket server and by the lockstep bench's hub alike.
 */
import type { ControlReply } from "../../core/model/control.ts";

export const FILE_CHUNK_NOT_BUILT: ControlReply = {
  ok: false,
  error: { code: "notBuilt", message: "file uploads are not built yet (m2-design.md section 11)" },
};
