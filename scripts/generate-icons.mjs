import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("assets/branding/ruler.svg", root), "utf8");
const blue = "#22d3ee";
const dark = "#071017";

async function render(name, { color = "#000000", background, size = 1024, scale = 1 } = {}) {
  const artwork = source.replaceAll("#000000", color);
  const foreground = await sharp(Buffer.from(artwork))
    .resize(Math.round(size * scale))
    .png()
    .toBuffer();
  let output = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: foreground, gravity: "centre" }]);
  if (background) output = output.removeAlpha();
  await output.png().toFile(new URL(`assets/images/${name}.png`, root).pathname);
}

await render("icon", { background: blue });
await render("icon-dark", { background: dark, color: blue });
await render("icon-tinted", { background: "#000000", color: "#ffffff" });
// Scale the complete mark inside Android's central 66/108 safe-zone circle.
await render("adaptive-icon", { scale: 0.8 });
await render("adaptive-icon-monochrome", { scale: 0.8 });
await render("splash-icon");
await render("splash-icon-dark", { color: blue });
await render("favicon", { background: blue, size: 64 });

// A review sheet uses launcher masks only here; production backgrounds stay square.
const variants = [
  ["Default", "icon"],
  ["Dark", "icon-dark"],
  ["Tinted source", "icon-tinted"],
];
const tiles = await Promise.all(
  variants.map(async ([label, name], index) => {
    const png = await readFile(new URL(`assets/images/${name}.png`, root));
    return `<g transform="translate(${40 + index * 240} 32)"><image width="200" height="200" clip-path="url(#rounded)" href="data:image/png;base64,${png.toString("base64")}"/><text x="100" y="236" text-anchor="middle" fill="#334155" font-family="sans-serif" font-size="17">${label}</text></g>`;
  })
);
await writeFile(
  new URL("assets/branding/preview.png", root),
  await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="300"><defs><clipPath id="rounded"><rect width="200" height="200" rx="45"/></clipPath></defs><rect width="760" height="300" fill="#f1f5f9"/>${tiles.join("")}</svg>`
    )
  )
    .png()
    .toBuffer()
);
