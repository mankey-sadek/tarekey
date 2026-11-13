// بيبني نسخ HTML قائمة بذاتها (h3-js جوّاها) — تشتغل من غير نت:
//   dist/fi-tari2ak.html  الزبون والكابتن جنب بعض + سجل السيرفر
//   dist/rider.html       تطبيق الزبون لوحده (PWA)
//   dist/captain.html     تطبيق الكابتن لوحده (PWA)
// وبينسخ ملفات التثبيت (manifest, icons, sw.js) — فولدر dist ده هو اللي بيترفع على GitHub Pages
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
const here = new URL(".", import.meta.url);
const out = new URL("dist/", here);
const html = readFileSync(new URL("index.html", here), "utf8");
const h3 = readFileSync(new URL("../node_modules/h3-js/dist/h3-js.umd.js", here), "utf8");
const tag = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/h3-js@[^"]+"><\/script>/;
if (!tag.test(html)) throw new Error("h3 script tag not found");
const base = html.replace(tag, () => `<script>${h3.replace(/<\/script/gi, "<\\/script")}</script>`);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("fi-tari2ak.html", out), base);

const apps = {
  rider: { file: "rider.html", app: "rider", name: "في طريقك", short: "في طريقك", title: "في طريقك — اطلب رحلتك" },
  captain: { file: "captain.html", app: "driver", name: "في طريقك كابتن", short: "كابتن", title: "في طريقك كابتن" },
};
for (const [id, a] of Object.entries(apps)) {
  const head = `<link rel="manifest" href="${id}.webmanifest">
<meta name="theme-color" content="#14181f">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${a.short}">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<script>window.FT_APP = "${a.app}";</script>`;
  const page = base
    .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">')
    .replace(/<title>[^<]*<\/title>/, `<title>${a.title}</title>\n${head}`);
  writeFileSync(new URL(a.file, out), page);
  writeFileSync(new URL(`${id}.webmanifest`, out), JSON.stringify({
    id: `fi-tari2ak-${id}`, name: a.name, short_name: a.short, lang: "ar", dir: "rtl",
    start_url: `./${a.file}`, scope: "./", display: "standalone", orientation: "portrait",
    background_color: "#14181f", theme_color: "#14181f",
    icons: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, null, 2));
}
for (const f of readdirSync(new URL("pwa/", here))) copyFileSync(new URL(`pwa/${f}`, here), new URL(f, out));
console.log("built ui/dist: fi-tari2ak.html, rider.html, captain.html + PWA files");
