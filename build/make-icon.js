const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#155fc7"/>
      <stop offset="1" stop-color="#0a84ff"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="248" height="248" rx="56" fill="url(#bg)"/>
  <g stroke="#ffffff" stroke-width="10" stroke-linejoin="round" fill="none">
    <rect x="46" y="70" width="164" height="112" rx="18"/>
    <line x1="78" y1="206" x2="178" y2="206" stroke-linecap="round"/>
  </g>
  <circle cx="128" cy="126" r="36" fill="#ffffff"/>
</svg>
`;

async function main() {
    const icoPath = path.join(__dirname, 'icon.ico');
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngBuffers = [];
    for (const size of sizes) {
        const buf = await sharp(Buffer.from(SVG))
            .resize(size, size)
            .png()
            .toBuffer();
        pngBuffers.push(buf);
    }

    const ico = await pngToIco(pngBuffers);
    fs.writeFileSync(icoPath, ico);
    console.log('ICO written:', icoPath, ico.length, 'bytes');
}

main().catch((err) => { console.error(err); process.exit(1); });
