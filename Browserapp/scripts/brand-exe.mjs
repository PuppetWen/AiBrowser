import { rcedit } from 'rcedit';

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
  'file-version': '1.0.2.0',
  'product-version': '1.0.2.0',
  icon: iconPath,
  'requested-execution-level': 'asInvoker'
});
