const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, appName + '.app');
  const tmpPath = appPath + '.norsrc.tmp';

  try {
    // ditto --norsrc elimina resource forks reales que xattr -cr no puede quitar
    execSync(`ditto --norsrc "${appPath}" "${tmpPath}"`, { stdio: 'pipe' });
    execSync(`rm -rf "${appPath}"`, { stdio: 'pipe' });
    execSync(`mv "${tmpPath}" "${appPath}"`, { stdio: 'pipe' });
    console.log(`[afterPack] resource forks eliminados: ${appPath}`);
  } catch (e) {
    if (fs.existsSync(tmpPath)) {
      try { execSync(`rm -rf "${tmpPath}"`); } catch {}
    }
    console.warn('[afterPack] ditto warning (ignorado):', e.message);
  }
};
