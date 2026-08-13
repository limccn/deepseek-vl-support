// Image detection: extension whitelist + magic bytes.
// The hook's fast path uses hasImageExtension() first (pure string, no I/O),
// then sniffImageKind() on the first bytes of the file.
import { open } from "node:fs/promises";
import { basename } from "node:path";

export type ImageKind = "png" | "jpg" | "gif" | "webp" | "bmp";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export function hasImageExtension(filePath: string): boolean {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function eq(buf: Uint8Array, off: number, bytes: number[]): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (buf[off + i] !== bytes[i]) return false;
  }
  return true;
}

function ascii(buf: Uint8Array, off: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (buf[off + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}

/** Sniff the image kind from the leading bytes (needs at least 12 bytes). */
export function sniffImageKind(buf: Uint8Array): ImageKind | null {
  if (buf.length >= 8 && eq(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (buf.length >= 3 && eq(buf, 0, [0xff, 0xd8, 0xff])) return "jpg";
  if (buf.length >= 4 && ascii(buf, 0, "GIF8")) return "gif";
  if (buf.length >= 12 && ascii(buf, 0, "RIFF") && ascii(buf, 8, "WEBP")) return "webp";
  if (buf.length >= 2 && ascii(buf, 0, "BM")) return "bmp";
  return null;
}

const MIME_BY_KIND: Record<ImageKind, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export function mimeForKind(kind: ImageKind): string {
  return MIME_BY_KIND[kind];
}

export function mimeForPath(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  for (const kind of Object.keys(MIME_BY_KIND) as ImageKind[]) {
    if (name.endsWith(`.${kind}`) || (kind === "jpg" && name.endsWith(".jpeg"))) return MIME_BY_KIND[kind];
  }
  return "application/octet-stream";
}

/** True when the file has an image extension AND matching magic bytes. */
export async function isImageFile(filePath: string): Promise<boolean> {
  if (!hasImageExtension(filePath)) return false;
  let fh;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    return sniffImageKind(buf.subarray(0, bytesRead)) !== null;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}
