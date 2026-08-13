// Image detection: extension whitelist + magic bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasImageExtension,
  isImageFile,
  mimeForKind,
  mimeForPath,
  sniffImageKind,
} from "../src/detect.ts";
import { makeFakePng } from "./mock-vision-server.ts";

function magic(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

test("hasImageExtension", () => {
  assert.equal(hasImageExtension("a.png"), true);
  assert.equal(hasImageExtension("a.PNG"), true);
  assert.equal(hasImageExtension("a.jpeg"), true);
  assert.equal(hasImageExtension("a.jpg"), true);
  assert.equal(hasImageExtension("a.gif"), true);
  assert.equal(hasImageExtension("a.webp"), true);
  assert.equal(hasImageExtension("a.bmp"), true);
  assert.equal(hasImageExtension("a.txt"), false);
  assert.equal(hasImageExtension("a.svg"), false);
  assert.equal(hasImageExtension("a.png.txt"), false);
  assert.equal(hasImageExtension("noextension"), false);
  assert.equal(hasImageExtension("dir/a.PNG"), true);
  assert.equal(hasImageExtension("C:\\x\\y.png"), true);
});

test("sniffImageKind magic bytes", () => {
  assert.equal(sniffImageKind(magic(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "png");
  assert.equal(sniffImageKind(magic(0xff, 0xd8, 0xff, 0xe0)), "jpg");
  assert.equal(sniffImageKind(Buffer.from("GIF89a...")), "gif");
  assert.equal(sniffImageKind(Buffer.from("GIF87a...")), "gif");
  assert.equal(sniffImageKind(Buffer.from("RIFFxxxxWEBP")), "webp");
  assert.equal(sniffImageKind(Buffer.from("BMxxxx")), "bmp");
  assert.equal(sniffImageKind(Buffer.from("not an image at all")), null);
  assert.equal(sniffImageKind(Buffer.alloc(0)), null);
  assert.equal(sniffImageKind(Buffer.from("RIFFxxxx")), null); // short webp
  assert.equal(sniffImageKind(magic(0x89, 0x50)), null); // too short for png
});

test("mimeForKind and mimeForPath", () => {
  assert.equal(mimeForKind("png"), "image/png");
  assert.equal(mimeForKind("jpg"), "image/jpeg");
  assert.equal(mimeForKind("webp"), "image/webp");
  assert.equal(mimeForPath("x.PNG"), "image/png");
  assert.equal(mimeForPath("x.jpeg"), "image/jpeg");
  assert.equal(mimeForPath("x.bmp"), "image/bmp");
  assert.equal(mimeForPath("x.unknown"), "application/octet-stream");
});

test("isImageFile requires BOTH extension and magic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dvls-detect-"));
  try {
    const pngPath = join(dir, "real.png");
    await writeFile(pngPath, makeFakePng());

    const textAsPng = join(dir, "fake.png"); // right ext, wrong bytes
    await writeFile(textAsPng, "this is plain text, not an image");

    const pngAsTxt = join(dir, "hidden.png.txt"); // right bytes, wrong ext
    await writeFile(pngAsTxt, makeFakePng(64));

    assert.equal(await isImageFile(pngPath), true);
    assert.equal(await isImageFile(textAsPng), false);
    assert.equal(await isImageFile(pngAsTxt), false);
    assert.equal(await isImageFile(join(dir, "missing.png")), false);
    assert.equal(await isImageFile(join(dir, "subdir", "a.png")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
