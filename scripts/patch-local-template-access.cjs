const fs = require('node:fs');
const path = require('node:path');

// Login is optional in this restoration. This renderer flag controls only
// local preset -> template conversion and its context-menu affordances.
// Remote account, download and membership state are left to their own APIs.
function patchLocalTemplateAccess(frontend) {
  const original = 'kl=Ve&&!!kt?.membership,$a=!Ve||kl,sl=';
  const restored = 'kl=Ve&&!!kt?.membership,$a=!0,sl=';
  let matches = 0;
  for (const name of fs.readdirSync(path.join(frontend, 'assets')).filter(name => name.endsWith('.js'))) {
    const file = path.join(frontend, 'assets', name);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(original)) {
      if (text.split(original).length !== 2) throw new Error('本地模板入口标记不唯一，需重新核对前端');
      fs.writeFileSync(file, text.replace(original, restored));
      matches++;
    } else if (text.includes(restored)) matches++;
  }
  if (matches !== 1) throw new Error('未找到受支持的本地模板入口，不能静默跳过恢复');
}

module.exports = {patchLocalTemplateAccess};
if (require.main === module) patchLocalTemplateAccess(path.resolve(__dirname, '../resources/frontend'));
