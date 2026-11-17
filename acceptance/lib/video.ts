/**
 * Video check for soft-keyboard transitions: the keyboard is the only thing that
 * animates. In every frame from the first changed one on, everything above the
 * keyboard's top edge must already match the settled (last) frame. This also
 * catches WebKit scrolling the page to reveal the focused field.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface VideoAnalysis {
  frames: number;
  width: number;
  height: number;
  statusRows: number;
  masks: readonly Mask[];
  tolerance: number;
  allowance: number;
  noise: number;
  firstChanged: number | null;
  settledKeyboardTop: number;
  perFrame: { index: number; time: number; keyboardTop: number; differing: number }[];
  worst: { index: number; time: number; differing: number; firstRow: number } | null;
  pass: boolean;
}

const keyboardLuminance = 110;

async function probe(file: string): Promise<{ width: number; height: number; times: number[] }> {
  const process = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:frame=pts_time", "-of", "json", file], { stdout: "pipe" });
  // SAFETY: ffprobe's JSON writer with the requested entries.
  const json = JSON.parse(await new Response(process.stdout).text()) as { streams: { width: number; height: number }[]; frames: { pts_time: string }[] };
  return { width: json.streams[0]!.width, height: json.streams[0]!.height, times: json.frames.map((frame) => Number(frame.pts_time)) };
}

/**
 * The keyboard's top edge: the top of the bright block at the bottom of the frame.
 * The input accessory bar floats a little above the keys, so short dark gaps
 * (up to `gapRows`) still belong to the keyboard.
 */
function keyboardTop(frame: Uint8Array, width: number, height: number): number {
  const gapRows = Math.round(height * 0.02);
  let top = height;
  let dark = 0;
  for (let row = height - 1; row >= 0; row--) {
    let sum = 0;
    const offset = row * width;
    for (let column = 0; column < width; column += 3) sum += frame[offset + column]!;
    if (sum / Math.ceil(width / 3) >= keyboardLuminance) {
      top = row;
      dark = 0;
    } else if (++dark > gapRows) break;
  }
  return top;
}

interface Difference { count: number; firstRow: number }

const block = 6;

export type Mask = [number, number, number, number];

function differing(a: Uint8Array, b: Uint8Array, width: number, fromRow: number, toRow: number, tolerance: number, masks: readonly Mask[] = []): Difference {
  let count = 0;
  let firstRow = -1;
  for (let top = fromRow; top + block <= toRow; top += block) {
    for (let left = 0; left + block <= width; left += block) {
      if (masks.some(([x, y, w, h]) => left + block > x && left < x + w && top + block > y && top < y + h)) continue;
      let sum = 0;
      for (let row = top; row < top + block; row++) {
        const offset = row * width + left;
        for (let column = 0; column < block; column++) sum += a[offset + column]! - b[offset + column]!;
      }
      if (Math.abs(sum) / (block * block) > tolerance) {
        count += block * block;
        if (firstRow < 0) firstRow = top;
      }
    }
  }
  return { count, firstRow };
}

export async function analyseKeyboardVideo(file: string, options: { statusBarPoints?: number; scale?: number; masks?: readonly Mask[] } = {}): Promise<VideoAnalysis> {
  const { width, height, times } = await probe(file);
  const directory = await mkdtemp(join(tmpdir(), "keyboard-video-"));
  try {
    const raw = join(directory, "frames.gray");
    const decode = Bun.spawn(["ffmpeg", "-v", "error", "-i", file, "-vsync", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", raw]);
    if (await decode.exited !== 0) throw new Error(`ffmpeg could not decode ${file}`);
    const data = new Uint8Array(await Bun.file(raw).arrayBuffer());
    const size = width * height;
    const count = Math.floor(data.length / size);
    const frame = (index: number): Uint8Array => data.subarray(index * size, (index + 1) * size);
    const statusRows = Math.round((options.statusBarPoints ?? 59) * (options.scale ?? width / 393));
    const tolerance = 12;
    const settled = frame(count - 1);
    const first = frame(0);
    const settledKeyboardTop = keyboardTop(settled, width, height);
    const margin = Math.round(12 * (width / 393));
    const pageRows = (current: Uint8Array, reference: number): number => Math.max(statusRows, Math.min(keyboardTop(current, width, height), reference) - margin);
    // The first frame where the page (not the keyboard itself, e.g. a pressed key) differs from the start.
    // Masked regions count here: a masked terminal can cover everything the transition moves.
    const firstTop = keyboardTop(first, width, height);
    let firstChanged: number | null = null;
    for (let index = 1; index < count; index++) {
      if (differing(frame(index), first, width, statusRows, pageRows(frame(index), firstTop), tolerance).count > 1500) { firstChanged = index; break; }
    }
    let noise = 0;
    for (let index = 1; index < (firstChanged ?? count); index++) noise = Math.max(noise, differing(frame(index), first, width, statusRows, pageRows(frame(index), firstTop), tolerance, options.masks).count);
    const caret = 2 * block * Math.ceil(27 * (width / 393) / block + 1) * block;
    const allowance = 2 * noise + caret;
    const perFrame: VideoAnalysis["perFrame"] = [];
    let worst: VideoAnalysis["worst"] = null;
    for (let index = firstChanged ?? count; index < count; index++) {
      const current = frame(index);
      const result = differing(current, settled, width, statusRows, pageRows(current, settledKeyboardTop), tolerance, options.masks);
      perFrame.push({ index, time: times[index] ?? index / 60, keyboardTop: keyboardTop(current, width, height), differing: result.count });
      if (!worst || result.count > worst.differing) worst = { index, time: times[index] ?? index / 60, differing: result.count, firstRow: result.firstRow };
    }
    return { frames: count, width, height, statusRows, masks: options.masks ?? [], tolerance, allowance, noise, firstChanged, settledKeyboardTop, perFrame, worst, pass: firstChanged !== null && (worst?.differing ?? 0) <= allowance };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
