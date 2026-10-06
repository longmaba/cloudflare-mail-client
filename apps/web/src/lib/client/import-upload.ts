// SPDX-License-Identifier: Apache-2.0
// Chunked mbox upload. The file stays on disk — `File.slice()` is lazy, so a
// 10 GB archive never enters memory; only one 8 MB chunk does at a time.
//
// The tab has to stay open for the upload (a File handle dies with the page
// that opened it, and nothing else can read it). The IMPORT itself is
// background — once the last chunk lands, the queue owns it and the browser is
// free. Interrupting an upload is a pause, not a loss: parts are indexed and
// immutable, so a resumed upload validates what already landed before continuing.
import { PART_PLAINTEXT_BYTES } from "@doota/mail-core/import";

export type UploadProgress = { uploadedBytes: number; totalBytes: number; partIndex: number; partCount: number };

export class UploadAborted extends Error {
  constructor() {
    super("Upload stopped");
    this.name = "UploadAborted";
  }
}

/**
 * Push `file` to /api/import in PART_PLAINTEXT_BYTES chunks.
 *
 * Every resume starts at zero: the server verifies stored chunks against this
 * file before accepting new ones. Never trust an interrupted tab's part count.
 * The chunk size
 * is fixed by the server contract — the job maps a byte cursor to a part index
 * by division, so a client that chose its own size would corrupt the cursor.
 */
export async function uploadMbox(
  file: File,
  importId: string,
  options: {
    /** Legacy callers may pass this; validation still starts at byte zero. */
    fromPart?: number;
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
  } = {},
): Promise<void> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("Choose a non-empty archive file.");
  const partCount = Math.ceil(file.size / PART_PLAINTEXT_BYTES);

  for (let partIndex = 0; partIndex < partCount; partIndex++) {
    if (options.signal?.aborted) throw new UploadAborted();
    const from = partIndex * PART_PLAINTEXT_BYTES;
    const chunk = file.slice(from, Math.min(from + PART_PLAINTEXT_BYTES, file.size));

    let response: Response;
    try {
      response = await fetch(`/api/import?importId=${encodeURIComponent(importId)}&index=${partIndex}`, {
        method: "POST",
        body: chunk,
        signal: options.signal,
      });
    } catch (cause) {
      if (options.signal?.aborted) throw new UploadAborted();
      throw cause;
    }
    if (!response.ok) {
      // SvelteKit error responses use JSON. Avoid displaying HTML or diagnostic
      // bodies when an upstream proxy fails the request.
      const detail: unknown = await response.json().catch(() => null);
      const message = detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string"
        ? detail.message.slice(0, 200) : `Chunk ${partIndex + 1} failed (${response.status}). Resume using the same file.`;
      throw new Error(message);
    }

    options.onProgress?.({
      uploadedBytes: Math.min(from + chunk.size, file.size),
      totalBytes: file.size,
      partIndex: partIndex + 1,
      partCount,
    });
  }
}
