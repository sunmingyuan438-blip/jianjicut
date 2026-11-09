const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createAccountStore({dataDir, safeStorage}) {
  const file = path.join(dataDir, 'account', 'session.enc');
  const available = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; }
  };
  return {
    available,
    async load() {
      // Fresh installs have nothing to decrypt. Do not block the first window
      // on a needless Keychain query before the user has even logged in.
      if (!fs.existsSync(file) || !available()) return null;
      try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); } catch { return null; }
    },
    async save(session) {
      if (!available()) return false;
      const temp = file + '.' + crypto.randomUUID() + '.tmp';
      try {
        const bytes = safeStorage.encryptString(JSON.stringify(session));
        fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
        fs.writeFileSync(temp, bytes, {mode: 0o600});
        fs.renameSync(temp, file);
        return true;
      } catch { return false; }
      finally { fs.rmSync(temp, {force: true}); }
    },
    async clear() { fs.rmSync(file, {force: true}); }
  };
}
module.exports = {createAccountStore};
