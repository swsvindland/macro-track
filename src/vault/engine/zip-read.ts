// Archive reader (docs/vault.md, "Container" and "Limits"): entries are found through the central directory at the
// end of the file and read by offset, never by streaming local headers (a STORED photo may contain the bytes of a
// data-descriptor signature). Every archive is untrusted input: the reader checks names, offsets and compression
// ratios before reading anything, inflates in slices of at most 16 KiB and stops as soon as the output passes the
// size the caller expects (the manifest's `bytes`), so a crafted entry can neither escape the work folder nor fill
// the disk or the memory. CRC-32 is not checked: the caller verifies the manifest's SHA-256 of every extracted file.
import { File, FileMode, type FileHandle } from "expo-file-system";
import { Inflate } from "fflate";

import { checkAborted, VaultError } from "../errors";

export interface ZipEntry {
  name: string;
  /** 0 STORED, 8 DEFLATE. */
  method: 0 | 8;
  /** General-purpose flags (bit 3: sizes in a data descriptor after the data). */
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** End-of-central-directory record without its comment. */
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const MAX_ARCHIVE = 0xffffffff;
const MAX_DIRECTORY = 16 * 1024 * 1024;
/** DEFLATE cannot expand beyond ~1032:1; a larger claimed ratio is a crafted entry. */
const MAX_RATIO = 1100;
/**
 * Compressed bytes per Inflate push. Inflate decodes everything buffered at once, and a push of n bytes can yield up
 * to ~1032 × n (≤ ~17 MB for 16 KiB, held about four times over while fflate grows and copies its buffer). Near the
 * expected size the slices shrink to what the remaining output allows (at least 4 KiB), so a crafted entry overshoots
 * by little; far from it, full slices keep inflating fast.
 */
const SLICE = 16 * 1024;
const MIN_SLICE = 4 * 1024;
const READ = 1024 * 1024;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const corrupt = (detail: string, cause?: unknown) => new VaultError("corrupt", { detail, cause });
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/**
 * The entry-name rules every archive follows (the writer guarantees them, the reader enforces them): ASCII
 * letters, digits and `._/-` only (so no `\`), at most 200 bytes, no leading `/`, no `..` segment.
 */
export function isEntryName(name: string): boolean {
  return (
    name.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith("/") &&
    !name.split("/").includes("..")
  );
}

/** `length` bytes at `offset`, or `corrupt` when the file ends first. Seeks every time: extractions may interleave. */
function readAt(handle: FileHandle, offset: number, length: number): Uint8Array {
  if (length === 0) return new Uint8Array(0);
  handle.offset = offset;
  const bytes = handle.readBytes(length);
  if (bytes.length !== length) throw corrupt("truncated");
  return bytes;
}

export class ArchiveReader {
  /** Every entry of the central directory, by name. */
  readonly entries: Map<string, ZipEntry>;
  /** Size of the archive file in bytes. */
  readonly size: number;
  private readonly handle: FileHandle;
  private readonly directoryOffset: number;
  private closed = false;

  private constructor(
    handle: FileHandle,
    size: number,
    directoryOffset: number,
    entries: Map<string, ZipEntry>
  ) {
    this.handle = handle;
    this.size = size;
    this.directoryOffset = directoryOffset;
    this.entries = entries;
  }

