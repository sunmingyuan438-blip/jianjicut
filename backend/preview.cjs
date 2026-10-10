const fs = require('node:fs');
const path = require('node:path');

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}
function renderPreview(resources, result) {
  const template = fs.readFileSync(path.join(resources, 'video-template-preview/index.html'), 'utf8');
  const values = {
    __XYCUT_ANALYSIS_JSON__: scriptJson(result.analysis),
    __XYCUT_ANALYSIS_FILE_JSON__: scriptJson(result.analysis_file),
    __XYCUT_ANALYSIS_FILE_HTML__: escapeHtml(result.analysis_file),
  };
  return template.replace(/__XYCUT_(?:ANALYSIS_JSON|ANALYSIS_FILE_JSON|ANALYSIS_FILE_HTML)__/g, placeholder => values[placeholder]);
}
module.exports = {renderPreview};
