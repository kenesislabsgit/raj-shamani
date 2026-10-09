// Publish only browser assets. Authenticated HTML and API routes come from AWS.
import {copyFile, mkdir, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
const assets = ['reader.js', 'reader.css', 'theme.js', 'sign-in.js', 'catalog.json',
  'favicon.svg', 'geist-latin.woff2', 'google-sans.ttf', 'Geist-OFL.txt', 'GoogleSans-OFL.txt',
  'media/raj-shamani.jpg', 'media/google-g.png', 'media/huberman.png'];
for (const asset of assets) {
  const destination = path.join(output, asset);
  await mkdir(path.dirname(destination), {recursive: true});
  await copyFile(path.join(root, 'knowledge/web', asset), destination);
}
console.log(`Prepared ${assets.length} browser assets; authentication and APIs are served by AWS.`);