  /**
   * Reads the central directory. Throws VaultError("notArchive") for a file that is not a ZIP at all (the caller then
   * tries a legacy JSON backup) and VaultError("corrupt") for a damaged or crafted one: a file that starts like a ZIP
   * but has no end record (a truncated download), ZIP64 or multi-disk markers, encryption, a method other than
   * STORED or DEFLATE, a bad or duplicate name, data that would overlap the directory, or an impossible ratio.
   */
  static open(file: File): ArchiveReader {
    const handle = file.open(FileMode.ReadOnly);
    try {
      const size = handle.size ?? 0;
      const head = size >= 4 ? readAt(handle, 0, 4) : new Uint8Array(0);
      const zipLike = head.length === 4 && (u32(head, 0) === LOCAL || u32(head, 0) === END);
      const missing = (detail: string) =>
        zipLike ? corrupt(detail) : new VaultError("notArchive", { detail });
      if (size < END_SIZE) throw missing("endRecord");
      const tailLength = Math.min(size, END_SIZE + MAX_COMMENT);
      const tail = readAt(handle, size - tailLength, tailLength);
      let at = -1;
      for (let i = tailLength - END_SIZE; i >= 0 && at < 0; i--)
        if (u32(tail, i) === END && i + END_SIZE + u16(tail, i + 20) === tailLength) at = i;
      if (at < 0) throw missing("endRecord");
      // No ZIP64: 32-bit offsets cannot address an archive beyond 4 GiB.
      if (size > MAX_ARCHIVE) throw corrupt("zip64");
      const endOffset = size - tailLength + at;
      const disk = u16(tail, at + 4);
      const directoryDisk = u16(tail, at + 6);
      const onDisk = u16(tail, at + 8);
      const total = u16(tail, at + 10);
      const directorySize = u32(tail, at + 12);
      const directoryOffset = u32(tail, at + 16);
      if (
        total === 0xffff ||
        onDisk === 0xffff ||
        directorySize === 0xffffffff ||
        directoryOffset === 0xffffffff
      )
        throw corrupt("zip64");
      if (disk !== 0 || directoryDisk !== 0 || onDisk !== total) throw corrupt("multiDisk");
      if (directorySize > MAX_DIRECTORY || directoryOffset + directorySize > endOffset)
        throw corrupt("directoryBounds");
      const directory = readAt(handle, directoryOffset, directorySize);
      const entries = new Map<string, ZipEntry>();
      for (let i = 0, p = 0; i < total; i++) {
        if (p + 46 > directorySize || u32(directory, p) !== CENTRAL) throw corrupt("directory");
        const flags = u16(directory, p + 8);
        const method = u16(directory, p + 10);
        const crc32 = u32(directory, p + 16);
        const compressedSize = u32(directory, p + 20);
        const entrySize = u32(directory, p + 24);
        const nameLength = u16(directory, p + 28);
        const extraLength = u16(directory, p + 30);
        const commentLength = u16(directory, p + 32);
        const startDisk = u16(directory, p + 34);
        const localHeaderOffset = u32(directory, p + 42);
        const next = p + 46 + nameLength + extraLength + commentLength;
        if (next > directorySize) throw corrupt("directory");
        const raw = directory.subarray(p + 46, p + 46 + nameLength);
        if (nameLength > 200 || raw.some((byte) => byte > 0x7f)) throw corrupt("entryName");
        const name = String.fromCharCode(...raw);
        if (!isEntryName(name)) throw corrupt("entryName");
        if (entries.has(name)) throw corrupt("duplicateEntry");
        // bit 0: encrypted; bit 6: strong encryption
        if (flags & 0x41) throw corrupt("encrypted");
        if (method !== 0 && method !== 8) throw corrupt("method");
        if (
          compressedSize === 0xffffffff ||
          entrySize === 0xffffffff ||
          localHeaderOffset === 0xffffffff ||
          startDisk === 0xffff
        )
          throw corrupt("zip64");
        if (startDisk !== 0) throw corrupt("multiDisk");
        if (localHeaderOffset + 30 + nameLength + extraLength + compressedSize > directoryOffset)
          throw corrupt("entryBounds");
        if (
          method === 8
            ? entrySize > compressedSize * MAX_RATIO + 1024
            : entrySize !== compressedSize
        )
          throw corrupt("ratio");
        entries.set(name, {
          name,
          method,
          flags,
          crc32,
          compressedSize,
          size: entrySize,
          localHeaderOffset,
        });
        p = next;
      }
      return new ArchiveReader(handle, size, directoryOffset, entries);
    } catch (e) {
      handle.close();
      throw e;
    }
  }

