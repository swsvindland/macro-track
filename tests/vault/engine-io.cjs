// G2, G3, G4, G14, G17, engine I/O (synced, hash-checked; loaded by tests/vault.test.*): the NDJSON row codec and
// line reader, the ZIP writer and reader (round trips, damaged and crafted archives, zip bombs), the manifest rules,
// the lock, and the smaller engine modules (paths, state, db helpers, CSV, provenance SQL, change source). Every
// test runs the vault's real TypeScript in a harness world against this repo's real descriptor and schema.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const vault = require("../vault-harness.cjs");

const KiB = 1024;
const MiB = 1024 * KiB;
const APPS = ["body", "lift", "macro", "water"];

/** A world closed after the test, with expo-file-system at hand. */
async function open(t, options) {
  const w = await vault.world(options);
  t.after(() => w.close());
  const { File, Directory, Paths } = w.require("expo-file-system");
  /** Writes `bytes` (Buffer or string) under Documents and returns it as an expo File. */
  const put = (name, bytes) => {
    fs.mkdirSync(path.dirname(w.file(name)), { recursive: true });
    fs.writeFileSync(w.file(name), bytes);
    return new File(w.uri(name));
  };
  return { w, File, Directory, Paths, put };
}

/** The VaultError code `fn` throws or rejects with; null when it succeeds. Other errors propagate. */
async function failure(fn) {
  try {
    await fn();
  } catch (e) {
    if (e && e.name === "VaultError") return e.code;
    throw e;
  }
  return null;
}

/** The whole VaultError `fn` throws or rejects with (assertion error when it succeeds). */
async function vaultError(fn) {
  try {
    await fn();
  } catch (e) {
    if (e && e.name === "VaultError") return e;
    throw e;
  }
  assert.fail("expected a VaultError");
}

// ---------------------------------------------------------------------------------------------------------------
// A ZIP builder with full control over every header field, for crafted archives

/**
 * entries: { name, data (bytes as stored), method = 0, flags = 0, size (claimed uncompressed, default
 * data.length), compressedSize (claimed, default data.length), offset (claimed local header offset), localName }.
 * `directoryOffset` overrides the end record's central-directory offset.
 */
