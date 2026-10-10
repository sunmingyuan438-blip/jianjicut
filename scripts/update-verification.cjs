const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {read,write}=require('../backend/util.cjs');
const root=path.resolve(__dirname,'..');
const dest=path.join(root,'verification');fs.mkdirSync(dest,{recursive:true});
async function digest(file){const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function main(){
const build=read(path.join(root,'restoration-build.json'));
const evidence=[['.test-data/installer-r8/desktop-smoke.json','windows-installed-desktop.json'],['.test-data/installer-r8/installation.json','windows-installation.json'],['.test-data/workbench-ui/workbench-ui-report.json','workbench-ui.json'],['.test-data/material-lifecycle-ui/material-ui-report.json','material-ui.json'],['.test-data/template-chars-contract.json','template-chars-contract.json'],['.test-data/service-tests-r8.xml','service-tests.xml'],['.test-data/source-rebuild-r8/source-rebuild-r8-report.json','source-rebuild-r8.json'],['.test-data/e2e/real-template-report.json','real-template-drafts.json'],['.test-data/e2e/original-core-comparison.json','original-core-comparison.json'],['.test-data/mac-bundle-inspection.json','mac-bundle-inspection.json'],['.test-data/template-ui/template-ui-report.json','template-ui.json'],['.test-data/desktop-tray/tray-report.json','desktop-tray.json'],['.test-data/ai-settings-ui/ai-settings-ui-report.json','ai-settings-ui.json']];
for(const[from,to]of evidence)fs.copyFileSync(path.join(root,from),path.join(dest,to));
fs.mkdirSync(path.join(dest,'workbench-screenshots'),{recursive:true});
for(const name of ['cut','material','draft','standalone-preview'])fs.copyFileSync(path.join(root,'.test-data/workbench-ui',name+'.png'),path.join(dest,'workbench-screenshots',name+'.png'));
fs.cpSync(path.join(root,'.test-data/installer-r8/screenshots'),path.join(dest,'desktop-screenshots'),{recursive:true});
fs.mkdirSync(path.join(dest,'material-screenshots'),{recursive:true});for(const name of fs.readdirSync(path.join(root,'.test-data/material-lifecycle-ui')).filter(name=>name.endsWith('.png')))fs.copyFileSync(path.join(root,'.test-data/material-lifecycle-ui',name),path.join(dest,'material-screenshots',name));
const inventoryFile=path.resolve(root,'../xycut-recovered-0.2.10/analysis/native-command-inventory.json');
if(fs.existsSync(inventoryFile))fs.copyFileSync(inventoryFile,path.join(dest,'native-command-inventory.json'));
const inventory=read(path.join(dest,'native-command-inventory.json'));
const implementation=fs.readFileSync(path.join(root,'backend/service.cjs'),'utf8');
const tested=new Set(['clear_ai_runtime','clear_ffmpeg_runtime','clear_sucai_pending_sources','create_sucai_library','delete_sucai_library','delete_sucai_material','delete_local_hot_template','get_ai_runtime_status','get_ffmpeg_runtime_status','get_sucai_db_status','get_sucai_storage_status','get_agent_api_context','update_agent_api_context','save_agent_context_file','test_ai_service_api','import_sucai_materials','index_sucai_classified_directory','install_ai_runtime','install_ffmpeg_runtime','install_builtin_preset','list_sucai_embedding_items','save_sucai_embeddings','pack_template_folder','reset_sucai_material_analysis','save_local_preset_as_hot_template','save_local_preset_as_video_template','scan_builtin_presets','scan_local_presets','list_local_hot_templates','update_sucai_material','update_sucai_storage_dir','list_recent_workbench_tasks','restart_jianying','clear_cache','reset_local_data','generate_doubao_tts','generate_doubao_voice_clone','transcribe_doubao_asr']);
const commands=inventory.native_commands.map(item=>({name:item.name,implemented:implementation.includes(item.name+':'),windows_status:tested.has(item.name)?'covered_by_functional_test':'implemented_pending_full_behavior_validation',macos_status:'pending_device_test'}));
assert.ok(commands.every(item=>item.implemented),'存在尚未实现的原生命令');
const xml=fs.readFileSync(path.join(dest,'service-tests.xml'),'utf8');
const counts=Object.fromEntries([...xml.matchAll(/<!-- (tests|pass|fail|cancelled|skipped) (\d+) -->/g)].map(match=>[match[1],Number(match[2])]));
assert.ok(counts.tests>0&&counts.pass===counts.tests&&counts.fail===0&&counts.cancelled===0&&counts.skipped===0,'功能用例未全部通过');
const installed=read(path.join(dest,'windows-installed-desktop.json')),installation=read(path.join(dest,'windows-installation.json')),workbench=read(path.join(dest,'workbench-ui.json')),tray=read(path.join(dest,'desktop-tray.json')),aiSettings=read(path.join(dest,'ai-settings-ui.json'));
const mac=read(path.join(dest,'mac-bundle-inspection.json'));
const material=read(path.join(dest,'material-ui.json'));assert.equal(material.build_id,build.id);assert.equal(material.ok,true);assert.equal(material.paid_or_live_provider_calls,false);
const templateUI=read(path.join(dest,'template-ui.json'));assert.equal(templateUI.build_id,build.id);assert.equal(templateUI.ok,true);assert.equal(templateUI.local_conversion_without_login,true);assert.equal(templateUI.paid_or_live_provider_calls,false);assert.equal(templateUI.command_errors.length,2);
const sourceRebuild=read(path.join(dest,'source-rebuild-r8.json'));assert.equal(sourceRebuild.build_id,build.id);assert.equal(sourceRebuild.isolation.copy_matches_manifest,true);assert.equal(sourceRebuild.isolation.sibling_recovery_present,false);assert.equal(sourceRebuild.npm_ci.exit_code,0);assert.equal(sourceRebuild.tests.test_count,counts.tests);assert.equal(sourceRebuild.tests.passed,counts.pass);assert.equal(sourceRebuild.windows_build.exit_code,0);assert.equal(sourceRebuild.windows_build.installed,false);assert.equal(sourceRebuild.real_ai_provider_calls,0);assert.equal(sourceRebuild.real_uploads,0);
for(const report of [installed,installation,workbench]){assert.equal(report.build_id,build.id);assert.equal(report.pass,true);}
assert.equal(installed.integration.doubao.ok,true);assert.equal(installed.integration.doubao.live_provider_called,false);assert.equal(installed.integration.ai_switch.ok,true);
assert.equal(tray.build_id,build.id);assert.equal(tray.ok,true);
assert.equal(aiSettings.build_id,build.id);assert.equal(aiSettings.ok,true);assert.equal(aiSettings.paid_or_live_provider_calls,false);assert.equal(aiSettings.ai_recommended_install.downloaded_count_matches_disk,true);assert.equal(aiSettings.ai_recommended_install.downloaded_count_matches_favorites,true);assert.equal(aiSettings.material_head_trim.agent_context_saved,true);
assert.ok(mac.length===2&&mac.every(report=>report.build_id===build.id&&report.zip_crc_pass));
const version=read(path.join(root,'package.json')).version;
const artifactNames=[`XYCut-restored-${version}-Windows-x64-Setup.exe`,...['arm64','x64'].map(arch=>`XYCut-restored-${version}-macOS-${arch}-TEST.zip`)];
const artifacts=await Promise.all(artifactNames.map(async name=>{const file=path.join(root,'dist',name);return{name,bytes:fs.statSync(file).size,sha256:await digest(file)};}));
assert.equal(artifacts[0].sha256,installation.installer_sha256);
const realTemplates=read(path.join(dest,'real-template-drafts.json')).cases;
const comparisons=read(path.join(dest,'original-core-comparison.json')).cases;
write(path.join(root,'parity.json'),{version,build_id:build.id,updated_at:new Date().toISOString(),goal_complete:false,windows:{installer_built:true,installer_installed:true,packaged_desktop_smoke_pass:installed.pass,desktop_page_count:installed.pages.length,functional_cases:counts,real_templates_passed:realTemplates.filter(item=>item.ok&&!item.missing_media.length).length,real_template_core_comparisons_equal:comparisons.every(item=>item.equal),workbench_ui_pass:workbench.pass,template_ui_pass:templateUI.ok,desktop_tray_pass:tray.ok,ai_settings_ui_pass:aiSettings.ok,standalone_preview_pass:workbench.standalone_preview.saved&&installed.integration.preview.ok,doubao_connection_contract_offline_pass:installed.integration.doubao.ok,doubao_live_provider_tested:false,agent_api_switch_ui_pass:installed.integration.ai_switch.ok,material_lifecycle_ui_pass:material.ok,source_isolated_npm_ci_pass:sourceRebuild.npm_ci.exit_code===0,source_isolated_tests_pass:sourceRebuild.tests.passed===counts.pass,source_isolated_windows_build_pass:sourceRebuild.windows_build.exit_code===0,jianying_open_edit_tested:false,preview_screenshot_error:installed.integration.preview.screenshot_error},macos:{arm64_bundle_created:true,x64_bundle_created:true,minimum_macos:'13.0',binary_architectures_checked:true,device_tested:false,jianying_open_edit_tested:false,native_build_script_tested:false},native_commands:commands,handoff_status_file:'verification/handoff-status.json',source_rebuild_report:'verification/source-rebuild-r8.json',remaining:['Mac 实机启动及核心验收','Windows/Mac 剪映打开和编辑生成的草稿','其余模板和完整交互流程对照原软件验收','原服务账号、会员、计费、AI 服务、分享上传与自动更新的真实场景验收','原 Rust/TSX 和服务端源码未完整找回；部分源码通过重新实现替代'],online_note:'公开模板目录和免费模板已验证。原客户端生成 API 一次核对返回扣除 5 积分，已告知用户并停止调用；其他自动生成验证调用离线恢复核心，没有上传或购买。'});
require('./write-handoff-status.cjs').writeStatus({root,dest,build});
write(path.join(dest,'artifacts.json'),{build_id:build.id,created_at:new Date().toISOString(),artifacts,source_archive_checksum:'dist/SHA256SUMS.txt; generated after this evidence file to avoid a circular checksum'});
console.log(JSON.stringify({build_id:build.id,commands:commands.length,functional:counts,artifact_count:artifacts.length,goal_complete:false}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