  /** Whether the archive has an entry of that name. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Writes entry `name` to `dest` (created, parents included; replaced when it exists) and returns its size. Fails
   * `corrupt` (and deletes `dest`) when the entry is missing, damaged, or produces more than `maxBytes` bytes or a
   * size other than the directory's; `cancelled` between reads when `signal` is aborted.
   */
  async extract(name: string, dest: File, maxBytes: number, signal?: AbortSignal): Promise<number> {
    const entry = this.entry(name);
    dest.create({ intermediates: true, overwrite: true });
    const out = dest.open(FileMode.WriteOnly);
    let done = false;
    try {
      const written = await this.read(entry, maxBytes, signal, (chunk) => out.writeBytes(chunk));
      done = true;
      return written;
    } finally {
      out.close();
      if (!done && dest.exists) dest.delete();
    }
  }

  /** Entry `name` as UTF-8 text (`corrupt` beyond `maxBytes` or for invalid UTF-8). For manifest.json. */
  async readText(name: string, maxBytes: number): Promise<string> {
    const entry = this.entry(name);
    const parts: Uint8Array[] = [];
    const total = await this.read(entry, maxBytes, undefined, (chunk) => parts.push(chunk));
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      throw corrupt("utf8", e);
    }
  }

  /** Closes the file (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handle.close();
  }

  private entry(name: string): ZipEntry {
    if (this.closed) throw new Error("vault: the archive reader is closed");
    const entry = this.entries.get(name);
    if (!entry) throw corrupt(`missing:${name}`);
    return entry;
  }

  /** Where the entry's data starts, after checking its local header against the central directory. */
  private dataOffset(entry: ZipEntry): number {
    const local = readAt(this.handle, entry.localHeaderOffset, 30);
    if (u32(local, 0) !== LOCAL || u16(local, 8) !== entry.method) throw corrupt("localHeader");
    const nameLength = u16(local, 26);
    const extraLength = u16(local, 28);
    if (nameLength !== entry.name.length) throw corrupt("localHeader");
    const name = readAt(this.handle, entry.localHeaderOffset + 30, nameLength);
    if (String.fromCharCode(...name) !== entry.name) throw corrupt("localHeader");
    const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (start + entry.compressedSize > this.directoryOffset) throw corrupt("entryBounds");
    return start;
  }

  /** Streams the entry's uncompressed bytes to `sink`; returns the total. */
  private async read(
    entry: ZipEntry,
    maxBytes: number,
    signal: AbortSignal | undefined,
    sink: (chunk: Uint8Array) => void
  ): Promise<number> {
    const start = this.dataOffset(entry);
    if (entry.method === 0) {
      if (entry.compressedSize > maxBytes) throw corrupt("size");
      for (let done = 0; done < entry.compressedSize;) {
        checkAborted(signal);
        const chunk = readAt(
          this.handle,
          start + done,
          Math.min(READ, entry.compressedSize - done)
        );
        done += chunk.length;
        sink(chunk);
        await tick();
      }
      return entry.compressedSize;
    }
    const limit = Math.min(maxBytes, entry.size);
    let total = 0;
    // Set inside Inflate's callback: the size guard, or the sink's own error (a full disk is not a damaged archive).
    let failure: unknown = null;
    const inflate = new Inflate((chunk) => {
      if (failure !== null) return;
      total += chunk.length;
      if (total > limit) {
        failure = corrupt("size");
        return;
      }
      try {
        sink(chunk);
      } catch (e) {
        failure = e;
      }
    });
    const push = (chunk: Uint8Array, final: boolean) => {
      try {
        inflate.push(chunk, final);
      } catch (e) {
        throw failure ?? corrupt("deflate", e);
      }
      if (failure !== null) throw failure;
    };
    let slices = 0;
    for (let done = 0; done < entry.compressedSize;) {
      checkAborted(signal);
      const block = readAt(this.handle, start + done, Math.min(READ, entry.compressedSize - done));
      done += block.length;
      for (let i = 0; i < block.length;) {
        const slice = Math.min(SLICE, Math.max(MIN_SLICE, Math.floor((limit - total) / MAX_RATIO)));
        push(block.subarray(i, i + slice), false);
        i += slice;
        if (++slices % 64 === 0) {
          await tick();
          checkAborted(signal);
        }
      }
    }
    push(new Uint8Array(0), true);
    if (total !== entry.size) throw corrupt("size");
    return total;
  }
}