function zipBytes(entries, { directoryOffset } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "latin1");
    const localName = Buffer.from(e.localName ?? e.name, "latin1");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(e.method ?? 0, 8);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.size ?? e.data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    parts.push(local, localName, e.data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(e.flags ?? 0, 8);
    record.writeUInt16LE(e.method ?? 0, 10);
    record.writeUInt32LE(e.compressedSize ?? e.data.length, 20);
    record.writeUInt32LE(e.size ?? e.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(e.offset ?? offset, 42);
    central.push(record, name);
    offset += 30 + localName.length + e.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(directoryOffset ?? offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Raw DEFLATE of `copies` MiB of zeros, ~1 KiB per MiB: sync-flushed blocks concatenate into one valid stream. */
function zeroBomb(copies) {
  const block = zlib.deflateRawSync(Buffer.alloc(MiB), {
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  });
  return Buffer.concat([...Array.from({ length: copies }, () => block), Buffer.from([3, 0])]);
}

// ---------------------------------------------------------------------------------------------------------------
// G2 row codec

const CODEC_TABLE =
  "(id INTEGER PRIMARY KEY, i INTEGER, n NUMERIC, r REAL, t TEXT, b BLOB, x, j TEXT)";
const CODEC_COLUMNS = ["id", "i", "n", "r", "t", "b", "x", "j"];

test(
  "G2 row codec: tagged values, unicode and JSON text round-trip exactly",
  { skip: vault.skip },
  async (t) => {
    const { w, File } = await open(t);
    const { writeRows, readLines, rowDecoder, MAX_LINE } = w.require("@/vault/engine/rows");
    const { tableColumns, affinity } = w.require("@/vault/engine/db");
    const db = w.open("codec.db");
    db.execSync(`CREATE TABLE codec ${CODEC_TABLE}; CREATE TABLE copy ${CODEC_TABLE};`);
    const json = '{"a":1.50, "b":[1,2,{"c":"\\u00e9"}],"d":"😀"}';
    db.execSync(
      "INSERT INTO codec VALUES (1, 9007199254740993, 9007199254740993, 9e999, NULL, x'00ff10', NULL, NULL)"
    );
    db.execSync(
      "INSERT INTO codec VALUES (2, -9223372036854775808, -9223372036854775808, -9e999, NULL, x'', 7, NULL)"
    );
    db.execSync(
      "INSERT INTO codec VALUES (3, 9223372036854775807, 42, 80.0, NULL, NULL, 0.1, NULL)"
    );
    db.execSync("INSERT INTO codec VALUES (4, NULL, NULL, NULL, NULL, NULL, NULL, NULL)");
    db.execSync("INSERT INTO codec VALUES (-7, 7, 1.5, 0.1, NULL, x'deadbeef', 'untyped', NULL)");
    const texts = {
      1: "😀👍🏽 漢字かな 한국어",
      2: "‏שלום‫ עולם‬ مرحبا",
      3: 'quote " backslash \\ tab \t newline \n line separator   end',
      4: "",
      [-7]: "{not json",
    };
    for (const [id, text] of Object.entries(texts))
      db.runSync("UPDATE codec SET t = ?, j = ? WHERE id = ?", [text, json, Number(id)]);

    const file = new File(w.uri("codec.ndjson"));
    const written = await writeRows(db, { table: "codec", columns: CODEC_COLUMNS }, file);
    assert.equal(written.rows, 5);
    assert.equal(written.tagged, true);
    const raw = fs.readFileSync(w.file("codec.ndjson"));
    assert.equal(written.bytes, raw.length);
    const text = raw.toString("utf8");
    assert.ok(text.endsWith("\n") && !text.startsWith("\uFEFF"));
    const lines = text.slice(0, -1).split("\n");
    assert.equal(lines.length, 5);
    for (const line of lines) assert.ok(line.startsWith('{"id":'), line);
    assert.match(text, /"i":\{"\$int":"9007199254740993"\}/);
    assert.match(text, /"i":\{"\$int":"-9223372036854775808"\}/);
    assert.match(text, /"i":\{"\$int":"9223372036854775807"\}/);
    assert.match(text, /"r":\{"\$real":"Infinity"\}/);
    assert.match(text, /"r":\{"\$real":"-Infinity"\}/);
    assert.match(text, /"b":\{"\$hex":"00ff10"\}/);
    assert.match(text, /"b":\{"\$hex":""\}/);
    assert.match(text, /"n":42,/);
    assert.match(text, /"r":80,/);
    // JSON text is a string value, byte for byte.
    assert.equal(JSON.parse(lines[0]).j, json);

    const affinities = tableColumns(db, "copy").map((c) => affinity(c.type));
    assert.deepEqual(affinities, [
      "INTEGER",
      "INTEGER",
      "NUMERIC",
      "REAL",
      "TEXT",
      "BLOB",
      "BLOB",
      "TEXT",
    ]);
    const decode = rowDecoder(CODEC_COLUMNS, affinities);
    const insert = db.prepareSync(
      `INSERT INTO copy VALUES (${CODEC_COLUMNS.map(() => "?").join(", ")})`
    );
    const count = await readLines(file, { maxLine: MAX_LINE, chunkBytes: 7 }, (line) =>
      insert.executeSync(decode(line))
    );
    insert.finalizeSync();
    assert.equal(count, 5);
    const dump = (table) =>
      db.getAllSync(
        `SELECT ${CODEC_COLUMNS.map((c) => `typeof(${c}) AS "${c}:type", quote(${c}) AS "${c}"`).join(", ")} FROM ${table} ORDER BY id`
      );
    assert.deepEqual(dump("copy"), dump("codec"));
  }
);

test(
  "G2 row codec: the plain path pages by rowid across gaps, negative and huge rowids",
  { skip: vault.skip },
  async (t) => {
    const { w, File } = await open(t);
    const { writeRows, readLines, rowDecoder, keysFilter, MAX_LINE } =
      w.require("@/vault/engine/rows");
    const db = w.open("paging.db");
    db.execSync(
      "CREATE TABLE plain (v TEXT, n REAL); CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT)"
    );
    const rowids = ["-5", "0", "4611686018427387904", "9007199254740993", "9223372036854775807"];
    for (let i = 1; i <= 1210; i++) if (i % 97 !== 0) rowids.push(String(i));
    db.withTransactionSync(() => {
      for (const rowid of rowids)
        db.runSync(`INSERT INTO plain (rowid, v, n) VALUES (${rowid}, ?, ?)`, [
          `row ${rowid}`,
          0.5,
        ]);
    });
    const file = new File(w.uri("plain.ndjson"));
    const pages = [];
    const written = await writeRows(db, { table: "plain", columns: ["v", "n"] }, file, {
      onPage: (rows) => pages.push(rows),
    });
    assert.equal(written.tagged, false);
    assert.equal(written.rows, rowids.length);
    assert.ok(pages.length >= 3, `pages: ${pages}`);
    const seen = [];
    const decode = rowDecoder(["v", "n"], ["TEXT", "REAL"]);
    await readLines(file, { maxLine: MAX_LINE }, (line) => seen.push(decode(line)[0]));
    assert.deepEqual([...seen].sort(), rowids.map((r) => `row ${r}`).sort());
    assert.equal(new Set(seen).size, seen.length);

    // keys mode: only the key universe, bound as parameters.
    for (const [key, value] of [
      ["a", "1"],
      ["b", "2"],
      ["c'q", "3"],
      ["d", "4"],
    ])
      db.runSync("INSERT INTO prefs VALUES (?, ?)", [key, value]);
    const prefs = new File(w.uri("prefs.ndjson"));
    const keyed = await writeRows(
      db,
      { table: "prefs", columns: ["key", "value"], where: keysFilter("key", ["a", "c'q", "z"]) },
      prefs
    );
    assert.equal(keyed.rows, 2);
    assert.equal(
      fs.readFileSync(w.file("prefs.ndjson"), "utf8"),
      '{"key":"a","value":"1"}\n{"key":"c\'q","value":"3"}\n'
    );
    const empty = await writeRows(
      db,
      { table: "plain", columns: ["v"], where: { sql: "0" } },
      new File(w.uri("none.ndjson"))
    );
    assert.deepEqual([empty.rows, empty.bytes], [0, 0]);
    assert.equal(fs.readFileSync(w.file("none.ndjson")).length, 0);
  }
);

test("G2 row codec: malformed rows are corrupt", { skip: vault.skip }, async (t) => {
  const { w } = await open(t);
  const { rowDecoder, decodeValue } = w.require("@/vault/engine/rows");
  const decode = rowDecoder(["i", "t", "b"], ["INTEGER", "TEXT", "BLOB"]);
  const values = decode('{"i":{"$int":"-9223372036854775808"},"t":"x","b":{"$hex":"0aff"}}');
  assert.equal(values[0], "-9223372036854775808");
  assert.equal(values[1], "x");
  assert.deepEqual([...values[2]], [10, 255]);
  assert.deepEqual(decode('{"b":null,"t":null,"i":5}'), [5, null, null]);
  const bad = [
    "",
    "not json",
    "[1,2,3]",
    "null",
    '"text"',
    "5",
    '{"i":1,"t":"x"}',
    '{"i":1,"t":"x","b":null,"extra":1}',
    '{"i":1,"t":"x","c":null}',
    '{"i":true,"t":"x","b":null}',
    '{"i":[1],"t":"x","b":null}',
    '{"i":{},"t":"x","b":null}',
    '{"i":{"$int":5},"t":"x","b":null}',
    '{"i":{"$int":"12a"},"t":"x","b":null}',
    '{"i":{"$int":"1.5"},"t":"x","b":null}',
    '{"i":{"$int":"12345678901234567890"},"t":"x","b":null}',
    '{"i":{"$int":"9223372036854775808"},"t":"x","b":null}',
    '{"i":{"$int":"-9223372036854775809"},"t":"x","b":null}',
    '{"i":{"$int":"1","$real":"Infinity"},"t":"x","b":null}',
    '{"i":{"$real":"NaN"},"t":"x","b":null}',
    '{"i":{"$real":"infinity"},"t":"x","b":null}',
    '{"i":{"$foo":"1"},"t":"x","b":null}',
    '{"i":1,"t":{"$int":"5"},"b":null}',
    '{"i":1,"t":"x","b":{"$hex":"abc"}}',
    '{"i":1,"t":"x","b":{"$hex":"AB"}}',
    '{"i":1,"t":"x","b":{"$hex":"zz"}}',
    // A plain number that overflows: the writer tags infinities, so this is not one of ours.
    '{"i":1e999,"t":"x","b":null}',
  ];
  for (const line of bad) assert.equal(await failure(() => decode(line)), "corrupt", line);
  assert.equal(await failure(() => decodeValue({ $int: "5" }, "REAL")), "corrupt");
  assert.equal(decodeValue({ $int: "5" }, "NUMERIC"), "5");
  assert.equal(decodeValue({ $real: "-Infinity" }, "TEXT"), -Infinity);
  // A future vault-owned column this reader does not own: its key is required and dropped.
  const dropping = rowDecoder(["a", "future_id"], ["TEXT", null]);
  assert.deepEqual(dropping('{"a":"x","future_id":"y"}'), ["x"]);
  assert.equal(await failure(() => dropping('{"a":"x"}')), "corrupt");
});

test(
  "G2 line reader: multi-byte characters across reads, line cap, missing newline, invalid UTF-8",
  { skip: vault.skip },
  async (t) => {
    const { w, put } = await open(t);
    const { readLines } = w.require("@/vault/engine/rows");
    const read = async (file, options = {}) => {
      const lines = [];
      await readLines(file, { maxLine: 1000, ...options }, (line) => lines.push(line));
      return lines;
    };
    const text = ["😀👍🏽", "漢字かな", "‏שלום", "", "plain"];
    for (const chunkBytes of [1, 2, 3, 5, 7, 256 * KiB])
      assert.deepEqual(await read(put("lines.txt", `${text.join("\n")}\n`), { chunkBytes }), text);
    assert.deepEqual(await read(put("empty.txt", "")), []);
    assert.equal(await failure(() => read(put("open.txt", "a\nb"))), "corrupt");
    assert.equal(
      await failure(() => read(put("long.txt", `${"x".repeat(11)}\n`), { maxLine: 10 })),
      "corrupt"
    );
    assert.equal(
      await failure(() => read(put("long2.txt", "x".repeat(40)), { maxLine: 10, chunkBytes: 4 })),
      "corrupt"
    );
    assert.equal(
      await failure(() => read(put("bad.txt", Buffer.from([0x61, 0xff, 0x0a])))),
      "corrupt"
    );
    assert.equal(
      await failure(() => read(put("cut.txt", Buffer.from([0x61, 0x0a, 0xf0, 0x9f])))),
      "corrupt"
    );
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G3 ZIP

/** 200 KiB of random bytes carrying every ZIP signature, one of them across a 64 KiB read. */
function mediaBytes() {
  const bytes = randomBytes(200 * KiB);
  const signatures = [
    [0x50, 0x4b, 0x07, 0x08],
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x01, 0x02],
    [0x50, 0x4b, 0x05, 0x06],
  ];
  const at = [0, 64 * KiB - 2, 100_000, bytes.length - 4];
  signatures.forEach((s, i) => Buffer.from(s).copy(bytes, at[i]));
  return bytes;
}

async function sampleArchive(t, level = 6) {
  const opened = await open(t);
  const { w, File, put } = opened;
  const { ArchiveWriter } = w.require("@/vault/engine/zip-write");
  const data = Buffer.from(
    Array.from(
      { length: 4000 },
      (_, i) => `{"id":${i},"name":"row ${i} ${"x".repeat(i % 50)}"}\n`
    ).join("")
  );
  const media = mediaBytes();
  const sources = {
    "data/rows.ndjson": put("src/rows.ndjson", data),
    "media/progress-photos/1790000000000-a1b2c3.png": put("src/photo.png", media),
    "data/empty.ndjson": put("src/empty.ndjson", ""),
    "media/progress-photos/empty.jpg": put("src/empty.jpg", ""),
  };
  const contents = {
    "data/rows.ndjson": data,
    "media/progress-photos/1790000000000-a1b2c3.png": media,
    "data/empty.ndjson": Buffer.alloc(0),
    "media/progress-photos/empty.jpg": Buffer.alloc(0),
    "README.txt": Buffer.from("read me\n"),
    "manifest.json": Buffer.from('{"format":"pendum.archive"}\n'),
  };
  fs.mkdirSync(w.file("out"), { recursive: true });
  const dest = new File(w.uri("out", "archive.pendumlift"));
  const writer = new ArchiveWriter(dest, level, 64 * KiB);
  let fed = 0;
  for (const [name, src] of Object.entries(sources))
    await writer.addFile(name, src, name.startsWith("data/"), undefined, (n) => (fed += n));
  writer.addText("README.txt", "read me\n");
  writer.addText("manifest.json", '{"format":"pendum.archive"}\n');
  writer.finish();
  assert.equal(fed, data.length + media.length);
  assert.equal(writer.bytes, fs.statSync(w.file("out", "archive.pendumlift")).size);
  return { ...opened, dest, contents, bytes: fs.readFileSync(w.file("out", "archive.pendumlift")) };
}

test(
  "G3 ZIP round trip: data descriptors, STORED media with signature bytes, empty entries",
  { skip: vault.skip },
  async (t) => {
    const { w, File, dest, contents, bytes } = await sampleArchive(t);
    const { ArchiveReader } = w.require("@/vault/engine/zip-read");
    const reader = ArchiveReader.open(dest);
    t.after(() => reader.close());
    assert.deepEqual([...reader.entries.keys()].sort(), Object.keys(contents).sort());
    for (const [name, expected] of Object.entries(contents)) {
      const entry = reader.entries.get(name);
      assert.equal(entry.flags & 8, 8, `${name}: sizes in a data descriptor`);
      assert.equal(entry.method, name.startsWith("media/") ? 0 : 8, name);
      assert.equal(entry.size, expected.length, name);
      const out = new File(w.uri("extracted", name));
      assert.equal(await reader.extract(name, out, expected.length), expected.length);
      assert.ok(Buffer.from(fs.readFileSync(w.file("extracted", name))).equals(expected), name);
    }
    assert.equal(await reader.readText("manifest.json", 4 * MiB), '{"format":"pendum.archive"}\n');
    // An independent reader (fflate's central-directory unzip) agrees byte for byte.
    const { unzipSync } = w.require("fflate");
    const unzipped = unzipSync(new Uint8Array(bytes));
    for (const [name, expected] of Object.entries(contents))
      assert.ok(Buffer.from(unzipped[name]).equals(expected), name);
  }
);

test(
  "G3 ZIP writer guards: entry names, an existing destination, abort",
  { skip: vault.skip },
  async (t) => {
    const { w, File, put } = await open(t);
    const { ArchiveWriter } = w.require("@/vault/engine/zip-write");
    const taken = put("taken.zip", "x");
    assert.throws(() => new ArchiveWriter(taken, 1));
    const dest = new File(w.uri("w.zip"));
    const writer = new ArchiveWriter(dest, 1);
    for (const name of ["../x", "/x", "a\\b", "a/../b", "é.txt", "", "x".repeat(201)])
      assert.equal(await failure(() => writer.addText(name, "x")), "exportFailed", name);
    writer.addText("a.txt", "x");
    assert.equal(await failure(() => writer.addText("a.txt", "y")), "exportFailed");
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await failure(() =>
        writer.addFile("b.bin", put("b.bin", randomBytes(10)), true, controller.signal)
      ),
      "cancelled"
    );
    writer.abort();
    assert.equal(dest.exists, false);
  }
);

test("G3 damaged, foreign and crafted archives", { skip: vault.skip }, async (t) => {
  const { w, put, bytes } = await sampleArchive(t);
  const { ArchiveReader } = w.require("@/vault/engine/zip-read");
  const opens = (name, content) => failure(() => ArchiveReader.open(put(name, content)).close());

  // Truncated downloads start like a ZIP: damaged, not "some other file".
  assert.equal(await opens("half.zip", bytes.subarray(0, bytes.length >> 1)), "corrupt");
  assert.equal(await opens("cut.zip", bytes.subarray(0, bytes.length - 1)), "corrupt");
  assert.equal(await opens("stub.zip", bytes.subarray(0, 10)), "corrupt");
  // No end record and not a ZIP at all: the caller tries a legacy backup next.
  assert.equal(
    await opens("legacy.json", '{"format":"lift-track-backup","version":1}'),
    "notArchive"
  );
  assert.equal(await opens("random.bin", randomBytes(4096)), "notArchive");
  assert.equal(await opens("empty.bin", ""), "notArchive");
  // An end record whose directory lies outside the file.
  const moved = Buffer.from(bytes);
  moved.writeUInt32LE(bytes.length, bytes.length - 6);
  assert.equal(await opens("moved.zip", moved), "corrupt");
  const zip64 = Buffer.from(bytes);
  zip64.writeUInt32LE(0xffffffff, bytes.length - 6);
  assert.equal(await opens("zip64.zip", zip64), "corrupt");

  const plain = (name, extra = {}) => ({ name, data: Buffer.from("hello"), ...extra });
  for (const name of ["../x", "/x", "a\\b", "data/../../x", "café.txt", "x".repeat(201)])
    assert.equal(await opens("name.zip", zipBytes([plain(name)])), "corrupt", name);
  assert.equal(await opens("ok.zip", zipBytes([plain("data/a.ndjson")])), null);
  assert.equal(await opens("dup.zip", zipBytes([plain("a.txt"), plain("a.txt")])), "corrupt");
  assert.equal(await opens("enc.zip", zipBytes([plain("a.txt", { flags: 1 })])), "corrupt");
  assert.equal(await opens("bzip.zip", zipBytes([plain("a.txt", { method: 12 })])), "corrupt");
  assert.equal(await opens("stored.zip", zipBytes([plain("a.txt", { size: 6 })])), "corrupt");
  assert.equal(
    await opens("big.zip", zipBytes([plain("a.txt", { method: 8, size: 0xffffffff })])),
    "corrupt"
  );

  // Checked when reading: the local header must match the directory; DEFLATE data must be valid.
  const mismatch = ArchiveReader.open(
    put("local.zip", zipBytes([plain("a.txt", { localName: "b.txt" })]))
  );
  t.after(() => mismatch.close());
  assert.equal(await failure(() => mismatch.readText("a.txt", 100)), "corrupt");
  assert.equal(await failure(() => mismatch.readText("missing.txt", 100)), "corrupt");
  const garbage = ArchiveReader.open(
    put(
      "garbage.zip",
      zipBytes([{ name: "a.txt", data: Buffer.from([0xff, 0xff, 0xff]), method: 8, size: 10 }])
    )
  );
  t.after(() => garbage.close());
  assert.equal(await failure(() => garbage.readText("a.txt", 100)), "corrupt");
});

test(
  "G3 bounded extraction: more output than the manifest says is corrupt; unlisted entries are ignored",
  { skip: vault.skip },
  async (t) => {
    const { w, File, put, contents, bytes } = await sampleArchive(t);
    const { ArchiveReader } = w.require("@/vault/engine/zip-read");
    const { entryProblems, listedEntries } = w.require("@/vault/engine/manifest");
    const name = "data/rows.ndjson";
    const size = contents[name].length;
    const reader = ArchiveReader.open(put("copy.zip", bytes));
    t.after(() => reader.close());
    const out = new File(w.uri("x", "rows.ndjson"));
    assert.equal(await failure(() => reader.extract(name, out, size - 1)), "corrupt");
    assert.equal(out.exists, false, "a failed extraction leaves no file");
    const photo = "media/progress-photos/1790000000000-a1b2c3.png";
    assert.equal(
      await failure(() => reader.extract(photo, out, contents[photo].length - 1)),
      "corrupt"
    );
    assert.equal(await reader.extract(name, out, size), size);
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await failure(() => reader.extract(name, out, size, controller.signal)),
      "cancelled"
    );

    // The manifest lists two entries; README, manifest and the empty files are extra and ignored.
    const manifest = {
      tables: [{ name: "rows", file: name, bytes: size, sha256: "0".repeat(64) }],
      media: [
        {
          set: "progress-photos",
          name: "1790000000000-a1b2c3.png",
          bytes: contents[photo].length,
          sha256: "1".repeat(64),
          embedded: true,
        },
        {
          set: "progress-photos",
          name: "remote.jpg",
          bytes: 5,
          sha256: "2".repeat(64),
          embedded: false,
        },
      ],
      files: [],
    };
    assert.deepEqual(
      listedEntries(manifest).map((e) => e.path),
      [name, photo]
    );
    assert.deepEqual(entryProblems(manifest, reader.entries), []);
    manifest.tables[0].bytes = size + 1;
    manifest.files = [{ path: "csv/sets.csv", role: "csv", sha256: "3".repeat(64), bytes: 1 }];
    assert.deepEqual(entryProblems(manifest, reader.entries), [
      { path: name, problem: "size" },
      { path: "csv/sets.csv", problem: "missing" },
    ]);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G4 manifest rules

/** A valid manifest of this repo's app at its current schema level. */
function sampleManifest(w, extra = {}) {
  const { buildManifest } = w.require("@/vault/engine/manifest");
  const { vaultApp, vaultIdentity } = w.require("@/vault/app");
  const entries = vaultApp.migrations.journal.entries;
  const last = entries[entries.length - 1];
  const table = vaultApp.tables[0].name;
  return buildManifest({
    kind: "manual",
    createdAt: "2026-10-04T15:30:12.345Z",
    app: {
      id: vaultApp.id,
      bundleId: vaultIdentity.bundleId,
      name: vaultIdentity.name,
      version: "1.0.0",
      build: "14",
      platform: "ios",
      osVersion: "26.1",
    },
    schema: {
      applied: entries.length,
      lastCreatedAt: last.when,
      lastTag: last.tag,
      journalLength: entries.length,
    },
    device: {
      id: "2b1f9a3c-0000-4000-8000-00000000abcd",
      platform: "ios",
      kind: "phone",
      model: "iPhone",
    },
    library: { id: "9c40aa00-1111-4111-8111-000000000001" },
    vaultColumns: ["sync_id"],
    tables: [
      {
        name: table,
        mode: "replace",
        file: `data/${table}.ndjson`,
        rows: 0,
        columns: ["id"],
        sequence: null,
        sha256: "a".repeat(64),
        bytes: 0,
      },
    ],
    media: [],
    files: [{ path: "README.txt", role: "readme", sha256: "b".repeat(64), bytes: 10 }],
    counts: { latest: null, total: 3, first: "2026-01-01" },
    provenance: { health: false, healthSyncOn: false },
    warnings: [],
    ...extra,
  });
}

test(
  "G4 manifest: format, reader version, app and schema level rules",
  { skip: vault.skip },
  async (t) => {
    const { w } = await open(t);
    const { parseManifest, manifestText, schemaLevel, readmeText } =
      w.require("@/vault/engine/manifest");
    const { vaultApp } = w.require("@/vault/app");
    const apps = w.require("@/vault/apps.json");
    const journal = vaultApp.migrations.journal;
    const id = vaultApp.id;
    const m = sampleManifest(w);
    assert.equal(m.format, "pendum.archive");
    assert.equal(m.app.vault, w.require("@/vault/version").VAULT_VERSION);
    assert.deepEqual(Object.keys(m).slice(0, 5), [
      "format",
      "formatVersion",
      "minReaderVersion",
      "kind",
      "createdAt",
    ]);
    const text = (value) => JSON.stringify(value);
    assert.deepEqual(parseManifest(manifestText(m), id), m);
    assert.ok(manifestText(m).endsWith("}\n") && manifestText(m).includes('\n  "format"'));

    // Rule 1, 2, 3 in that order, before the schema is judged.
    assert.equal(
      await failure(() => parseManifest(text({ ...m, format: "zip" }), id)),
      "notArchive"
    );
    assert.equal(
      await failure(() =>
        parseManifest(text({ format: "pendum.archive", minReaderVersion: 3, tables: "x" }), id)
      ),
      "newer"
    );
    const other = APPS.find((a) => a !== id);
    const wrong = await vaultError(() =>
      parseManifest(text({ ...m, app: { ...m.app, id: other, name: apps[other].name } }), id)
    );
    assert.equal(wrong.code, "wrongApp");
    assert.equal(wrong.info.app, apps[other].name);
    assert.equal(
      await failure(() => parseManifest(text({ ...m, app: { ...m.app, id: "fitness" } }), id)),
      "wrongApp"
    );
    // A newer writer that stays readable: unknown fields everywhere are ignored.
    const future = {
      ...m,
      formatVersion: 3,
      future: { anything: [1, 2] },
      app: { ...m.app, store: "testflight" },
      tables: [{ ...m.tables[0], hint: "x" }],
    };
    assert.equal(parseManifest(text(future), id).formatVersion, 3);

    // Rule 4.
    const entries = journal.entries;
    assert.deepEqual(schemaLevel(m, journal), { applied: entries.length, olderSchema: false });
    const level = (schema) =>
      failure(() => schemaLevel({ ...m, schema: { ...m.schema, ...schema } }, journal));
    assert.equal(await level({ applied: entries.length + 1 }), "newer");
    assert.equal(await level({ lastTag: "0099_elsewhere" }), "unknownSchema");
    assert.equal(await level({ lastCreatedAt: m.schema.lastCreatedAt + 1 }), "unknownSchema");
    if (entries.length > 1) {
      const older = entries[entries.length - 2];
      assert.deepEqual(
        schemaLevel(
          {
            ...m,
            schema: {
              ...m.schema,
              applied: entries.length - 1,
              lastTag: older.tag,
              lastCreatedAt: older.when,
            },
          },
          journal
        ),
        { applied: entries.length - 1, olderSchema: true }
      );
    }
    assert.equal(
      readmeText("Pendum Lift", "2026-10-04").split("\n")[0],
      "This file is a Pendum Lift backup made on 2026-10-04."
    );
  }
);

test("G4 manifest: schema violations are corrupt", { skip: vault.skip }, async (t) => {
  const { w } = await open(t);
  const { parseManifest } = w.require("@/vault/engine/manifest");
  const id = w.require("@/vault/app").vaultApp.id;
  const m = sampleManifest(w);
  const table = m.tables[0];
  const cases = {
    "not JSON": "{",
    "an array": "[]",
    "no files": JSON.stringify({ ...m, files: undefined }),
    "formatVersion 1": JSON.stringify({ ...m, formatVersion: 1 }),
    "minReaderVersion text": JSON.stringify({ ...m, minReaderVersion: "2" }),
    kind: JSON.stringify({ ...m, kind: "weekly" }),
    createdAt: JSON.stringify({ ...m, createdAt: "yesterday" }),
    "app.platform": JSON.stringify({ ...m, app: { ...m.app, platform: "web" } }),
    "app.build": JSON.stringify({ ...m, app: { ...m.app, build: 14 } }),
    "schema.applied 0": JSON.stringify({ ...m, schema: { ...m.schema, applied: 0 } }),
    "device.id": JSON.stringify({ ...m, device: { ...m.device, id: "not-a-uuid" } }),
    "device.model": JSON.stringify({ ...m, device: { ...m.device, model: "x".repeat(65) } }),
    "library.id": JSON.stringify({ ...m, library: {} }),
    "library.vector": JSON.stringify({ ...m, library: { ...m.library, vector: { a: 1.5 } } }),
    "table name": JSON.stringify({ ...m, tables: [{ ...table, name: "Drop Table" }] }),
    "table mode": JSON.stringify({ ...m, tables: [{ ...table, mode: "merge" }] }),
    "table file": JSON.stringify({ ...m, tables: [{ ...table, file: "../x.ndjson" }] }),
    "table rows": JSON.stringify({ ...m, tables: [{ ...table, rows: -1 }] }),
    "table sha256": JSON.stringify({ ...m, tables: [{ ...table, sha256: "A".repeat(64) }] }),
    "table columns": JSON.stringify({ ...m, tables: [{ ...table, columns: ["id", "id"] }] }),
    "table sequence": JSON.stringify({ ...m, tables: [{ ...table, sequence: "5" }] }),
    // A high-water mark no SQLite connection of the app can read exactly would stop the table's inserts for good.
    "table sequence 1e300": JSON.stringify({ ...m, tables: [{ ...table, sequence: 1e300 }] }),
    "table sequence 2^53": JSON.stringify({ ...m, tables: [{ ...table, sequence: 2 ** 53 }] }),
    "table sequence int64 max": JSON.stringify({
      ...m,
      tables: [{ ...table, sequence: 0 }],
    }).replace('"sequence":0', '"sequence":9223372036854775807'),
    "table sequence negative": JSON.stringify({ ...m, tables: [{ ...table, sequence: -1 }] }),
    "table rows 2^53": JSON.stringify({ ...m, tables: [{ ...table, rows: 2 ** 53 }] }),
    "library.seq 1e300": JSON.stringify({ ...m, library: { ...m.library, seq: 1e300 } }),
    "duplicate tables": JSON.stringify({ ...m, tables: [table, table] }),
    "media name": JSON.stringify({
      ...m,
      media: [
        {
          set: "progress-photos",
          name: "../x.jpg",
          bytes: 1,
          sha256: "c".repeat(64),
          embedded: true,
        },
      ],
    }),
    "media embedded": JSON.stringify({
      ...m,
      media: [
        {
          set: "progress-photos",
          name: "x.jpg",
          bytes: 1,
          sha256: "c".repeat(64),
          embedded: "yes",
        },
      ],
    }),
    "file path": JSON.stringify({
      ...m,
      files: [{ path: "/etc/x", role: "csv", sha256: "d", bytes: 1 }],
    }),
    "file role": JSON.stringify({
      ...m,
      files: [{ path: "x.txt", role: "data", sha256: "d", bytes: 1 }],
    }),
    "counts value": JSON.stringify({ ...m, counts: { a: { b: 1 } } }),
    provenance: JSON.stringify({ ...m, provenance: { health: "yes" } }),
    vaultColumns: JSON.stringify({ ...m, vaultColumns: [1] }),
    missingMedia: JSON.stringify({ ...m, missingMedia: ["x.jpg"] }),
    warnings: JSON.stringify({ ...m, warnings: [{ fatal: "no" }] }),
  };
  for (const [name, text] of Object.entries(cases))
    assert.equal(await failure(() => parseManifest(text, id)), "corrupt", name);
  assert.equal(
    (await vaultError(() => parseManifest(cases["table sequence 1e300"], id))).info.detail,
    "manifest:tables[0].sequence"
  );
  // The largest high-water mark expo-sqlite reads exactly is read, and so is none.
  for (const sequence of [Number.MAX_SAFE_INTEGER, 0, null])
    assert.equal(
      parseManifest(JSON.stringify({ ...m, tables: [{ ...table, sequence }] }), id).tables[0]
        .sequence,
      sequence
    );
});

test(
  "G4 manifest: tables and columns at the archive's level (rule 5)",
  { skip: vault.skip },
  async (t) => {
    const { w } = await open(t);
    const { columnPlan } = w.require("@/vault/engine/manifest");
    const { columnNames, tableExists } = w.require("@/vault/engine/db");
    const { vaultApp } = w.require("@/vault/app");
    const scratch = await w.migrate(w.open("scratch.db", { useNewConnection: true }));
    const names = vaultApp.tables.map((x) => x.name);
    const columnsAt = (table) => (tableExists(scratch, table) ? columnNames(scratch, table) : null);
    const plan = (manifest, tables = names) =>
      columnPlan(manifest, { tables, owned: ["sync_id"], columnsAt });
    const table = names[0];
    const real = columnNames(scratch, table);
    const withColumns = (columns, extra = {}) =>
      sampleManifest(w, {
        tables: [
          { ...sampleManifest(w).tables[0], name: table, file: `data/${table}.ndjson`, columns },
        ],
        ...extra,
      });
    assert.deepEqual(plan(withColumns(real)), [
      { table, columns: real, insert: real, owned: [], dropped: [] },
    ]);
    // sync_id is this reader's own vault column: inserted, and added to the scratch table first when missing.
    assert.deepEqual(
      plan(withColumns([...real, "sync_id"]))[0].owned,
      real.includes("sync_id") ? [] : ["sync_id"]
    );
    // A future vault-owned column the archive declares: dropped from every line, not unknownSchema.
    const future = plan(
      withColumns([...real, "future_id"], { vaultColumns: ["sync_id", "future_id"] })
    )[0];
    assert.deepEqual([future.insert, future.dropped], [real, ["future_id"]]);
    assert.equal(await failure(() => plan(withColumns([...real, "future_id"]))), "unknownSchema");
    assert.equal(await failure(() => plan(withColumns([...real, "mystery"]))), "unknownSchema");
    const ghost = sampleManifest(w, {
      tables: [{ ...sampleManifest(w).tables[0], name: "ghost", file: "data/ghost.ndjson" }],
    });
    assert.equal(await failure(() => plan(ghost)), "unknownSchema");
    assert.equal(await failure(() => plan(ghost, [...names, "ghost"])), "unknownSchema");
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G14 lock

test(
  "G14 lock: wait:false is busy while held, wait:true queues in order",
  { skip: vault.skip },
  async (t) => {
    const { w } = await open(t);
    const { exclusive, busyWith, subscribeLock } = w.require("@/vault/engine/lock");
    const changes = [];
    const unsubscribe = subscribeLock(() => changes.push(busyWith()));
    let open1;
    const gate = new Promise((resolve) => (open1 = resolve));
    const order = [];
    assert.equal(busyWith(), null);
    const first = exclusive(
      "export",
      async () => {
        order.push("export");
        await gate;
        return 1;
      },
      { wait: true }
    );
    assert.equal(busyWith(), "export");
    const busy = await vaultError(() =>
      exclusive("autoBackup", async () => order.push("autoBackup"), { wait: false })
    );
    assert.deepEqual([busy.code, busy.info.detail], ["busy", "export"]);
    const second = exclusive(
      "inspect",
      async () => {
        order.push(`inspect:${busyWith()}`);
        return 2;
      },
      { wait: true }
    );
    const third = exclusive(
      "restore",
      async () => {
        order.push("restore");
        throw new Error("boom");
      },
      { wait: true }
    );
    const fourth = exclusive(
      "recover",
      () => {
        order.push("recover");
        throw new Error("thrown before any await");
      },
      { wait: true }
    );
    // Queued, not started.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(order, ["export"]);
    open1();
    assert.equal(await first, 1);
    assert.equal(await second, 2);
    await assert.rejects(third, /boom/);
    await assert.rejects(fourth, /thrown before any await/);
    assert.deepEqual(order, ["export", "inspect:inspect", "restore", "recover"]);
    assert.equal(busyWith(), null);
    // Released before the promise settles: the next operation can start right away.
    assert.equal(await exclusive("selftest", async () => busyWith(), { wait: false }), "selftest");
    unsubscribe();
    assert.deepEqual(changes, ["export", "inspect", "restore", "recover", null, "selftest", null]);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G17 untrusted input

test(
  "G17 zip bomb: an entry inflating far past its declared size fails fast with bounded memory",
  { skip: vault.skip },
  async (t) => {
    const { w, File, put } = await open(t);
    const { ArchiveReader } = w.require("@/vault/engine/zip-read");
    const bomb = zeroBomb(1024); // ~1 MiB that inflates to 1 GiB
    assert.ok(bomb.length > MiB && bomb.length < 1.1 * MiB, `${bomb.length}`);
    for (const [label, size] of [
      ["lying size", 1000],
      ["honest size", 1024 * MiB],
    ]) {
      const reader = ArchiveReader.open(
        put(`${label}.zip`, zipBytes([{ name: "data/rows.ndjson", data: bomb, method: 8, size }]))
      );
      t.after(() => reader.close());
      const out = new File(w.uri("bomb", `${label}.ndjson`));
      const before = process.resourceUsage().maxRSS * KiB;
      const started = Date.now();
      assert.equal(
        await failure(() => reader.extract("data/rows.ndjson", out, 1000)),
        "corrupt",
        label
      );
      assert.equal(
        await failure(() => reader.readText("data/rows.ndjson", 4 * MiB)),
        "corrupt",
        label
      );
      const growth = process.resourceUsage().maxRSS * KiB - before;
      assert.ok(growth < 64 * MiB, `${label}: peak RSS grew by ${(growth / MiB).toFixed(1)} MiB`);
      assert.ok(Date.now() - started < 10_000, `${label}: stopped early`);
      assert.equal(out.exists, false);
    }
  }
);

test("G17 a 9 MiB NDJSON line without a newline is corrupt", { skip: vault.skip }, async (t) => {
  const { w, put } = await open(t);
  const { readLines, MAX_LINE } = w.require("@/vault/engine/rows");
  assert.equal(MAX_LINE, 8 * MiB);
  const file = put("long.ndjson", Buffer.alloc(9 * MiB, 0x61));
  let lines = 0;
  assert.equal(
    await failure(() => readLines(file, { maxLine: MAX_LINE }, () => lines++)),
    "corrupt"
  );
  assert.equal(lines, 0);
  const fine = put("fine.ndjson", `${"a".repeat(MiB)}\n`);
  assert.equal(await readLines(fine, { maxLine: MAX_LINE }, () => lines++), 1);
});

test(
  "G17 crafted offsets and ratios fail when the archive is opened",
  { skip: vault.skip },
  async (t) => {
    const { w, put } = await open(t);
    const { ArchiveReader } = w.require("@/vault/engine/zip-read");
    const opens = (name, content) => failure(() => ArchiveReader.open(put(name, content)).close());
    const data = zlib.deflateRawSync(Buffer.alloc(10_000));
    const entry = { name: "data/a.ndjson", data, method: 8, size: 10_000 };
    assert.equal(await opens("ok.zip", zipBytes([entry])), null);
    // The entry's data would run into the central directory.
    assert.equal(
      await opens("overlap.zip", zipBytes([{ ...entry, compressedSize: data.length + 64 }])),
      "corrupt"
    );
    assert.equal(await opens("offset.zip", zipBytes([{ ...entry, offset: 40 }])), "corrupt");
    // More than DEFLATE can ever expand (1100:1 plus slack).
    assert.equal(
      await opens("ratio.zip", zipBytes([{ ...entry, size: data.length * 1100 + 1025 }])),
      "corrupt"
    );
    assert.equal(
      await opens("ratio-ok.zip", zipBytes([{ ...entry, size: data.length * 1100 + 1024 }])),
      null
    );
    // The directory itself outside the file, or above 16 MiB.
    assert.equal(
      await opens("cd.zip", zipBytes([entry], { directoryOffset: 5_000_000 })),
      "corrupt"
    );
  }
);

// ---------------------------------------------------------------------------------------------------------------
// The smaller engine modules

test(
  "engine db: schema level, introspection and the validator helpers",
  { skip: vault.skip },
  async (t) => {
    const { w } = await open(t);
    const db = w.require("@/vault/engine/db");
    const { vaultApp } = w.require("@/vault/app");
    const journal = vaultApp.migrations.journal;
    const entries = journal.entries;
    const live = await w.live();
    assert.deepEqual(db.schemaState(live, journal), {
      applied: entries.length,
      pending: 0,
      lastCreatedAt: entries[entries.length - 1].when,
      lastTag: entries[entries.length - 1].tag,
    });
    const first = await w.migrate(w.open("level1.db", { useNewConnection: true }), 1);
    assert.deepEqual(db.schemaState(first, journal), {
      applied: 1,
      pending: entries.length - 1,
      lastCreatedAt: entries[0].when,
      lastTag: entries[0].tag,
    });
    const blank = w.open("blank.db", { useNewConnection: true });
    assert.deepEqual(db.schemaState(blank, journal), {
      applied: 0,
      pending: entries.length,
      lastCreatedAt: 0,
      lastTag: "",
    });
    for (const table of vaultApp.tables) {
      assert.ok(db.tableExists(live, table.name), table.name);
      assert.ok(db.isRowidTable(live, table.name), `${table.name} has a rowid`);
      assert.deepEqual(
        db.columnNames(live, table.name),
        live.getAllSync(`PRAGMA table_info("${table.name}")`).map((c) => c.name)
      );
    }
    assert.equal(db.tableExists(live, "nope"), false);
    assert.deepEqual(db.tableColumns(live, "nope"), []);

    blank.execSync(
      "CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, j TEXT, k VARCHAR(5) NOT NULL DEFAULT 'x', d DOUBLE, f FLOATING POINT, g FLOAT, n DECIMAL(10,2), u, bl BLOB);" +
        'CREATE TABLE w (k TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TABLE "we""ird" (v);'
    );
    assert.deepEqual(
      db
        .tableColumns(blank, "a")
        .map((c) => [c.name, db.affinity(c.type), c.notnull, c.defaultSql, c.pk]),
      [
        ["id", "INTEGER", false, null, 1],
        ["j", "TEXT", false, null, 0],
        ["k", "TEXT", true, "'x'", 0],
        ["d", "REAL", false, null, 0],
        // "POINT" contains "INT": SQLite's own rule, in its order.
        ["f", "INTEGER", false, null, 0],
        ["g", "REAL", false, null, 0],
        ["n", "NUMERIC", false, null, 0],
        ["u", "BLOB", false, null, 0],
        ["bl", "BLOB", false, null, 0],
      ]
    );
    assert.equal(db.isRowidTable(blank, "w"), false);
    assert.equal(db.isAutoincrement(blank, "a"), true);
    assert.equal(db.isAutoincrement(blank, "w"), false);
    assert.equal(db.sequenceOf(blank, "a"), null);
    blank.execSync("INSERT INTO a (id, k) VALUES (41, 'y'); DELETE FROM a");
    assert.equal(db.sequenceOf(blank, "a"), 41);
    assert.equal(db.q('we"ird'), '"we""ird"');
    assert.equal(db.tableExists(blank, 'we"ird'), true);
    assert.equal(db.literal("it's"), "'it''s'");

    blank.execSync(
      "INSERT INTO a (j, k) VALUES ('{\"a\":1}', 'kg'), ('[1]', 'lb'), ('nope', 'st'), (NULL, 'kg')"
    );
    // NULL is neither valid nor invalid JSON: a nullable column's own NULL guard decides.
    assert.equal(db.countWhere(blank, "a", db.jsonObject("j")), 2);
    assert.equal(db.countWhere(blank, "a", db.jsonArray("j")), 2);
    assert.equal(db.countWhere(blank, "a", `j IS NULL OR ${db.jsonObject("j")}`), 3);
    assert.equal(db.countWhere(blank, "a", db.notIn("k", ["kg", "lb"])), 1);
    assert.equal(db.countWhere(blank, "a", db.notIn("k", ["it's"])), 4);
    assert.equal(db.countWhere(blank, "a", "k = ?", ["kg"]), 2);
  }
);

test(
  "engine state: _vault_state values, query values and the mirror",
  { skip: vault.skip },
  async (t) => {
    const { w } = await open(t);
    const state = w.require("@/vault/engine/state");
    const db = w.open("state.db", { useNewConnection: true });
    assert.equal(state.readState(db, "device.id"), null);
    assert.deepEqual(state.readStates(db), {});
    state.deleteStateSync(db, "device.id");
    let notified = 0;
    const unsubscribe = state.subscribeVaultState(() => notified++);
    const mirror = state.vaultState();
    state.refreshVaultState(db);
    assert.equal(notified, 0);
    assert.equal(state.vaultState(), mirror);

    state.updateState(db, {
      "device.id": "d1",
      "library.id": "l1",
      "cloud.icloud.lastOkAt": "x",
      "cloud.gdrive.lastOkAt": "y",
    });
    assert.equal(notified, 1);
    assert.equal(state.vaultState()["library.id"], "l1");
    assert.deepEqual(state.readStates(db, "cloud."), {
      "cloud.gdrive.lastOkAt": "y",
      "cloud.icloud.lastOkAt": "x",
    });
    state.setStateSync(db, "lineage.ownBase", { sql: "SELECT 40 + ?", params: [2] });
    assert.equal(state.readState(db, "lineage.ownBase"), "42");
    assert.equal(notified, 1, "single writes leave the mirror until refreshVaultState");
    state.deleteStatePrefixSync(db, "cloud.icloud.");
    assert.deepEqual(Object.keys(state.readStates(db, "cloud.")), ["cloud.gdrive.lastOkAt"]);
    assert.throws(() => state.deleteStatePrefixSync(db, ""));
    state.updateState(db, { "device.id": null, "library.id": "l1" });
    assert.equal(state.readState(db, "device.id"), null);
    assert.equal(notified, 2);
    state.refreshVaultState(db);
    assert.equal(notified, 2, "no change, no notification");

    // Inside a caller's transaction: rolled back with it.
    db.execSync("BEGIN");
    state.setStateSync(db, "restore.lastOp", "op");
    db.execSync("ROLLBACK");
    assert.equal(state.readState(db, "restore.lastOp"), null);
    // updateState runs its own transaction: inside a caller's it fails and leaves the caller's open and intact.
    db.execSync("BEGIN");
    state.setStateSync(db, "restore.lastOp", "kept");
    assert.throws(() => state.updateState(db, { "restore.lastOp": "other" }));
    assert.equal(db.isInTransactionSync(), true);
    assert.equal(state.readState(db, "restore.lastOp"), "kept");
    db.execSync("ROLLBACK");
    assert.equal(state.readState(db, "restore.lastOp"), null);
    assert.equal(
      db.getFirstSync("SELECT wr FROM pragma_table_list WHERE name = '_vault_state'").wr,
      1
    );
    unsubscribe();
    state.updateState(db, { x: "1" });
    assert.equal(notified, 2);
  }
);

test(
  "engine paths: layout, ids, live operations and leftovers",
  { skip: vault.skip },
  async (t) => {
    const { w, Directory, File, Paths } = await open(t);
    const paths = w.require("@/vault/engine/paths");
    assert.equal(paths.vaultDir().uri, new Directory(Paths.document, "PendumVault").uri);
    assert.equal(paths.journalFile().uri, w.uri("PendumVault", "journal.json"));
    assert.equal(paths.anchorFile().uri, w.uri("PendumVault", "device.json"));
    assert.equal(paths.mediaDir("progress-photos").uri, `${w.uri("progress-photos")}/`);
    assert.ok(paths.exportDir().uri.startsWith(Paths.cache.uri));
    assert.equal(paths.fsPath(new File(w.uri("a b", "c%d.db"))), w.file("a b", "c%d.db"));
    assert.equal(paths.utcStamp(new Date("2026-10-04T15:30:12.345Z")), "20261004T153012Z");
    assert.match(paths.randomTag(), /^[a-z0-9]{4}$/);
    // Manual export names use local time (spec §2.2), with the app's file stem and extension.
    const { vaultIdentity } = w.require("@/vault/app");
    assert.equal(
      paths.manualArchiveName(vaultIdentity, new Date(2026, 9, 4, 5, 3, 9)),
      `${vaultIdentity.fileStem}-2026-10-04-050309.${vaultIdentity.extension}`
    );
    assert.match(
      paths.manualArchiveName({ fileStem: "PendumLift", extension: "pendumlift" }),
      /^PendumLift-\d{4}-\d{2}-\d{2}-\d{6}\.pendumlift$/
    );
    const recoveryId = "20261004T153012Z-q8w2";
    assert.equal(
      paths.recoveryArchiveFile(recoveryId, "pendummacros").uri,
      w.uri("PendumVault", "recovery", recoveryId, "data.pendummacros")
    );
    assert.equal(
      paths.recoveryArchiveFile(recoveryId, "pendummacros", true).uri,
      w.uri("PendumVault", "recovery", `${recoveryId}.partial`, "data.pendummacros")
    );

    const op = paths.newOpId(new Date("2026-10-04T15:30:12Z"));
    assert.match(op, /^20261004T153012Z-[a-z0-9]{4}$/);
    assert.ok(paths.isLiveOp(op) && paths.liveOps().includes(op));
    assert.equal(paths.workDir(op).uri, `${w.uri("PendumVault", "work", op)}/`);
    assert.throws(() => paths.workDir("../x"));
    assert.throws(() => paths.recoveryDir("legacy"));

    // Leftovers of earlier runs; live operations, journal-named ones, complete sets and the anchor stay.
    const done = paths.newOpId();
    paths.endOp(done);
    assert.equal(paths.isLiveOp(done), false);
    const named = paths.newVaultId();
    const set = paths.newVaultId();
    const stale = paths.newVaultId();
    for (const dir of [
      paths.workDir(op),
      paths.workDir(done),
      paths.workDir(named),
      paths.recoveryDir(set),
      paths.recoveryPartialDir(stale),
      paths.recoveryPartialDir(named),
    ])
      paths.ensureDir(dir);
    fs.writeFileSync(w.file("PendumVault", "work", "stray.tmp"), "x");
    fs.writeFileSync(w.file("PendumVault", "device.json"), "{}");
    paths.ensureDir(paths.exportDir());
    const old = path.join(paths.fsPath(paths.exportDir()), "old.pendumlift");
    const recent = path.join(paths.fsPath(paths.exportDir()), "recent.pendumlift");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(recent, "x");
    const day = 24 * 60 * 60;
    fs.utimesSync(old, Date.now() / 1000 - day - 60, Date.now() / 1000 - day - 60);
    paths.removeLeftovers({ ops: [named], recoveries: [named] });
    const listed = (dir) => fs.readdirSync(paths.fsPath(dir)).sort();
    assert.deepEqual(listed(paths.workRoot()), [op, named].sort());
    assert.deepEqual(listed(paths.recoveryRoot()), [set, `${named}.partial`].sort());
    assert.deepEqual(listed(paths.exportDir()), ["recent.pendumlift"]);
    assert.ok(fs.existsSync(w.file("PendumVault", "device.json")));
    paths.endOp(op);

    // The self-test and tests replace the documents folder.
    fs.mkdirSync(w.file("elsewhere"));
    paths.setEngineEnv({ documentRoot: new Directory(w.uri("elsewhere")) });
    assert.equal(paths.vaultDir().uri, `${w.uri("elsewhere", "PendumVault")}/`);
    assert.equal(typeof paths.engineEnv().acquire, "function");
    paths.setEngineEnv(null);
    assert.equal(paths.vaultDir().uri, new Directory(Paths.document, "PendumVault").uri);
  }
);

test("engine csv: quoting, formula neutralising, CRLF, BOM", { skip: vault.skip }, async (t) => {
  const { w } = await open(t);
  const { csvLine, csvFile, stripBom, CSV_BOM } = w.require("@/vault/engine/csv");
  assert.equal(
    csvLine([
      "a",
      'say "hi"',
      null,
      5,
      -2.5,
      "=1+1",
      " @SUM(A1)",
      "-x",
      "+x",
      "a,b",
      "line\nbreak",
    ]),
    '"a","say ""hi""","","5","-2.5","\'=1+1","\' @SUM(A1)","\'-x","\'+x","a,b","line\nbreak"'
  );
  assert.equal(
    csvFile([
      ["h1", "h2"],
      [1, null],
    ]),
    '"h1","h2"\r\n"1",""\r\n'
  );
  assert.equal(csvFile([]), "");
  assert.equal(CSV_BOM, "\uFEFF");
  assert.equal(stripBom(`${CSV_BOM}a`), "a");
  assert.equal(stripBom("a"), "a");
});

test(
  "engine provenance: the merge SQL applies rules B, A, C, R and D; the installation rule",
  { skip: vault.skip },
  async (t) => {
    const { w } = await open(t);
    const { provenanceSwap, installationOverrides } = w.require("@/vault/engine/provenance");
    const { vaultApp } = w.require("@/vault/app");
    const ctx = (extra) => ({
      reason: "file",
      legacy: false,
      crossPlatform: false,
      sameDevice: false,
      healthWasOn: false,
      platform: "ios",
      now: new Date("2026-10-04T12:00:00Z"),
      live: { installation: "live-1", healthInstallations: ["old-0"] },
      incoming: { installation: "arch-1", healthInstallations: ["arch-0"] },
      freshInstallation: "fresh-1",
      ...extra,
    });
    const values = (sql) => sql.map((s) => s.params);
    assert.deepEqual(values(installationOverrides(ctx({ sameDevice: true }))), [
      ["installation", "arch-1"],
      ["healthInstallations", '["arch-0","arch-1","live-1","old-0"]'],
    ]);
    assert.deepEqual(
      values(
        installationOverrides(
          ctx({ sameDevice: true, incoming: { installation: null, healthInstallations: [] } })
        )
      ),
      [
        ["installation", "live-1"],
        ["healthInstallations", '["live-1","old-0"]'],
      ]
    );
    assert.deepEqual(values(installationOverrides(ctx({}))), [
      ["installation", "fresh-1"],
      ["healthInstallations", '["arch-0","arch-1","live-1","old-0"]'],
    ]);
    // Another device, platform or a handoff with an archive that names no installation (made before its device
    // first synced with Health): its own-app lineage is unknown, as a v1 file's (vault 1.0.3). The same device keeps
    // its lineage without "*" (above).
    const unnamed = { installation: null, healthInstallations: ["arch-0"] };
    for (const extra of [{}, { crossPlatform: true }, { reason: "handoff" }])
      assert.deepEqual(values(installationOverrides(ctx({ ...extra, incoming: unnamed }))), [
        ["installation", "fresh-1"],
        ["healthInstallations", '["*","arch-0","live-1","old-0"]'],
      ]);
    assert.deepEqual(
      values(
        installationOverrides(
          ctx({ legacy: true, incoming: { installation: null, healthInstallations: [] } })
        )
      ),
      [
        ["installation", "live-1"],
        ["healthInstallations", '["*","live-1","old-0"]'],
      ]
    );
    assert.deepEqual(
      installationOverrides(
        ctx({
          legacy: true,
          live: { installation: null, healthInstallations: [] },
          incoming: { installation: null, healthInstallations: [] },
        })
      ),
      [{ sql: installationOverrides(ctx({}))[0].sql, params: ["healthInstallations", '["*"]'] }]
    );
    if (!vaultApp.health) return; // water keeps no Health links

    const live = await w.live();
    w.seed(live);
    const weights = vaultApp.health.rowTables.weight;
    const ids = live.getAllSync(`SELECT id FROM "${weights}" ORDER BY id LIMIT 3`).map((r) => r.id);
    assert.equal(ids.length, 3, "the fixture seeds weights");
    const gone = 1_000_000;
    const incoming = await w.migrate(w.open("incoming.db", { useNewConnection: true }));
    incoming.closeSync();
    const link = (key, kind, id, remote, fingerprint, origin) => [
      key,
      kind,
      id,
      remote,
      fingerprint,
      origin,
    ];
    const insert = (db, schema, rows) => {
      for (const row of rows)
        db.runSync(
          `INSERT INTO ${schema}.health_links (key, local_kind, local_id, remote_id, fingerprint, origin) VALUES (?, ?, ?, ?, ?, ?)`,
          row
        );
    };
    /** The merge of `liveRows` and `incomingRows` as the swap runs it, for `context`; the links after it, by key. */
    const merge = (liveRows, incomingRows, context) => {
      const fk = live.getFirstSync("PRAGMA foreign_keys").foreign_keys;
      live.execSync("PRAGMA foreign_keys = OFF");
      live.runSync("ATTACH DATABASE ? AS incoming", [w.file("SQLite", "incoming.db")]);
      try {
        live.execSync("DELETE FROM main.health_links; DELETE FROM incoming.health_links");
        insert(live, "main", liveRows);
        insert(live, "incoming", incomingRows);
        const { before, after } = provenanceSwap(vaultApp.health, context);
        live.execSync("BEGIN IMMEDIATE");
        for (const s of before) live.runSync(s.sql, s.params ?? []);
        live.execSync("DELETE FROM main.health_links");
        live.execSync("INSERT INTO main.health_links SELECT * FROM incoming.health_links");
        for (const s of after) live.runSync(s.sql, s.params ?? []);
        live.execSync("DROP TABLE IF EXISTS temp._vault_live_links");
        live.execSync("COMMIT");
      } finally {
        live.execSync("DETACH DATABASE incoming");
        live.execSync(`PRAGMA foreign_keys = ${fk ? "ON" : "OFF"}`);
      }
      return Object.fromEntries(
        live
          .getAllSync("SELECT key, local_id, remote_id, fingerprint, origin FROM health_links")
          .map((r) => [r.key, [r.local_id, r.remote_id, r.fingerprint, r.origin]])
      );
    };
    const rows = merge(
      [
        link("k-both", "weight", ids[0], "r-live", "fp-live", "local"),
        link("k-live-only", "weight", ids[1], "r-only", "fp-only", "local"),
        link("k-live-other", "weight", ids[2], "r-other", "fp-other", "local"),
        link("k-same-remote", "weight", gone, "r-shared", "fp", "local"),
        link("k-tombstone", "weight", gone, "r-deleted", "deleted", "local"),
        link("k-tomb-covered", "weight", ids[2], "r-tomb-covered", "deleted", "local"),
        link("k-tomb-same-remote", "weight", -1, "r-arch-3", "deleted", "local"),
        link("k-tomb-key", "weight", -1, "r-tomb-key", "deleted", "local"),
        link("k-cross", "weight", gone + 1, "", "fp", "local"),
        link("k-import-gone", "weight", gone + 2, "r-import", "fp", "health"),
        link("k-import-kept", "weight", ids[1], "r-import-2", "fp", "health"),
      ],
      [
        link("k-both", "weight", ids[0], "", "", "local"),
        link("k-arch-2", "weight", ids[2], "r-arch-2", "fp-arch", "local"),
        link("k-arch-shared", "weight", gone + 5, "r-shared", "fp", "local"),
        link("k-arch-reset", "weight", gone + 6, "", "", "local"),
        link("k-arch-3", "weight", gone + 7, "r-arch-3", "fp-arch-3", "local"),
        link("k-tomb-key", "weight", gone + 8, "r-old", "fp-old", "local"),
        link("k-arch-import", "weight", gone + 9, "r-arch-3", "fp-import", "health"),
      ],
      ctx({})
    );
    assert.deepEqual(rows, {
      // B: the live remote id and fingerprint describe this store now; a live tombstone makes the archive's link one.
      "k-both": [ids[0], "r-live", "fp-live", "local"],
      "k-tomb-key": [gone + 8, "r-tomb-key", "deleted", "local"],
      // A: no archive link for that record → verbatim; another key for the same record → -1.
      "k-live-only": [ids[1], "r-only", "fp-only", "local"],
      "k-live-other": [-1, "r-other", "fp-other", "local"],
      // A: an empty archive remote id (a cross-platform reset) never blocks a live link.
      "k-cross": [gone + 1, "", "fp", "local"],
      // A: live tombstones are carried by the same rule, also when an archive link holds their remote id.
      "k-tombstone": [gone, "r-deleted", "deleted", "local"],
      "k-tomb-covered": [-1, "r-tomb-covered", "deleted", "local"],
      "k-tomb-same-remote": [-1, "r-arch-3", "deleted", "local"],
      // C: an import whose row was deleted stays deleted.
      "k-import-gone": [-1, "r-import", "fp", "health"],
      "k-arch-2": [ids[2], "r-arch-2", "fp-arch", "local"],
      "k-arch-shared": [gone + 5, "r-shared", "fp", "local"],
      "k-arch-reset": [gone + 6, "", "", "local"],
      // D: an archive link to a sample this store deleted (a tombstone holds its remote id) is written again; an
      // import of that sample is never exported.
      "k-arch-3": [gone + 7, "r-arch-3", "", "local"],
      "k-arch-import": [gone + 9, "r-arch-3", "fp-import", "health"],
    });

    // R: on a restore that keeps a known installation (here the same device's archive, installation arch-1), a link
    // parked at -1 under that installation whose key names an id no link holds takes that id (one link per id; with
    // no row at that id the sync removes the sample as before); other installations' keys and ids a link holds stay
    // parked.
    const own = (installation, rest) => `${vaultApp.health.clientPrefix}:${installation}:${rest}`;
    const parked = merge(
      [
        link(own("arch-1", `weight:${ids[0]}`), "weight", -1, "r-p0", "fp-p0", "local"),
        link(own("arch-1", `weight:${ids[1]}`), "weight", -1, "r-p1", "fp-p1", "local"),
        link(
          own("arch-1", `restored-7:weight:${ids[1]}`),
          "weight",
          -1,
          "r-p1e",
          "deleted",
          "local"
        ),
        link(own("arch-1", `weight:${ids[2]}`), "weight", -1, "r-p2", "deleted", "local"),
        link(own("arch-1", `weight:${gone}`), "weight", -1, "r-pg", "fp-pg", "local"),
        link(own("live-1", `weight:${ids[2]}`), "weight", -1, "r-l2", "fp-l2", "local"),
      ],
      [link("k-arch-0", "weight", ids[0], "r-a0", "fp-a0", "local")],
      ctx({ sameDevice: true })
    );
    assert.deepEqual(parked, {
      "k-arch-0": [ids[0], "r-a0", "fp-a0", "local"],
      [own("arch-1", `weight:${ids[0]}`)]: [-1, "r-p0", "fp-p0", "local"],
      [own("arch-1", `restored-7:weight:${ids[1]}`)]: [ids[1], "r-p1e", "deleted", "local"],
      [own("arch-1", `weight:${ids[1]}`)]: [-1, "r-p1", "fp-p1", "local"],
      [own("arch-1", `weight:${ids[2]}`)]: [ids[2], "r-p2", "deleted", "local"],
      [own("arch-1", `weight:${gone}`)]: [gone, "r-pg", "fp-pg", "local"],
      [own("live-1", `weight:${ids[2]}`)]: [-1, "r-l2", "fp-l2", "local"],
    });
    // Another device's restore mints a fresh installation, which no key carries yet: nothing moves.
    const fresh = merge(
      [link(own("arch-1", `weight:${ids[1]}`), "weight", -1, "r-p1", "fp-p1", "local")],
      [],
      ctx({})
    );
    assert.deepEqual(fresh[own("arch-1", `weight:${ids[1]}`)], [-1, "r-p1", "fp-p1", "local"]);
    // A scoped (legacy) merge only snapshots links inside the scope.
    const scoped = provenanceSwap(vaultApp.health, ctx({ legacy: true }), "local_kind = 'weight'");
    assert.match(scoped.before[1].sql, /WHERE \(local_kind = 'weight'\)$/);
    assert.match(scoped.after[1].sql, /AND \(local_kind = 'weight'\)\)/);
    // …and parks, moves and resets only links inside it (R, D); R names the live installation a v1 file keeps.
    assert.equal(scoped.after.length, 5);
    assert.match(scoped.after[3].sql, /l\."local_id" = -1 AND \(local_kind = 'weight'\)/);
    assert.deepEqual(scoped.after[3].params, [own("live-1", ""), own("live-1", "")]);
    assert.match(scoped.after[4].sql, /h\."origin" = 'local' AND \(local_kind = 'weight'\)/);
    // Without any installation to keep (a v1 file on a phone that never synced), there is no R.
    const none = { installation: null, healthInstallations: [] };
    const bare = provenanceSwap(vaultApp.health, ctx({ legacy: true, live: none, incoming: none }));
    assert.equal(bare.after.length, 4);
  }
);

test(
  "engine source: asChangeSource sets and clears the clock's source",
  { skip: vault.skip },
  async (t) => {
    const { w } = await open(t);
    const { asChangeSource } = w.require("@/vault/engine/source");
    const db = w.open("clock.db", { useNewConnection: true });
    const exec = (sql) => db.execSync(sql);
    assert.equal(
      asChangeSource("health", exec, () => 7),
      7,
      "no clock table: a no-op"
    );
    db.execSync(
      'CREATE TABLE "_vault_clock" ("id" INTEGER PRIMARY KEY, "source" TEXT); INSERT INTO "_vault_clock" ("id") VALUES (1)'
    );
    const source = () => db.getFirstSync('SELECT "source" AS s FROM "_vault_clock"').s;
    assert.equal(asChangeSource("auto", exec, source), "auto");
    assert.equal(source(), null);
    assert.throws(() =>
      asChangeSource("health", exec, () => {
        assert.equal(source(), "health");
        throw new Error("import failed");
      })
    );
    assert.equal(source(), null);
  }
);
