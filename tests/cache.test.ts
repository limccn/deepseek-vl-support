// Description cache: key = sha256+mtime+size+model; 64MB cap with LRU eviction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DescriptionCache, cacheDirFor, sha256Of } from "../src/cache.ts";
import { makeFakePng } from "./mock-vision-server.ts";

async function makeEnv(): Promise<{ dir: string; img: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dvls-cache-"));
  const img = join(dir, "img.png");
  await writeFile(img, makeFakePng(4096));
  return { dir, img };
}

test("set → get round-trip; model mismatch / file change / size change miss", async () => {
  const { dir, img } = await makeEnv();
  try {
    const cache = new DescriptionCache(join(dir, "cache"));
    const st = await stat(img);
    const buf = await readFile(img);

    assert.equal(await cache.get(img, st, buf, "m1"), null, "miss on empty cache");

    await cache.set(img, st, buf, "m1", "description one");
    assert.equal(await cache.get(img, st, buf, "m1"), "description one");

    assert.equal(await cache.get(img, st, buf, "m2"), null, "different model must miss");
    await cache.set(img, st, buf, "m2", "description two");
    // Same sha + same model → hit.
    assert.equal(await cache.get(img, st, buf, "m2"), "description two");
    // One record per sha: the m2 set overwrote the m1 record. m1 must miss
    // (descriptions are never reused across models — design §5).
    assert.equal(await cache.get(img, st, buf, "m1"), null, "m1 record overwritten by m2, must miss");

    // content change (same size → sha differs)
    const buf2 = await readFile(img);
    buf2[64] ^= 0xff;
    await writeFile(img, buf2);
    const st2 = await stat(img);
    assert.equal(await cache.get(img, st2, buf2, "m1"), null, "content change must miss");

    // size change
    await writeFile(img, makeFakePng(8192));
    const st3 = await stat(img);
    const buf3 = await readFile(img);
    assert.equal(await cache.get(img, st3, buf3, "m1"), null, "size change must miss");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache file content is the description (plan-B file format)", async () => {
  const { dir, img } = await makeEnv();
  try {
    const cache = new DescriptionCache(join(dir, "cache"));
    const st = await stat(img);
    const buf = await readFile(img);
    await cache.set(img, st, buf, "m1", "[Vision of img.png]:\nhello world");
    const files = await readdir(join(dir, "cache"));
    assert.equal(files.length, 1);
    const rec = JSON.parse(await readFile(join(dir, "cache", files[0]), "utf8"));
    assert.equal(rec.text, "[Vision of img.png]:\nhello world");
    assert.equal(rec.model, "m1");
    assert.equal(rec.sha256 ? typeof rec.sha256 : typeof rec.key, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune evicts oldest entries above the cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dvls-cache-"));
  try {
    const cache = new DescriptionCache(join(dir, "cache"), 1500);
    const imgs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `img${i}.png`);
      await writeFile(p, makeFakePng(512));
      imgs.push(p);
      const st = await stat(p);
      const buf = await readFile(p);
      await cache.set(p, st, buf, "m", `entry-${i}-` + "x".repeat(500));
    }
    const files = await readdir(join(dir, "cache"));
    // 5 × ~600 bytes > 1500 cap → at least the two oldest must be gone
    assert.ok(files.length <= 3, `expected eviction, got ${files.length} files`);
    const first = await cache.get(imgs[0], await stat(imgs[0]), await readFile(imgs[0]), "m");
    assert.equal(first, null, "oldest entry must be evicted");
    const last = await cache.get(imgs[4], await stat(imgs[4]), await readFile(imgs[4]), "m");
    assert.match(last ?? "", /entry-4-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cacheDirFor: project config present → project cache, else global", async () => {
  const { dir } = await makeEnv();
  try {
    const project = join(dir, "proj");
    const home = join(dir, "home");
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    assert.equal(cacheDirFor(project, home), join(home, ".deepseek-vl", "cache"), "no project config → global");
    await mkdir(join(project, ".deepseek-vl"), { recursive: true });
    await writeFile(join(project, ".deepseek-vl", "config.json"), "{}");
    assert.equal(cacheDirFor(project, home), join(project, ".deepseek-vl", "cache"), "project config → project cache");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sha256Of is stable and distinct", () => {
  assert.equal(sha256Of(Buffer.from("a")), sha256Of(Buffer.from("a")));
  assert.notEqual(sha256Of(Buffer.from("a")), sha256Of(Buffer.from("b")));
  assert.equal(sha256Of(Buffer.from("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
