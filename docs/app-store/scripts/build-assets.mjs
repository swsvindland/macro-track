import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.resolve(root, "../..");
const font = path.join(project, "assets/fonts/Inter.ttf");
// Keep font discovery and caches portable, including in a sandboxed environment.
const fontCache = await fs.mkdtemp(path.join(os.tmpdir(), "vector-store-fonts-"));
const fontConfig = path.join(fontCache, "fonts.conf");
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
await fs.writeFile(
  fontConfig,
  `<fontconfig><dir>${xml(path.dirname(font))}</dir><cachedir>${xml(fontCache)}</cachedir></fontconfig>`
);
process.env.FONTCONFIG_FILE = fontConfig;
const listing = JSON.parse(await fs.readFile(path.join(root, "listing.json"), "utf8"));
const fields = { name: 30, subtitle: 30, promotionalText: 170, keywords: 100, description: 4000 };
const names = {
  promotionalText: "promotional_text",
  name: "name",
  subtitle: "subtitle",
  keywords: "keywords",
  description: "description",
};
await fs.mkdir(path.join(root, "metadata/en-US"), { recursive: true });
const validation = {};
for (const [key, limit] of Object.entries(fields)) {
  const length = [...listing[key]].length;
  if (length > limit) throw Error(`${key}: ${length}/${limit}`);
  validation[key] = { length, limit };
  await fs.writeFile(path.join(root, "metadata/en-US", `${names[key]}.txt`), listing[key] + "\n");
}
const panels = [
  {
    slug: "01-weight-trends",
    raw: "overview-dark.png",
    bg: "#22d3ee",
    ink: "#071017",
    muted: "#164351",
    label: "SEE THE DIRECTION",
    lines: ["Small steps.", "A clearer picture."],
    sub: "Follow your weight trend over 90 days.",
    foot: "Actual app screens · Fictional sample data",
  },
  {
    slug: "02-measurements",
    raw: "body-dark.png",
    bg: "#071017",
    ink: "#f3f6f7",
    muted: "#a9bdc7",
    label: "BEYOND THE SCALE",
    lines: ["Measure what", "matters to you."],
    sub: "Waist, shoulders, chest and more. All in one log.",
    foot: "16 optional body measurements",
  },
  {
    slug: "03-your-units",
    raw: "overview-light-imperial.png",
    bg: "#edf4f6",
    ink: "#071017",
    muted: "#425863",
    label: "YOUR NUMBERS. YOUR WAY.",
    lines: ["A familiar unit.", "A fresh perspective."],
    sub: "Choose kilograms, pounds or decimal stone.",
    foot: "Light, dark and system appearance",
  },
  {
    slug: "04-personal-settings",
    raw: "settings-dark.png",
    bg: "#0d2631",
    ink: "#f3f6f7",
    muted: "#adc7d1",
    label: "MADE TO FIT YOU",
    lines: ["Your language.", "Your look."],
    sub: "11 languages. Flexible units. Light and dark.",
    foot: "Personalize your everyday record",
  },
  {
    slug: "05-health",
    raw: "health-dark.png",
    bg: "#22d3ee",
    ink: "#071017",
    muted: "#164351",
    label: "CONNECTED. BY CHOICE.",
    lines: ["Works with", "Apple Health."],
    sub: "Optional sync for your supported measurements.",
    foot: "Your photos and calculated estimates stay in the app",
  },
];
if (await fs.stat(path.join(root, "screenshots/raw/photos-dark.png")).catch(() => null))
  panels.splice(2, 0, {
    slug: "03-progress-photos",
    raw: "photos-dark.png",
    bg: "#071017",
    ink: "#f3f6f7",
    muted: "#a9bdc7",
    label: "YOUR VISUAL RECORD",
    lines: ["Your progress.", "In perspective."],
    sub: "A 90-day example. Three angles. One private record.",
    foot: "Fictional example · Results vary",
  });
