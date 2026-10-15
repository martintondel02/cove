/**
 * Tests for the data layout and the guards around it.
 *
 * The interesting behaviour here is the failure modes: refusing to start an encode
 * the disk cannot finish, and replacing published media without leaving a post
 * pointing at something that no longer exists.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  InsufficientSpaceError,
  assertSpaceFor,
  dataLayout,
  ensureLayout,
  freeMegabytes,
  mediaDirFor,
  swapIntoPlace,
  toStoredPath,
  workDirFor,
} from "./paths.ts";

describe("layout", () => {
  it("puts everything under one root so a backup is one directory", () => {
    const layout = dataLayout("/srv/cove");
    assert.equal(layout.root, "/srv/cove");
    assert.equal(layout.uploads, "/srv/cove/uploads");
    assert.equal(layout.work, "/srv/cove/work");
    assert.equal(layout.media, "/srv/cove/media");
    assert.equal(layout.recordings, "/srv/cove/recordings");
  });

  it("resolves relative roots against the working directory", () => {
    const layout = dataLayout("./data");
    assert.ok(layout.root.startsWith("/"), "root must be absolute for rename() to behave");
    assert.ok(layout.root.endsWith("/data"));
  });

  it("creates every directory it owns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cove-layout-"));
    try {
      const layout = dataLayout(dir);
      await ensureLayout(layout);
      await writeFile(join(layout.uploads, "probe"), "ok");
      assert.equal(await readFile(join(layout.uploads, "probe"), "utf8"), "ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores media paths relative to the root, never as host paths", () => {
    const layout = dataLayout("/srv/cove");
    assert.equal(
      toStoredPath(layout, "/srv/cove/media/abc/master.m3u8"),
      "media/abc/master.m3u8",
    );
  });

  it("names scratch and published directories by id", () => {
    const layout = dataLayout("/srv/cove");
    assert.equal(workDirFor(layout, "job-1"), "/srv/cove/work/job-1");
    assert.equal(mediaDirFor(layout, "post-1"), "/srv/cove/media/post-1");
  });
});

describe("disk space guard", () => {
  it("reports a plausible number of free megabytes", async () => {
    const free = await freeMegabytes(tmpdir());
    assert.ok(Number.isFinite(free) && free > 0, `free was ${free}`);
  });

  it("allows a job when there is room", async () => {
    await assert.doesNotReject(() => assertSpaceFor(tmpdir(), 1));
  });

  it("refuses an impossible job with an actionable message", async () => {
    // An absurd requirement, which is how a full disk presents in practice.
    await assert.rejects(
      () => assertSpaceFor(tmpdir(), Number.MAX_SAFE_INTEGER),
      (error: unknown) => {
        assert.ok(error instanceof InsufficientSpaceError);
        assert.match(error.message, /free at/);
        // The message must name the knob that lets the operator proceed anyway.
        assert.match(error.message, /COVE_MIN_FREE_MB/);
        return true;
      },
    );
  });
});

describe("publishing atomically", () => {
  it("moves a finished job into place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cove-swap-"));
    try {
      const staging = join(dir, "staging");
      const destination = join(dir, "final");
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, "master.m3u8"), "#EXTM3U");

      await swapIntoPlace(staging, destination);

      assert.equal(await readFile(join(destination, "master.m3u8"), "utf8"), "#EXTM3U");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces existing media and leaves no leftovers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cove-swap2-"));
    try {
      const staging = join(dir, "staging");
      const destination = join(dir, "final");
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "old.txt"), "old");
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, "new.txt"), "new");

      await swapIntoPlace(staging, destination);

      const { readdir } = await import("node:fs/promises");
      const names = await readdir(dir);
      // The previous version is removed, not left lying beside the new one.
      assert.deepEqual(names, ["final"]);
      assert.equal(await readFile(join(destination, "new.txt"), "utf8"), "new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
