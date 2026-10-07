// Archive writer (docs/vault.md, "Container"): a standard ZIP written with fflate's synchronous streaming classes
// (Hermes has no Worker, so never fflate's async API). Every entry has a local header with bit 3 set, its data and a
// data descriptor; the central directory follows on finish(). Memory stays at one input slice plus fflate's 32 KiB
// window: each slice is read from the source file, compressed and written before the next, with a yield to the
// event loop in between (1 MiB slices for manual exports, 64 KiB for automatic runs, so the UI stays responsive).
import { File, FileMode, type FileHandle } from "expo-file-system";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

import { checkAborted, VaultError } from "../errors";

import { isEntryName } from "./zip-read";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** No ZIP64: offsets and sizes are 32-bit, so an archive stays below 4 GiB. */
const MAX_ARCHIVE = 0xffffffff;

export class ArchiveWriter {
  private readonly dest: File;
  private readonly level: 1 | 6;
  private readonly chunk: number;
  private readonly handle: FileHandle;
  private readonly zip: Zip;
  private readonly names = new Set<string>();
  private failure: unknown = null;
  private written = 0;
  private closed = false;

  /**
   * Creates `dest` (which must not exist; its folder must) and starts the archive. `level` is the DEFLATE level of
   * compressed entries (6 manual, 1 automatic and pre-restore); `chunk` the input bytes read per JS tick.
   */
  constructor(dest: File, level: 1 | 6, chunk = 1024 * 1024) {
    this.dest = dest;
    this.level = level;
    this.chunk = chunk;
    dest.create({ overwrite: false });
    try {
      this.handle = dest.open(FileMode.WriteOnly);
    } catch (e) {
      dest.delete();
      throw e;
    }
    this.zip = new Zip((err, data) => {
      if (this.failure !== null) return;
      if (err) this.failure = err;
      else if (this.written + data.length > MAX_ARCHIVE)
        this.failure = new VaultError("exportFailed", { detail: "archiveSize" });
      else {
        try {
          this.handle.writeBytes(data);
          this.written += data.length;
        } catch (e) {
          this.failure = e;
        }
      }
    });
  }

  /** Bytes written to the archive so far. */
  get bytes(): number {
    return this.written;
  }

  /**
   * Streams file `src` into entry `path`: DEFLATE when `compress`, else STORED (photos are already compressed).
   * Checks `signal` before every slice; `onBytes` receives the input bytes of each slice (progress).
   */
  async addFile(
    path: string,
    src: File,
    compress: boolean,
    signal?: AbortSignal,
    onBytes?: (bytes: number) => void
  ): Promise<void> {
    const entry = this.entry(path, compress);
    const input = src.open(FileMode.ReadOnly);
    try {
      const size = input.size ?? 0;
      if (size === 0) entry.push(new Uint8Array(0), true);
      for (let done = 0; done < size;) {
        checkAborted(signal);
        const bytes = input.readBytes(Math.min(this.chunk, size - done));
        if (!bytes.length) throw new VaultError("exportFailed", { detail: `shortRead:${path}` });
        done += bytes.length;
        entry.push(bytes, done >= size);
        this.check();
        onBytes?.(bytes.length);
        await tick();
      }
      this.check();
    } finally {
      input.close();
    }
  }

  /** A small entry from memory (README.txt, manifest.json): UTF-8, DEFLATE. */
  addText(path: string, text: string): void {
    this.addBytes(path, new TextEncoder().encode(text), true);
  }

  /** A small entry from memory. */
  addBytes(path: string, bytes: Uint8Array, compress: boolean): void {
    this.entry(path, compress).push(bytes, true);
    this.check();
  }

  /** Writes the central directory and closes the file. */
  finish(): void {
    this.zip.end();
    this.check();
    this.close();
  }

  /** Stops writing and deletes the partial file (after any failure or cancellation). */
  abort(): void {
    try {
      this.zip.terminate();
      this.close();
    } finally {
      if (this.dest.exists) this.dest.delete();
    }
  }

  private entry(path: string, compress: boolean): ZipDeflate | ZipPassThrough {
    if (this.closed) throw new Error("vault: the archive writer is closed");
    if (!isEntryName(path) || this.names.has(path))
      throw new VaultError("exportFailed", { detail: `entryName:${path}` });
    this.names.add(path);
    const entry = compress ? new ZipDeflate(path, { level: this.level }) : new ZipPassThrough(path);
    this.zip.add(entry);
    this.check();
    return entry;
  }

  private check() {
    if (this.failure !== null) throw this.failure;
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.handle.close();
  }
}
