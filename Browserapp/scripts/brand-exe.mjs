import { rcedit } from 'rcedit';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const versionParts = String(manifest.version || '').split('.');
if (versionParts.length !== 3 || versionParts.some((part) => !/^\d+$/.test(part) || Number(part) > 65535)) {
  throw new Error('package.json version must contain three integers between 0 and 65535');
}
const windowsVersion = [...versionParts, '0'].join('.');

const [exePath, iconPath] = process.argv.slice(2);
if (!exePath || !iconPath) {
  throw new Error('Usage: node brand-exe.mjs <exePath> <iconPath>');
}

await rcedit(exePath, {
  'version-string': {
    ProductName: 'AiBrowser',
    FileDescription: 'AiBrowser Local Workspace',
    CompanyName: 'AiBrowser 开源项目',
    LegalCopyright: 'AGPL-3.0-or-later',
    OriginalFilename: 'AiBrowser.exe'
  },
  'file-version': windowsVersion,
  'product-version': windowsVersion,
  icon: iconPath,
  'requested-execution-level': 'asInvoker'
});
