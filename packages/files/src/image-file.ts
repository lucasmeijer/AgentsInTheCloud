import { posix } from "node:path";

export function isImageFile(path: string): boolean {
  return /^(?:\.png|\.jpe?g|\.gif|\.webp|\.svg|\.avif|\.bmp)$/i.test(posix.extname(path));
}
