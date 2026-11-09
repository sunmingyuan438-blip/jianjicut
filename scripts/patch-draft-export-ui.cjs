const fs=require('node:fs'),path=require('node:path');
function patchDraftExportUI(resources){
 const file=path.join(resources,'agent-kit/tools/editing-workbench/public/workbench.js');let text=fs.readFileSync(file,'utf8');
 if(text.includes('zhangmen-import-note'))return;
 const marker='De("剪映草稿已生成",`<div class="generate-result-card">';
 if(text.split(marker).length!==2)throw new Error('草稿生成结果界面不匹配');
 text=text.replace(marker,'De("剪映草稿已生成",`<div class="generate-result-card"><p class="zhangmen-import-note">${d(t.import_message||t.draft?.import_message||"草稿已写入剪映目录，请保存当前工程后重新打开剪映查看。")}</p>${(t.warnings||t.draft?.warnings||[]).map(message=>`<p>${d(message)}</p>`).join("")}');
 fs.writeFileSync(file,text);
}
module.exports={patchDraftExportUI};
if(require.main===module)patchDraftExportUI(path.resolve(process.argv[2]||'resources'));
