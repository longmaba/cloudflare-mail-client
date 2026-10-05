// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MirrorHeldByAnotherTab, pickBackend } from "$lib/client/localdb/persistence";

/** Model SAH ownership separately from open SQLite files: unlinking a database
 * leaves the pool's origin-wide handles locked until its VFS is paused. */
function originPool() {
  let owner: object | null = null;
  const files = new Set(["/u_a.sqlite3", "/u_saved.sqlite3"]);
  const context = () => {
    const identity = {};
    let paused = true;
    const acquire = () => {
      if (owner !== null && owner !== identity) {
        const error = new Error("SAH already owned");
        error.name = "NoModificationAllowedError";
        throw error;
      }
      owner = identity;
      paused = false;
    };
    const pool = {
      OpfsSAHPoolDb: class {
        constructor(readonly filename: string) {
          if (paused) throw new Error("VFS is paused");
          files.add(filename);
        }
      },
      unlink(filename: string) { return files.delete(filename); },
      pauseVfs() { owner = null; paused = true; },
      async unpauseVfs() { acquire(); },
    };
    let installed = false;
    return {
      pool,
      sqlite: {
        async installOpfsSAHPoolVfs() {
          if (!installed) { acquire(); installed = true; }
          return pool;
        },
      },
    };
  };
  return { context, files };
}

describe("local mirror persistence ownership", () => {
  it("allows a replacement worker after logout while retaining other users' files", async () => {
    const origin = originPool();
    const previousWorker = origin.context();
    const first = await pickBackend(previousWorker.sqlite);
    await first.openDb("u_a");
    await first.destroy("u_a");

    const second = await pickBackend(origin.context().sqlite);
    await expect(second.openDb("u_b")).resolves.toMatchObject({ filename: "/u_b.sqlite3" });
    expect(origin.files.has("/u_a.sqlite3")).toBe(false);
    expect(origin.files.has("/u_saved.sqlite3")).toBe(true);
  });

  it("still refuses a simultaneous owner's pool instead of falling back to IndexedDB", async () => {
    const origin = originPool();
    await pickBackend(origin.context().sqlite);
    await expect(pickBackend(origin.context().sqlite)).rejects.toBeInstanceOf(MirrorHeldByAnotherTab);
  });

  it("releases handles even when removing the logged-out database fails", async () => {
    const origin = originPool();
    const context = origin.context();
    const first = await pickBackend(context.sqlite);
    context.pool.unlink = () => { throw new Error("unlink failed"); };
    await first.destroy("u_a");
    await expect(pickBackend(origin.context().sqlite)).resolves.toMatchObject({ kind: "opfs" });
  });
});