for (const [index, panel] of panels.entries()) {
  panel.slug = `${String(index + 1).padStart(2, "0")}-${panel.slug.replace(/^\d+-/, "")}`;
}
const acceptedSizes = new Set([
  "1260x2736",
  "2736x1260",
  "1320x2868",
  "2868x1320",
  "1290x2796",
  "2796x1290",
]);
const previous = JSON.parse(
  await fs.readFile(path.join(root, "validation.json"), "utf8").catch(() => '{"screenshots":[]}')
);
const out = path.join(root, "screenshots/iphone-6.9");
await fs.mkdir(out, { recursive: true });
const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
async function label(text, size, color, weight = "normal") {
  return sharp({
    text: {
      text: `<span foreground="${color}" weight="${weight}">${escape(text)}</span>`,
      font: `Inter ${size}`,
      fontfile: font,
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer();
}
const thumbs = [];
for (const [i, p] of panels.entries()) {
  const ticks = Array.from(
    { length: 34 },
    (_, j) => `<path d="M${j * 40} 0v${j % 5 === 0 ? 38 : 18}"/>`
  ).join("");
  const isPhoto = p.raw === "photos-dark.png";
  const base = Buffer.from(
    `<svg width="1320" height="2868" xmlns="http://www.w3.org/2000/svg"><rect width="1320" height="2868" fill="${p.bg}"/><g stroke="${p.ink}" stroke-width="2" opacity=".16">${ticks}</g><path d="M80 545H1240" stroke="${p.ink}" opacity=".17"/><rect x="164" y="607" width="992" height="2120" rx="91" fill="#000" opacity=".10"/><rect x="172" y="597" width="976" height="2102" rx="86" fill="#34434c"/></svg>`
  );
  const imageWidth = isPhoto ? 1140 : 960,
    imageHeight = isPhoto ? 1831 : 2086;
  let source = sharp(path.join(root, "screenshots/raw", p.raw));
  if (isPhoto) source = source.extract({ left: 0, top: 480, width: 1320, height: 2120 });
  const screen = await source
    .resize(imageWidth, imageHeight, { fit: "fill" })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${imageWidth}" height="${imageHeight}"><rect width="${imageWidth}" height="${imageHeight}" rx="${isPhoto ? 20 : 78}" fill="white"/></svg>`
        ),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
  const layers = [];
  if (isPhoto)
    layers.push({
      input: Buffer.from(
        `<svg width="1320" height="2170"><rect width="1320" height="2170" fill="${p.bg}"/><rect x="82" y="180" width="1156" height="1847" rx="26" fill="#34434c"/></svg>`
      ),
      left: 0,
      top: 560,
    });
  layers.push({ input: screen, left: isPhoto ? 90 : 180, top: isPhoto ? 748 : 605 });
  if (isPhoto)
    layers.push({
      input: await label("JUNE 13 — SEPTEMBER 11, 2026", 28, p.muted),
      left: 90,
      top: 640,
    });
  for (const [text, size, color, x, y, weight] of [
    ["VECTOR BODY", 28, p.ink, 80, 83, "bold"],
    [
      `${String(i + 1).padStart(2, "0")} / ${String(panels.length).padStart(2, "0")}`,
      24,
      p.muted,
      1145,
      86,
    ],
    [p.label, 24, p.muted, 80, 175, "bold"],
    [p.lines[0], 104, p.ink, 74, 236, "bold"],
    [p.lines[1], 104, p.ink, 74, 350, "bold"],
    [p.sub, 33, p.muted, 80, 480],
    [p.foot, 27, p.muted, 80, 2770],
  ])
    layers.push({ input: await label(text, size, color, weight), left: x, top: y });
  const dest = path.join(out, p.slug + ".png");
  await sharp(base)
    .composite(layers)
    .flatten({ background: p.bg })
    .removeAlpha()
    .png()
    .toFile(dest);
  const meta = await sharp(dest).metadata();
  if (
    !acceptedSizes.has(`${meta.width}x${meta.height}`) ||
    meta.width !== 1320 ||
    meta.height !== 2868 ||
    meta.hasAlpha ||
    meta.format !== "png" ||
    meta.space !== "srgb" ||
    meta.channels !== 3
  )
    throw Error("Invalid output " + dest);
  thumbs.push({
    input: await sharp(dest).resize(330, 717).png().toBuffer(),
    left: i * 350,
    top: 0,
  });
}
// Remove only obsolete outputs listed by this renderer's previous manifest.
for (const entry of previous.screenshots) {
  if (path.basename(entry.file) !== entry.file) throw Error("Invalid previous output filename");
  if (!panels.some((p) => p.slug + ".png" === entry.file))
    await fs.rm(path.join(out, entry.file), { force: true });
}
for (const filename of await fs.readdir(out)) {
  if (!panels.some((p) => p.slug + ".png" === filename))
    throw Error("Unexpected file in upload folder: " + filename);
}
await sharp({
  create: { width: panels.length * 350 - 20, height: 717, channels: 3, background: "#dce5e9" },
})
  .composite(thumbs)
  .png()
  .toFile(path.join(root, "screenshots/contact-sheet.png"));
await fs.writeFile(
  path.join(root, "validation.json"),
  JSON.stringify(
    {
      metadata: validation,
      screenshots: panels.map((p) => ({
        file: p.slug + ".png",
        width: 1320,
        height: 2868,
        alpha: false,
        format: "png",
        colorSpace: "srgb",
        channels: 3,
        acceptedDimensions: true,
        source: p.raw,
      })),
      photosIncluded: panels.some((p) => p.raw === "photos-dark.png"),
    },
    null,
    2
  ) + "\n"
);
await fs.copyFile(
  path.join(project, "assets/images/icon.png"),
  path.join(root, "app-icon-1024.png")
);
console.log(`Validated metadata and rendered ${panels.length} opaque 1320 × 2868 screenshots.`);

await fs.rm(fontCache, { recursive: true, force: true });
