const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {read, write, within, safeName, walk, run, download, extract} = require('./util.cjs');
const {analyzeTemplate,draftFile}=require('./template.cjs');
const {applyEditedTimeline}=require('./generation.cjs');

const mediaType = file => /\.(jpe?g|png|webp|gif|bmp)$/i.test(file) ? 'image' : /\.(mp4|mov|mkv|avi|webm|m4v|wmv|flv|3gp)$/i.test(file) ? 'video' : /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file) ? 'audio' : null;
const listValue = value => Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : String(value || '').split(/[,，、;；\s]+/).map(item => item.trim()).filter(Boolean);
const normalizedText = value => String(value || '').trim().toLocaleLowerCase('zh-Hans');
function normalizeDurationMs(value, field = '') {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  // Jianying's rough_cut_duration is stored in microseconds, while the
  // recovered UI exposes all duration filters in milliseconds.
  if (field === 'rough_cut_duration' && number >= 100000) return Math.round(number / 1000);
  return Math.round(number);
}

// Jianying may expose either its `.../Combination/Presets` directory or a
// parent installation directory. Resolve the latter without assuming a drive
// letter, and keep accepting an existing custom folder for older configurations.
function childDirectory(root, name) {
  try {
    const entry = fs.readdirSync(root, {withFileTypes: true}).find(item => !item.isSymbolicLink() && item.isDirectory() && item.name.toLowerCase() === name.toLowerCase());
    return entry ? path.join(root, entry.name) : null;
  } catch { return null; }
}
function resolvePresetDirectory(value) {
  if (!value) return null;
  const selected = path.resolve(String(value));
  try { if (!fs.statSync(selected).isDirectory()) return null; } catch { return null; }
  const base = path.basename(selected).toLowerCase(), parent = path.basename(path.dirname(selected)).toLowerCase();
  if (base === 'presets' && parent === 'combination') return selected;
  const combination = childDirectory(selected, 'Combination'), presets = combination && childDirectory(combination, 'Presets');
  return presets || selected;
}

class Service {
  constructor({resources, dataDir, desktop = {}}) {
    this.resources = path.resolve(resources);
    this.dataDir = path.resolve(dataDir);
    this.desktop = desktop;
    this.port = 17651;
    this.authorized = new Set([this.resources, this.dataDir]);
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.settings = read(this.settingsFile, {});
    this.apiContext = read(path.join(this.dataDir, 'api-context.json'), {});
    this.storage = this.settings.storage_dir || path.join(this.dataDir, 'sucai/libraries');
    this.dbPath = path.join(this.dataDir, 'sucai/xycut-sucai.db');
    this.cache = path.join(this.dataDir, 'cache');
    for (const dir of [this.dataDir, this.storage, this.cache]) fs.mkdirSync(dir, {recursive: true});
    this.grant(this.storage);
    this.grant(this.apiContext.preset_dir||this.settings.preset_dir);
    if (this.apiContext.draft_output_dir) this.grant(this.apiContext.draft_output_dir);
  }
  grant(file) { if (file) this.authorized.add(path.resolve(file)); return file; }
  canRead(file) { try { const real = fs.realpathSync(file); return [...this.authorized].some(root => fs.existsSync(root) && within(fs.realpathSync(root), real)); } catch { return false; } }
  resourceStatus() {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const pythonRuntime = process.platform === 'win32' ? path.join('python', 'python.exe') : path.join('python', 'bin', 'python3.9');
    const bundledPython = path.join(this.resources, pythonRuntime);
    const installedPython = path.join(this.dataDir, 'runtime/python', pythonRuntime);
    const explicitPython = process.env.XYCUT_PYTHON ? path.resolve(process.env.XYCUT_PYTHON) : '';
    const pythonPath = [explicitPython, installedPython, bundledPython].find(file => file && fs.existsSync(file)) || explicitPython || installedPython;
    const ffmpegPath = this.tool('ffmpeg') || path.join(this.resources, 'ffmpeg', `ffmpeg${suffix}`);
    const ffprobePath = this.tool('ffprobe') || path.join(this.resources, 'ffmpeg', `ffprobe${suffix}`);
    const paths = {
      resources_root: this.resources,
      frontend_path: path.join(this.resources, 'frontend', 'index.html'),
      core_worker_path: path.join(this.resources, 'core_worker.py'),
      python_path: pythonPath,
      ffmpeg_path: ffmpegPath,
      ffprobe_path: ffprobePath,
      agent_kit_path: path.join(this.resources, 'agent-kit'),
      builtin_presets_path: path.join(this.resources, 'builtin-presets'),
      draft_shell_path: path.join(this.resources, 'draft-shell'),
      restoration_build_path: path.join(this.resources, 'restoration-build.json')
    };
    return {...paths, exists: Object.fromEntries(Object.entries(paths).filter(([key]) => key.endsWith('_path')).map(([key, file]) => [key, fs.existsSync(file)]))};
  }
  python() {
    const runtime=process.platform==='win32'?'python.exe':'bin/python3.9';
    const installed=path.join(this.dataDir,'runtime/python',runtime);
    const bundled=path.join(this.resources,'python',runtime);
    const candidates=[process.env.XYCUT_PYTHON,installed,bundled].filter(Boolean).map(file=>path.resolve(file));
    const candidate=candidates.find(file=>fs.existsSync(file));
    if (!candidate) throw new Error(`缺少 CPython 3.9 运行环境，请先准备当前平台资源。resourcesRoot=${this.resources}；候选路径=${candidates.join('; ')}`);
    return candidate;
  }
  async worker(request) {
    return JSON.parse(await run(this.python(), [path.join(this.resources, 'core_worker.py')], {resources: this.resources, ...request}));
  }
  async db(action, args = {}) {
    const result=await this.worker({op:'db',db_path:this.dbPath,managed_storage_root:this.storage,action,args});
    for(const item of result.status?.libraries||[])this.grant(item.root_path);
    for(const item of [...(result.status?.materials||[]),...(result.status?.source_materials||[])]){this.grant(item.path);this.grant(item.original_path);}
    return result;
  }
  async embeddings(body) {
    const context=read(path.join(this.dataDir,'agent-context.json'),{});
    if(context.ai_services?.doubao_llm?.mode!=='user_key'&&this.apiContext.auth_token){const base=(this.apiContext.api_base_urls||['https://yushe.neirongpai.com'])[0];const response=await fetch(base+'/api/sucai/embeddings',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.apiContext.auth_token},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});const data=await response.json();if(!response.ok)throw new Error(data.message||data.error||'向量服务返回错误');return data;}
    return this.worker({op:'embeddings',context,items:body.items||[]});
  }
  async buildEmbeddings(body) {
    const pending=await this.db('embedding_items',{libraryId:body.library_id,limit:body.limit||100});
    if(!pending.items.length)return{ok:true,requested_count:0,saved_count:0,built_count:0};
    const generated=await this.embeddings({purpose:'material_index',items:pending.items.map(i=>({id:i.id,text:i.text}))});
    const hashes=new Map(pending.items.map(item=>[item.id,item.source_hash]));
    const vectors=generated.embeddings||generated.items||generated.data||[];
    if(!Array.isArray(vectors))throw new Error('向量服务返回的结果不是素材列表');
    const items=vectors.map(item=>({...item,source_hash:hashes.get(item.id||item.material_id)}));
    if(items.some(item=>!item.source_hash))throw new Error('向量服务返回了不属于本次索引请求的素材');
    if(new Set(items.map(item=>item.id||item.material_id)).size!==items.length)throw new Error('向量服务重复返回了相同素材');
    const saved=await this.db('save_embeddings',{provider:generated.provider,model:generated.model,items});
    return {ok:true,requested_count:pending.items.length,saved_count:saved.saved_count,built_count:saved.saved_count,status:saved.status};
  }
  async script(skill, file, args = []) {
    const target = path.join(this.resources, 'agent-kit/skills', skill, 'scripts', file);
    // The Windows embeddable interpreter omits the script folder from sys.path.
    const launcher = 'import sys,runpy; p=sys.argv.pop(1); sys.path.insert(0,__import__("os").path.dirname(p)); runpy.run_path(p,run_name="__main__")';
    return JSON.parse(await run(this.python(), ['-c', launcher, target, ...args], undefined, {env: {PATH:[path.dirname(this.tool('ffmpeg')||this.python()),process.env.PATH||''].join(path.delimiter),XYCUT_FFMPEG_PATH: this.tool('ffmpeg') || '', XYCUT_FFPROBE_PATH: this.tool('ffprobe') || '', XYCUT_AGENT_CONTEXT: path.join(this.dataDir, 'agent-context.json')}}));
  }
  tool(name) {
    if(this.settings.ffmpeg_disabled)return null;
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const bundled = walk(path.join(this.resources, 'ffmpeg'), file => path.basename(file) === name + suffix)[0];
    const installed = walk(path.join(this.dataDir, 'runtime/ffmpeg'), file => path.basename(file) === name + suffix)[0];
    if (bundled || installed) return installed || bundled;
    for (const dir of (process.env.PATH || '').split(path.delimiter)) { const file = path.join(dir, name + suffix); if (fs.existsSync(file)) return file; }
    return null;
  }
  runtimeStatus() { const file=this.python(); return {installed:!this.settings.ai_runtime_disabled&&fs.existsSync(file),runtime_dir:path.dirname(file),python_path:file,version:'1.0.0',python_version:'3.9',core_version:'0.2.10',source:'restored'}; }
  ffmpegStatus() { const ffmpeg = this.tool('ffmpeg'), ffprobe = this.tool('ffprobe'); return {installed: !!(ffmpeg && ffprobe), runtime_dir: ffmpeg ? path.dirname(ffmpeg) : path.join(this.dataDir, 'runtime/ffmpeg'), ffmpeg_path: ffmpeg || '', ffprobe_path: ffprobe || ''}; }
  presets(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, {withFileTypes: true}).filter(e => e.isDirectory() && !e.isSymbolicLink()).flatMap(entry => {
      const folder = path.join(root, entry.name);
      const draft = path.join(folder, 'preset_draft/draft_content.json');
      if (!fs.existsSync(draft) && !fs.existsSync(path.join(folder, 'draft_content.json'))) return [];
      const metadata = read(path.join(folder, entry.name + '.json'), {});
      const files = walk(folder, () => true, 0);
      const tags = Array.isArray(metadata.tags) ? metadata.tags : String(metadata.tags || '').split(/[,，、;；\s]+/).filter(Boolean);
      const styleTags = Array.isArray(metadata.style_tags) ? metadata.style_tags : (Array.isArray(metadata.styleTags) ? metadata.styleTags : []);
      const categoryIds = Array.isArray(metadata.category_ids) ? metadata.category_ids : [metadata.category_id || 'default'];
      const durationField = metadata.duration_ms != null ? 'duration_ms' : metadata.suggest_duration_ms != null ? 'suggest_duration_ms' : metadata.rough_cut_duration != null ? 'rough_cut_duration' : 'duration';
      const durationMs = normalizeDurationMs(metadata[durationField], durationField);
      const ratio = metadata.aspect_ratio || metadata.ratio || (metadata.cover_width && metadata.cover_height ? `${metadata.cover_width}:${metadata.cover_height}` : '');
      return [{id: metadata.id || entry.name, name: metadata.name || entry.name, folder_name: entry.name, folder_path: folder,
        cover_path: files.find(f => /\.(jpe?g|png|webp)$/i.test(f)) || null, preview_path: files.find(f => /\.(mp4|mov)$/i.test(f)) || null,
        updated_at: Math.round(fs.statSync(folder).mtimeMs / 1000), tags, filter_tags: tags, filterTags: tags, style_tags: styleTags,
        category: metadata.category || metadata.category_name || '本地', category_name: metadata.category_name || metadata.category || '本地',
        category_id: metadata.category_id || categoryIds[0] || 'default', category_ids: categoryIds, orientation: metadata.orientation,
        ratio, aspect_ratio: ratio, duration_ms: durationMs, suggest_duration_ms: Number(metadata.suggest_duration_ms || durationMs) || 0,
        subtitle_word_count: metadata.subtitle_word_count || metadata.word_count || null, font_style: metadata.font_style || metadata.fontStyle || '', analysis: metadata.analysis, rough_cut_duration: metadata.rough_cut_duration || null}];
    });
  }
  filterPresets(items, args = {}) {
    const search = normalizedText(args.search || args.query || '');
    const categories = new Set(listValue(args.category || args.categories || args.category_id || args.category_ids).map(normalizedText));
    const tags = listValue(args.tags || args.filter_tags || args.filterTags).map(normalizedText);
    const styleTags = listValue(args.style_tags || args.styleTags || args.font_style).map(normalizedText);
    const ratio = normalizedText(args.ratio || args.aspect_ratio || '');
    const orientation = normalizedText(args.orientation || '');
    const minWords = Number(args.min_words ?? args.min_subtitle_word_count ?? 0) || 0;
    const maxWords = Number(args.max_words ?? args.max_subtitle_word_count ?? 0) || 0;
    const minDuration = Number(args.min_duration_ms ?? 0) || 0;
    const maxDuration = Number(args.max_duration_ms ?? 0) || 0;
    const filtered = items.filter(item => {
      const itemTags = [...listValue(item.tags), ...listValue(item.filter_tags), ...listValue(item.style_tags)].map(normalizedText);
      const searchable = normalizedText([item.name, item.category, item.category_name, item.font_style, ...itemTags].join(' '));
      if (search && !searchable.includes(search)) return false;
      if (categories.size && ![item.category, item.category_name, item.category_id, ...(item.category_ids || [])].map(normalizedText).some(value => categories.has(value))) return false;
      if (tags.length && !tags.every(tag => itemTags.includes(tag))) return false;
      if (styleTags.length && !styleTags.some(tag => itemTags.includes(tag) || normalizedText(item.font_style) === tag)) return false;
      if (ratio && normalizedText(item.ratio || item.aspect_ratio) !== ratio) return false;
      if (orientation && normalizedText(item.orientation) !== orientation) return false;
      const words = Number(item.subtitle_word_count || 0) || 0;
      if (minWords && words < minWords) return false;
      if (maxWords && words > maxWords) return false;
      const duration = Number(item.duration_ms || 0) || 0;
      if (minDuration && duration < minDuration) return false;
      if (maxDuration && duration > maxDuration) return false;
      return true;
    });
    const sort = String(args.sort || args.order || 'name').toLowerCase();
    const direction = String(args.direction || args.order_direction || '').toLowerCase() === 'desc' ? -1 : 1;
    filtered.sort((a, b) => {
      const av = sort === 'updated' || sort === 'updated_at' ? Number(a.updated_at || 0) : sort === 'duration' || sort === 'duration_ms' ? Number(a.duration_ms || 0) : sort === 'words' || sort === 'subtitle_word_count' ? Number(a.subtitle_word_count || 0) : normalizedText(a.name);
      const bv = sort === 'updated' || sort === 'updated_at' ? Number(b.updated_at || 0) : sort === 'duration' || sort === 'duration_ms' ? Number(b.duration_ms || 0) : sort === 'words' || sort === 'subtitle_word_count' ? Number(b.subtitle_word_count || 0) : normalizedText(b.name);
      return (av < bv ? -1 : av > bv ? 1 : 0) * direction;
    });
    return filtered;
  }
  scanPresets(root, args = {}) { this.grant(root); const presets = this.presets(root), filtered = this.filterPresets(presets, args); return {exists: fs.existsSync(root), preset_dir: root, presets: filtered, total_count: presets.length, filtered_count: filtered.length}; }
  templateRoot(kind) { return path.join(this.dataDir, kind === 'hot_template' ? 'hot-templates' : 'video-templates'); }
  templates(kind) {
    const root = this.templateRoot(kind);
    const templates = walk(root, f => path.basename(f) === 'template-config.json').map(file => {
      const config = read(file, {}), folder = path.dirname(file);
      const preview = walk(folder, f => /\.(mp4|mov|webm)$/i.test(f), 0)[0] || null;
      return {slug: config.template_slug || path.basename(folder), name: config.template_name || path.basename(folder), template_config: config, template_config_file: file, config_path: file, template_dir: folder, tool_dir: path.join(this.resources, 'agent-kit/skills', kind === 'hot_template' ? 'xycut-hot-template-skill/scripts' : 'xycut-video-template-skill/scripts'), skill_dir: path.join(this.resources, 'agent-kit/skills', kind === 'hot_template' ? 'xycut-hot-template-skill' : 'xycut-video-template-skill'), cover_url: walk(folder, f => /\.(jpeg|jpg|png)$/i.test(f), 0)[0] || null, preview_url: preview, category_ids: config.category_ids || ['default'], source: 'local'};
    }).sort((a,b) => String(a.name).localeCompare(String(b.name), 'zh-Hans'));
    return {templates};
  }
  async saveTemplate(kind, args) {
    const slug = safeName(args.slug), folder = path.join(this.templateRoot(kind), slug);
    let config = typeof args.templateConfigJson === 'string' ? JSON.parse(args.templateConfigJson) : args.templateConfigJson;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('模板配置须为 JSON 对象');
    const source = path.resolve(args.templateDir);
    if (!fs.existsSync(source)) throw new Error('模板目录不存在');
    if (!fs.existsSync(path.join(source, 'preset_draft/draft_content.json')) && !fs.existsSync(path.join(source, 'draft_content.json'))) throw new Error('模板中没有可读的 draft_content.json');
    // Older catalogs omit template_config; the renderer then sends {} after
    // installation. Keep the usable package config instead of erasing its slots.
    if (!Object.keys(config).length) {
      const existing = path.join(source, 'template-config.json');
      config = fs.existsSync(existing) ? JSON.parse(fs.readFileSync(existing, 'utf8').replace(/^\uFEFF/, '')) : analyzeTemplate(source, kind, slug);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('模板配置须为 JSON 对象');
    }
    if (source !== folder) fs.cpSync(source, folder, {recursive: true});
    const configFile = path.join(folder, 'template-config.json');
    write(configFile, {...config, template_slug: slug, template_name: args.templateName || slug, template_dir: folder});
    const skill = kind === 'hot_template' ? 'xycut-hot-template-skill' : 'xycut-video-template-skill';
    this.grant(folder);
    return {template_path: folder, template_dir: folder, config_path: configFile, template_config_file: configFile, tool_dir: path.join(this.resources, 'agent-kit/skills', skill, 'scripts'), skill_dir: path.join(this.resources, 'agent-kit/skills', skill)};
  }
  async convertPreset(kind, args) {
    const folder=path.resolve(args.presetDir),slug=safeName(args.templateName||path.basename(folder));
    const config=analyzeTemplate(folder,kind,slug);
    await this.saveTemplate(kind,{slug,templateName:args.templateName,templateDir:folder,templateConfigJson:config});
    return this.templates(kind).templates.find(t=>t.slug===slug);
  }
  async context(input = {}) {
    this.apiContext = {...this.apiContext, ...input};
    write(path.join(this.dataDir, 'api-context.json'), this.apiContext);
    const base = `http://127.0.0.1:${this.port}`;
    for (const file of [input.preset_dir, input.draft_output_dir]) if (file) this.grant(file);
    const context = {schema_version: 1, app: {name: 'XYCut', version: '0.2.10'}, paths: {preset_dir: this.apiContext.preset_dir || this.settings.preset_dir || '', draft_output_dir: this.apiContext.draft_output_dir || '', agent_kit_dir: path.join(this.resources, 'agent-kit')},
      tools: {...this.ffmpegStatus(), python_path: this.python()}, local_api: {base_url: base, generate_url: base + '/ai-editing/generate', template_designer_generate_url: base + '/ai-editing/generate', editing_workbench_open_url: base + '/ai-editing/workbench/open', video_template_preview_url: base + '/ai-editing/video-template/preview', sucai_embeddings_url: base + '/sucai/embeddings', sucai_build_embeddings_url: base + '/sucai/embeddings/build'},
      sucai: {db_path: this.dbPath, library_base_dir: this.storage, ...this.apiContext.sucai_context}, video_editing_settings: this.apiContext.video_editing_settings || {}, third_party_apis: input.third_party_apis || this.apiContext.third_party_apis || {}, favorite_index: this.apiContext.favorite_index || {schema_version: 1, groups: [], presets: []}};
    Object.assign(context.paths,{favorite_preset_index_file:path.join(this.dataDir,'favorite-index.json'),hot_templates_dir:this.templateRoot('hot_template'),local_hot_templates_dir:this.templateRoot('hot_template'),video_templates_dir:this.templateRoot('video_template'),local_video_templates_dir:this.templateRoot('video_template'),local_hot_template_index_file:path.join(this.templateRoot('hot_template'),'index.json'),local_video_template_index_file:path.join(this.templateRoot('video_template'),'index.json'),subtitle_preset_index_file:path.join(this.dataDir,'subtitle-presets/index.json')});
    context.local_api.editing_workbench_url_format=base+'/xycut/{task_id}';
    context.local_api.enabled=this.apiContext.ai_editing_enabled!==false;
    context.local_api.port=this.port;
    context.skills=Object.fromEntries(['xycut-hot-template-skill','xycut-video-template-skill','xycut-sucai-skill','xycut-template-designer-skill','xycut-hot-remake-skill'].map(name=>[name,{install_dir:path.join(this.resources,'agent-kit/skills',name),version:'0.2.10'}]));
    const apis=Array.isArray(context.third_party_apis)?context.third_party_apis:[];
    context.third_party_apis=apis.map(item=>{const parameters=this.parameters(item.parameters),key=parameters.api_key||parameters.apikey||parameters.key||parameters['x-api-key'];return key?{...item,parameters:Array.isArray(item.parameters)?[...item.parameters.filter(parameter=>String(parameter.key).toUpperCase()!=='KEY'),{key:'KEY',value:String(key).trim()}]:{...item.parameters,KEY:String(key).trim()}}:item;});
    const hasKey=type=>apis.some(item=>item.type===type&&Object.entries(this.parameters(item.parameters)).some(([key,value])=>['key','api_key','apikey','x-api-key'].includes(key)&&String(value).trim()));
    context.ai_services={doubao_llm:{mode:hasKey('doubao_llm')?'user_key':'client',api_key_source:'third_party_apis',embedding:{model:'doubao-embedding-vision-251215',url:'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal'}},doubao_speech:{configured:hasKey('doubao_speech'),api_key_source:'third_party_apis',asr:{resource_id:'volc.bigasr.auc_turbo'},tts:{resource_id:'seed-tts-2.0'}},pexels:{configured:hasKey('pexels'),api_key_source:'third_party_apis'}};
    const embeddingApi=apis.find(item=>item.type==='doubao_llm');if(embeddingApi){const params=this.parameters(embeddingApi.parameters);context.ai_services.doubao_llm.embedding.model=params.model||params.endpoint_id||context.ai_services.doubao_llm.embedding.model;context.ai_services.doubao_llm.embedding.url=params.base_url||context.ai_services.doubao_llm.embedding.url;}
    context.speech={asr:{configured:hasKey('doubao_speech'),resource_id:'volc.bigasr.auc_turbo'},tts:{configured:hasKey('doubao_speech'),default_voice_id:'zh_female_vv_uranus_bigtts',resource_id:'seed-tts-2.0'}};
    write(context.paths.local_hot_template_index_file,this.templates('hot_template'));write(context.paths.local_video_template_index_file,this.templates('video_template'));
    write(context.paths.favorite_preset_index_file,context.favorite_index);
    write(path.join(this.dataDir, 'agent-context.json'), context);
    return {agent_context_file: path.join(this.dataDir, 'agent-context.json'), ...context.local_api, enabled: this.apiContext.ai_editing_enabled!==false, port: this.port};
  }
  async generate(body) {
    if(!this.runtimeStatus().installed)throw new Error('请先安装 AI 剪辑运行环境');
    let plan = body.generation_plan, mode = body.mode || 'video_template';
    if (body.analysis_file) {
      const analysis = read(this.resolvePath(body.analysis_file));
      if (!analysis) throw new Error('分析文件不存在');
      const nested=analysis.generation_plan||analysis.updated_plan||analysis.plan;
      const {generation_plan,updated_plan,plan:legacyPlan,template_preview,...edited}=analysis;
      plan = nested ? {...nested,...edited} : analysis;
      mode = analysis.mode || plan.mode || mode;
      if(Array.isArray(plan.title?.lines)&&plan.title.lines.length){
        // The original preview edits title.lines; the recovered core reads
        // titles/title.items first. Keep those representations consistent.
        plan.title={...plan.title,items:plan.title.lines.map((text,index)=>({...plan.title.items?.[index],text:String(text),index:index+1}))};
        plan.titles=plan.title.lines.map(String);
      }
    }
    if (body.plan_path) plan = read(this.resolvePath(body.plan_path));
    if (!plan || typeof plan !== 'object') throw new Error('缺少 generation_plan 或 plan_path');
    const analysisRoot=body.analysis_file?(path.basename(path.dirname(this.resolvePath(body.analysis_file)))==='output'?path.dirname(path.dirname(this.resolvePath(body.analysis_file))):path.dirname(this.resolvePath(body.analysis_file))):null;
    const savedFile=name=>{
      if(body[name])return this.resolvePath(body[name]);
      if(!analysisRoot)return null;
      const stored=plan.edit_files?.[name]||plan[name];
      if(stored&&fs.existsSync(this.resolvePath(stored)))return this.resolvePath(stored);
      const standard=path.join(analysisRoot,'edit',name==='cut_plan_file'?'cut_plan.json':'line_timeline.json');
      return fs.existsSync(standard)?standard:null;
    };
    const cutFile=savedFile('cut_plan_file'),timelineFile=savedFile('line_timeline_file');
    if (cutFile) {plan.cut_plan_file=cutFile;plan.cut_plan=read(cutFile);if(!plan.cut_plan)throw new Error('工作台剪辑计划文件不存在');}
    if(plan.cut_plan?.delete_ranges?.length && !plan.cut_plan.keep_ranges?.length)throw new Error('全部媒体已删除，无法生成空草稿');
    if (timelineFile) {plan.line_timeline_file=timelineFile;const timeline=read(timelineFile);if(!timeline)throw new Error('工作台时间线文件不存在');applyEditedTimeline(plan,timeline,plan.line_timeline);}
    if(plan.cut_plan?.keep_ranges?.length){const duration=plan.cut_plan.total_keep_duration??plan.cut_plan.duration??plan.cut_plan.keep_ranges.reduce((sum,item)=>sum+Number(item.source_end)-Number(item.source_start),0);if(Number.isFinite(Number(duration)))plan.timeline_duration_ms=Math.round(Number(duration)*1000);}
    const output = body.draft_output_dir || plan.draft_output_dir || this.apiContext.draft_output_dir;
    if (!output || !fs.existsSync(output)) throw new Error('请设置存在的剪映草稿保存目录');
    const template = body.template_dir || plan.template_dir || '';
    const config = body.template_config_file || plan.template_config_file || path.join(template, 'template-config.json');
    const task = path.join(this.dataDir, 'tasks', crypto.randomUUID());
    fs.mkdirSync(task, {recursive: true});
    const planFile = path.join(task, 'generation_plan.json'); write(planFile, plan);
    const result = await this.worker({op: 'assemble', mode, payload: {plan_path: planFile, template_dir: template, template_config_path: config, draft_output_dir: output, base_draft_dir: path.join(this.resources, 'draft-shell')}});
    if (!result.ok) throw new Error(result.message || '草稿生成失败');
    this.grant(output);
    return {ok: true, draft: result, ...result};
  }
  resolvePath(file) { return process.platform === 'win32' ? path.resolve(String(file)) : path.resolve(String(file).replace(/\\/g, '/')); }
  async invoke(name, args = {}) {
    if (name.startsWith('plugin:')) return this.desktop.invokePlugin(name, args);
    const commands = {
      get_cache_dir: () => this.cache,
      get_ai_runtime_status: () => this.runtimeStatus(),
      get_ffmpeg_runtime_status: () => this.ffmpegStatus(),
      get_sucai_db_status: async () => (await this.db('status')).status,
      get_sucai_storage_status: () => ({library_base_dir: this.storage, db_path: this.dbPath, exists: true}),
      create_sucai_library: () => {const name = String(args.name || '').trim(); if (!name) throw new Error('请输入素材库名称'); const id = 'lib_' + crypto.randomUUID(); return this.db('create', {name, id, root: path.join(this.storage, safeName(name) + '_' + id.slice(-8))});},
      delete_sucai_library: () => this.db('delete_library', args),
      clear_sucai_pending_sources: () => this.db('clear_pending', args),
      update_sucai_material: () => this.db('update_material', args),
      reset_sucai_material_analysis: () => this.db('reset_material', args),
      delete_sucai_material: () => this.db('delete_material', args),
      list_sucai_embedding_items: () => this.db('embedding_items', args),
      save_sucai_embeddings: () => this.db('save_embeddings', args),
      import_sucai_materials: async () => {const files = [...new Set((args.sourcePaths || []).flatMap(p => {p = path.resolve(p); if (!fs.existsSync(p)) throw new Error('素材路径不存在：' + p); this.grant(p); return fs.statSync(p).isDirectory() ? walk(p, mediaType) : mediaType(p) ? [p] : []; }))]; return this.db('import', {libraryId: args.libraryId, items: files.map(file => ({path: file, type: mediaType(file)}))});},
      index_sucai_classified_directory: async () => {const root = path.resolve(args.rootPath); this.grant(root); const scan = await this.script('xycut-sucai-skill', 'scan_library.py', [root, '--db', this.dbPath, '--library-id', args.libraryId, '--library-name', args.libraryName, '--preserve-library-root', '--legacy-cache', ...(this.tool('ffprobe') ? ['--ffprobe', this.tool('ffprobe')] : [])]); return {scan, status: (await this.db('status')).status};},
      update_sucai_storage_dir: () => this.moveStorage(args.newBaseDir),
      scan_builtin_presets: () => this.scanPresets(path.join(this.resources, 'builtin-presets'), args),
       scan_local_presets: () => {const requested = args.customDir || this.settings.preset_dir || path.join(this.dataDir, 'presets'); const root = resolvePresetDirectory(requested); if (!root) return {exists:false, preset_dir:'', presets:[], total_count:0, filtered_count:0}; this.settings.preset_dir = root; write(this.settingsFile, this.settings); this.apiContext = {...this.apiContext, preset_dir:root}; write(path.join(this.dataDir,'api-context.json'), this.apiContext); return this.scanPresets(root, args);},
      scan_online_preset_cache: () => Object.fromEntries(this.presets(path.join(this.dataDir, 'presets')).map(p => [p.folder_name, p.folder_path])),
      scan_video_template_cache: () => Object.fromEntries(this.templates('video_template').templates.map(t => [t.slug, {template_path: t.template_dir, config_path: t.template_config_file}])),
      scan_hot_template_cache: () => Object.fromEntries(this.templates('hot_template').templates.map(t => [t.slug, {template_path: t.template_dir, config_path: t.template_config_file}])),
      list_local_video_templates: () => this.templates('video_template'),
      list_local_hot_templates: () => this.templates('hot_template'),
      save_video_template_config: () => this.saveTemplate('video_template', args),
      save_hot_template_config: () => this.saveTemplate('hot_template', args),
      save_local_preset_as_video_template: () => this.convertPreset('video_template', args),
      save_local_preset_as_hot_template: () => this.convertPreset('hot_template', args),
      delete_local_video_template: () => this.deleteTemplate('video_template', args.slug),
      delete_local_hot_template: () => this.deleteTemplate('hot_template', args.slug),
      install_builtin_preset: () => this.installFolder(path.join(this.resources, 'builtin-presets', safeName(args.folderName)), args.customDir),
      install_imported_presets: async () => {const results = []; for (const source of args.paths || []) results.push(await this.importPreset(source, args.customDir)); return {installed_count: results.length, results, preset_dir: args.customDir || this.settings.preset_dir || path.join(this.dataDir, 'presets')};},
      install_online_preset: () => this.installOnline(args),
      load_local_favorite_preset_index: () => read(path.join(this.dataDir, 'favorite-index.json'), {schema_version: 1, default_group_id: 'default', groups: [{id: 'default', name: '默认收藏', preset_ids: [], created_at: Date.now(), updated_at: Date.now()}], presets: []}),
      get_agent_api_context: () => ({agent_context_file: path.join(this.dataDir, 'agent-context.json'), base_url: `http://127.0.0.1:${this.port}`, enabled: this.apiContext.ai_editing_enabled!==false, port: this.port}),
      save_agent_context_file: () => this.context(args.input),
      update_agent_api_context: async () => {if (args.input.favorite_index) write(path.join(this.dataDir, 'favorite-index.json'), args.input.favorite_index); return this.context(args.input);},
       list_recent_workbench_tasks: () => {const file=path.join(this.dataDir,'workbench-tasks.json'),records=read(file,[]),limit=Math.max(0,Math.min(100,Number(args.limit)||5));return (Array.isArray(records)?records:[]).filter(item=>item&&typeof item==='object'&&item.task_id&&item.task_dir).slice(0,limit).map(item=>({...item,url:`http://127.0.0.1:${this.port}/xycut/${encodeURIComponent(item.task_id)}`}));},
      open_local_folder: () => {const file = path.resolve(args.path); if (!fs.existsSync(file)) throw new Error('路径不存在'); return this.desktop.openPath(file);},
      restart_jianying: () => this.desktop.restartJianying(),
      pack_template_folder: () => this.pack(args.input.presetDir),
      test_template_zip: () => this.testTemplate(args.input),
      match_subtitle_presets: async () => {
        const input = args.input || args;
        const plan = this.resolvePath(input.plan_path || input.plan || '');
        const favoriteIndex = this.resolvePath(input.favorite_index_path || input.favorite_index || path.join(this.dataDir, 'favorite-index.json'));
        const output = this.resolvePath(input.output_path || input.output || path.join(this.dataDir, 'subtitle-match.json'));
        if (!fs.existsSync(plan) || !this.canRead(plan)) throw new Error('字幕计划文件不存在或未登记');
        if (!fs.existsSync(favoriteIndex) || !this.canRead(favoriteIndex)) throw new Error('字幕预设索引不存在或未登记');
        this.grant(output);
        const result = await this.script('xycut-video-template-skill', 'match_subtitle_presets.py', ['--plan', plan, '--favorite-index', favoriteIndex, '--output', output, '--top-k', String(Math.max(1, Number(input.top_k || 5)))]);
        return {...result, output_path: output, plan_path: plan, favorite_index_path: favoriteIndex};
      },
      test_ai_service_api: () => this.testAI(args.input),
      generate_doubao_tts: () => this.generateDoubaoTts(args.input || {}, false),
      generate_doubao_voice_clone: () => this.generateDoubaoTts(args.input || {}, true),
      transcribe_doubao_asr: () => this.transcribeDoubaoAsr(args.input || {}),
      install_ai_runtime: () => this.installAIRuntime(args),
      clear_ai_runtime: () => {this.removeManaged(path.join(this.dataDir,'runtime/python'));this.settings.ai_runtime_disabled=true;write(this.settingsFile,this.settings);return this.runtimeStatus();},
      install_ffmpeg_runtime: async () => {const target=path.join(this.dataDir,'runtime/ffmpeg');if(args.downloadUrl===`http://127.0.0.1:${this.port}/bundled/ffmpeg`)fs.cpSync(path.join(this.resources,'ffmpeg'),target,{recursive:true});else{const zip=await download(args.downloadUrl,path.join(this.cache,'runtime-downloads/ffmpeg.zip'),args.sha256);extract(zip,target);}this.settings.ffmpeg_disabled=false;write(this.settingsFile,this.settings);const result=this.ffmpegStatus();if(!result.installed)throw new Error('下载包不含当前平台的 FFmpeg 和 FFprobe');return result;},
      clear_ffmpeg_runtime: () => {this.removeManaged(path.join(this.dataDir,'runtime/ffmpeg'));this.settings.ffmpeg_disabled=true;write(this.settingsFile,this.settings);return this.ffmpegStatus();},
      clear_cache: () => this.clearCache(args.options || {}),
      reset_local_data: () => this.resetData(args.options || {}),
       download_and_open_update: async () => {const folder=path.join(this.cache,'updates');fs.mkdirSync(folder,{recursive:true});const file = await download(args.url, path.join(folder, safeName(args.fileName)), args.sha256); return this.desktop.openPath(file);},
      upload_share_source: () => this.uploadShare(args),
    };
    if (!commands[name]) throw new Error('未知接口：' + name);
    return commands[name]();
  }
  removeManaged(file) { if (!within(this.dataDir, file) || path.resolve(file) === this.dataDir) throw new Error('拒绝删除数据目录以外路径'); fs.rmSync(file, {recursive: true, force: true}); }
  async uploadShare(args) {
    const base=new URL(args.apiBaseUrl);
    if(base.protocol!=='https:'||!['yushe.neirongpai.com','www.xycut.com','xycut.com'].includes(base.hostname))throw new Error('分享服务地址不受支持');
    if(!args.authToken)throw new Error('请先登录后再上传预设');
    const source=this.resolvePath(args.path);
    if(!fs.existsSync(source))throw new Error('预设路径不存在');
    let file=source;
    if(fs.statSync(source).isDirectory()){
      const packed=this.pack(source);if(!packed.ok)throw new Error('预设含缺失媒体，补齐资源后再上传');file=packed.zip_path;
    }
    if(path.extname(file).toLowerCase()!=='.zip')throw new Error('请选择预设文件夹或 ZIP');
    const form=new FormData();form.append('original_name',path.basename(source));form.append('note',String(args.note||''));form.append('is_original',args.isOriginal?'1':'0');
    form.append('file',new Blob([fs.readFileSync(file)],{type:'application/zip'}),path.basename(file));
    const response=await fetch(new URL('/api/share-uploads',base),{method:'POST',headers:{Authorization:'Bearer '+args.authToken},body:form,signal:AbortSignal.timeout(120000)});
    const data=await response.json();if(!response.ok)throw new Error(data.message||data.error||'预设上传失败：'+response.status);return data;
  }
  deleteTemplate(kind, slug) {this.removeManaged(path.join(this.templateRoot(kind), safeName(slug))); return this.templates(kind);}
  async installFolder(source, customDir) {
    if (!fs.existsSync(source)) throw new Error('预设来源不存在');
    const parent = customDir || this.settings.preset_dir || path.join(this.dataDir, 'presets');
    const target = path.join(parent, safeName(path.basename(source)));
    if (path.resolve(source) !== path.resolve(target)) fs.cpSync(source, target, {recursive: true});
    // Preset metadata from the original package contains absolute Windows paths.
    for (const file of walk(target, f => path.dirname(f) === target && f.endsWith('.json'), 0)) {const metadata = read(file, {}); for (const key of ['cover_path','audio_path']) if (metadata[key]) metadata[key] = path.join(target, path.basename(String(metadata[key]).replace(/\\/g, '/'))); write(file, metadata);}
    this.grant(parent); return {target_path: target, cache_path: target};
  }
  async importPreset(source, customDir) {
    if (fs.statSync(source).isDirectory()) return this.installFolder(source, customDir);
    if (!source.toLowerCase().endsWith('.zip')) throw new Error('请选择预设目录或 ZIP');
    const staging = path.join(this.cache, 'imports', crypto.randomUUID()); extract(source, staging);
    const files = walk(staging, f => path.basename(f) === 'draft_content.json');
    if (!files.length) throw new Error('压缩包内没有剪映草稿');
    return this.installFolder(path.basename(path.dirname(files[0])) === 'preset_draft' ? path.dirname(path.dirname(files[0])) : path.dirname(files[0]), customDir);
  }
  async installOnline(args) {
    const file = await download(args.downloadUrl, path.join(this.cache, 'downloads', crypto.randomUUID() + '.zip'), args.sha256);
    const staging = path.join(this.cache, 'downloads', crypto.randomUUID()); extract(file, staging);
    const draft = walk(staging, f => path.basename(f) === 'draft_content.json')[0];
    if (!draft) throw new Error('下载包没有可读的剪映草稿');
    const source = path.basename(path.dirname(draft)) === 'preset_draft' ? path.dirname(path.dirname(draft)) : path.dirname(draft);
    const parent = args.installKind === 'hot_template' || args.installKind === 'video_template' ? this.templateRoot(args.installKind) : path.join(this.dataDir, 'presets');
    const target = path.join(parent, safeName(args.folderName));
    if (args.installKind === 'hot_template' || args.installKind === 'video_template') {
      const slug = safeName(args.folderName || path.basename(target));
      // Reviewed packages may exclude fixed artwork or carry manually placed
      // title/subtitle slots. Re-analysis would discard those author decisions.
      const configSource = ['template-config.json', 'template_config.json', 'video-template-config.json', 'hot-template-config.json'].map(name => path.join(source, name)).find(fs.existsSync);
      const config = configSource ? JSON.parse(fs.readFileSync(configSource, 'utf8').replace(/^\uFEFF/, '')) : analyzeTemplate(source, args.installKind, slug);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('模板配置须为 JSON 对象');
      fs.cpSync(source, target, {recursive: true});
      const configFile = path.join(target, 'template-config.json');
      write(configFile, {...config, template_slug: slug, template_name: config.template_name || slug, template_dir: target});
      this.grant(target);
      // The original UI uses cache_path/target_path before saving the catalog's
      // config. Keep these native-command fields as well as the list metadata.
      return {...this.templates(args.installKind).templates.find(item => item.slug === slug), cache_path: target, target_path: target, template_dir: target, template_config_file: configFile};
    }
    fs.cpSync(source, target, {recursive: true});
    if (args.syncToJianying) {
      const installed = await this.installFolder(target, args.customDir);
      // Keep both locations in the result.  The XYCut cache is the source used
      // by AI editing, while the personal Jianying directory is the location
      // users reopen in Jianying after restarting it.
      return {...installed, cache_path: target, cache_target_path: target, preset_dir: args.customDir || this.settings.preset_dir || path.join(this.dataDir, 'presets')};
    }
    return {cache_path: target, target_path: target};
  }
  pack(folder) {
    folder = path.resolve(folder); if (!fs.existsSync(folder)) throw new Error('模板目录不存在');
    const Zip=require('adm-zip'),zip=new Zip(),prefix=path.basename(folder);zip.addLocalFolder(folder,prefix);
    const missing=new Set();
    function relink(value){
      if(Array.isArray(value)){value.forEach(relink);return;}
      if(!value||typeof value!=='object')return;
      if(value.materials)for(const list of ['videos','audios','images'])for(const item of value.materials[list]||[]){
        if(!item.path||/^https?:/.test(item.path))continue;
        const clean=String(item.path).replace(/\\/g,'/'),base=path.posix.basename(clean);
        const candidate=[item.path,path.resolve(folder,clean),path.join(folder,'Resources',base)].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
        if(!candidate){missing.add(item.path);continue;}
        const bytes=fs.readFileSync(candidate),name=crypto.createHash('sha256').update(bytes).digest('hex').slice(0,20)+path.extname(base);
        zip.addFile(prefix+'/Resources/'+name,bytes);item.path='Resources/'+name;
      }
      Object.values(value).forEach(relink);
    }
    for(const file of walk(folder,f=>['draft_content.json','template.tmp','template-2.tmp'].includes(path.basename(f)))){
      let draft;try{draft=JSON.parse(fs.readFileSync(file,'utf8'));}catch{continue;}relink(draft);zip.addFile(prefix+'/'+path.relative(folder,file).split(path.sep).join('/'),Buffer.from(JSON.stringify(draft)));
    }
    const output=path.join(this.cache,'exports',safeName(prefix)+'.zip');fs.mkdirSync(path.dirname(output),{recursive:true});zip.writeZip(output);
    return {ok:missing.size===0,zip_path:output,file_path:output,size_bytes:fs.statSync(output).size,missing_resources:[...missing],message:missing.size?'打包完成，但有缺失的媒体资源。':'模板与可访问媒体资源已打包。'};
  }
  async moveStorage(newBase) {
    newBase = path.resolve(newBase); if (newBase === this.storage) return this.invoke('get_sucai_storage_status');
    if (within(this.storage, newBase) || within(newBase, this.storage)) throw new Error('新旧素材目录不能互相包含');
    if (fs.existsSync(newBase) && fs.readdirSync(newBase).length) throw new Error('请选择空目录，避免覆盖素材');
    const oldRoot=this.storage;
    fs.cpSync(oldRoot,newBase,{recursive:true});
    await this.db('move_storage',{old_root:oldRoot,new_root:newBase});
    this.storage=newBase;this.settings.storage_dir=newBase;write(this.settingsFile,this.settings);this.grant(newBase);
    await this.context();
    return {library_base_dir:newBase,db_path:this.dbPath,exists:true,previous_base_dir:oldRoot,old_files_preserved:true,status:(await this.db('status')).status};
  }
  async testTemplate(input) {
    if(!input || !['hot_template','video_template'].includes(input.templateType))throw new Error('请选择模板类型');
    const staging=path.join(this.cache,'template-tests',crypto.randomUUID());fs.mkdirSync(staging,{recursive:true});
    const source=path.resolve(input.zipPath);if(fs.statSync(source).isDirectory())fs.cpSync(source,staging,{recursive:true});else extract(source,staging);
    const file=walk(staging,f=>path.basename(f)==='draft_content.json')[0];if(!file)throw new Error('模板包没有可读草稿');
    const folder=path.basename(path.dirname(file))==='preset_draft'?path.dirname(path.dirname(file)):path.dirname(file);
    const kind=input.templateType;
    const existing=walk(folder,f=>['template-config.json','template_config.json','video-template-config.json','hot-template-config.json'].includes(path.basename(f)))[0];
    const config=existing?read(existing):analyzeTemplate(folder,kind,path.basename(folder));
    const configFile=path.join(folder,'template-config.json');write(configFile,config);
    let plan;
    if(kind==='video_template'){
      if(!input.mp4File||!input.srtFile)throw new Error('视频模板测试需要 MP4 和 SRT');
      const planFile=path.join(staging,'task/output/video_template_plan.json');
      await this.script('xycut-video-template-skill','prepare_video_template_plan.py',['--template-dir',folder,'--template-config-file',configFile,'--draft-output-dir',input.draftOutputDir,'--mp4-file',input.mp4File,'--srt-file',input.srtFile,'--draft-name','XYCut_模板测试','--output',planFile]);
      plan=read(planFile);
      plan.titles=(config.title_slots||[]).map(slot=>slot.sample_text||slot.original_text||'标题测试');
    }else{
      plan={draft_name:'XYCut_爆款模板测试',text_replacements:(config.text_slots||[]).map(t=>({slot_index:t.index,text:t.sample_text||t.original_text||'模板测试'})),media_replacements:[]};
      if(input.materialDir){const files=walk(input.materialDir,mediaType);for(const slot of config.media_slots||[]){const file=files.find(f=>mediaType(f)===(slot.material_type==='photo'?'image':slot.material_type));if(!file)throw new Error('没有适合素材槽 '+slot.index+' 的媒体');let metadata={};if(this.tool('ffprobe'))metadata=JSON.parse(await run(this.tool('ffprobe'),['-v','error','-show_entries','stream=width,height:format=duration','-of','json',file]));const stream=metadata.streams?.[0]||{};plan.media_replacements.push({slot_index:slot.index,file_path:file,type:mediaType(file),width:stream.width,height:stream.height,duration_ms:Math.round(Number(metadata.format?.duration||0)*1000)});}}
    }
    return this.generate({mode:kind,template_dir:folder,template_config_file:configFile,draft_output_dir:input.draftOutputDir,generation_plan:plan});
  }
  async testAI(input) {
    const parameters = this.parameters(input.parameters), type = input.service_type;
    parameters.api_key=parameters.api_key||parameters.apikey||parameters.key||parameters['x-api-key'];
    if (type === 'pexels') {const response = await fetch('https://api.pexels.com/v1/search?query=nature&per_page=1', {headers: {Authorization: parameters.api_key || parameters.apiKey || ''}, signal: AbortSignal.timeout(20000)}); if (!response.ok) throw new Error('Pexels 接口校验失败：' + response.status); return {ok: true, message: 'Pexels 连接成功'};}
    if (type === 'doubao_llm') {
      const key=String(parameters.api_key||'').trim();if(!key)throw new Error('请输入 API Key');
      const model=parameters.model||parameters.endpoint_id||'doubao-embedding-vision-251215';
      const endpoint=parameters.base_url||'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal';
      const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,input:[{type:'text',text:'连接测试'}]}),signal:AbortSignal.timeout(30000)});
      let data;try{data=await response.json();}catch{throw new Error('豆包接口返回的内容不是 JSON：'+response.status);}
      if(!response.ok)throw new Error(data?.error?.message||data?.message||'豆包接口校验失败：'+response.status);
      const vector=data?.embedding||data?.data?.embedding||data?.data?.[0]?.embedding||(Array.isArray(data?.data)&&data.data.every(Number.isFinite)?data.data:undefined);
      if(!Array.isArray(vector)||!vector.length||!vector.every(Number.isFinite))throw new Error('豆包向量模型未返回有效向量');
      return {ok:true,message:'豆包多模态向量模型连接成功'};
    }
    if(type==='doubao_speech'){
      const root=path.join(this.cache,'requests',crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
      const contextFile=path.join(root,'context.json'),textFile=path.join(root,'text.txt');
      write(contextFile,{third_party_apis:[{type:'doubao_speech',parameters:input.parameters}]});fs.writeFileSync(textFile,'连接测试');
      try{const result=await this.script('xycut-video-template-skill','generate_doubao_tts.py',['--agent-context-file',contextFile,'--text-file',textFile,'--output-audio',path.join(root,'test.mp3'),'--output-timestamps',path.join(root,'timestamps.json')]);return {...result,message:'豆包语音连接成功'};}finally{this.removeManaged(contextFile);}
    }
    throw new Error('未知 AI 服务类型：'+type);
  }
  speechContext(input = {}, root) {
    const context = read(path.join(this.dataDir, 'agent-context.json'), {});
    const speech = input.speech && typeof input.speech === 'object' ? input.speech : {};
    const savedSpeech = context.speech || {};
    context.speech = {...savedSpeech, ...speech};
    if (speech.tts && typeof speech.tts === 'object') context.speech.tts = {...(savedSpeech.tts || {}), ...speech.tts};
    if (speech.asr && typeof speech.asr === 'object') context.speech.asr = {...(savedSpeech.asr || {}), ...speech.asr};
    if (input.parameters) context.third_party_apis = [{type:'doubao_speech', parameters:input.parameters}];
    const file = path.join(root, 'agent-context.json');
    write(file, context);
    return file;
  }
  speechOutput(input, key, fallback) {
    const task = input.task_dir ? this.resolvePath(input.task_dir) : null;
    const value = input[key] || (task ? path.join(task, fallback) : '');
    if (!value) throw new Error(`缺少 ${key} 或 task_dir`);
    const file = this.resolvePath(value);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    this.grant(path.dirname(file));
    return file;
  }
  async generateDoubaoTts(input = {}, clone = false) {
    if (!input || typeof input !== 'object') throw new Error('语音参数无效');
    const root = path.join(this.cache, 'requests', crypto.randomUUID()); fs.mkdirSync(root, {recursive:true});
    try {
    const contextFile = this.speechContext(input, root);
    const textFile = input.text_file ? this.resolvePath(input.text_file) : path.join(root, 'script.txt');
    if (input.text_file && !fs.existsSync(textFile)) throw new Error('配音文案文件不存在');
    if (!input.text_file) { const text = String(input.text || '').trim(); if (!text) throw new Error('配音文案为空'); fs.writeFileSync(textFile, text, 'utf8'); }
    const outputAudio = this.speechOutput(input, 'output_audio', 'input/source.mp3');
    const outputTimestamps = this.speechOutput(input, 'output_timestamps', 'speech/tts.raw.json');
    const args = ['--agent-context-file', contextFile, '--text-file', textFile, '--output-audio', outputAudio, '--output-timestamps', outputTimestamps];
    if (input.raw_output) args.push('--raw-output', this.resolvePath(input.raw_output));
    const voiceId = input.voice_id || input.voiceId;
    if (clone && !String(voiceId || '').trim()) throw new Error('声音复刻需要提供已开通的音色 ID');
    if (voiceId) args.push('--voice-id', String(voiceId));
    if (input.resource_id) args.push('--resource-id', String(input.resource_id));
    if (input.speech_rate !== undefined) args.push('--speech-rate', String(input.speech_rate));
    if (input.volume !== undefined) args.push('--volume', String(input.volume));
      const result = await this.script('xycut-video-template-skill', 'generate_doubao_tts.py', args);
      return {...result, mode: clone ? 'voice_clone' : 'tts', voice_id: voiceId || undefined, audio_file: outputAudio, timestamps_file: outputTimestamps};
    } finally { this.removeManaged(root); }
  }
  async transcribeDoubaoAsr(input = {}) {
    if (!input || typeof input !== 'object' || !input.input_media) throw new Error('缺少 input_media');
    const inputMedia = this.resolvePath(input.input_media); if (!fs.existsSync(inputMedia)) throw new Error('输入媒体不存在');
    const root = path.join(this.cache, 'requests', crypto.randomUUID()); fs.mkdirSync(root, {recursive:true});
    try {
    const contextFile = this.speechContext(input, root);
    const outputJson = this.speechOutput(input, 'output_json', 'speech/asr.raw.json');
    const outputSrt = this.speechOutput(input, 'output_srt', 'output/voice.srt');
    const args = ['--agent-context-file', contextFile, '--input-media', inputMedia, '--output-json', outputJson, '--output-srt', outputSrt];
    if (input.output_segments_json || input.task_dir) args.push('--output-segments-json', this.speechOutput(input, 'output_segments_json', 'speech/segments.json'));
    if (input.source_text_file) args.push('--source-text-file', this.resolvePath(input.source_text_file));
    if (input.mode) args.push('--mode', String(input.mode));
    if (input.poll_interval !== undefined) args.push('--poll-interval', String(input.poll_interval));
    if (input.max_attempts !== undefined) args.push('--max-attempts', String(input.max_attempts));
    if (input.ffmpeg) args.push('--ffmpeg', this.resolvePath(input.ffmpeg));
      const result = await this.script('xycut-video-template-skill', 'transcribe_volcengine_asr.py', args);
      return {...result, asr_json: outputJson, srt_file: outputSrt};
    } finally { this.removeManaged(root); }
  }
  async installAIRuntime(args) {
    const staging=path.join(this.cache,'runtime-downloads',crypto.randomUUID());fs.mkdirSync(staging,{recursive:true});
    const bundled=!args.downloadUrl||args.downloadUrl===`http://127.0.0.1:${this.port}/bundled/python`;
    if(bundled)fs.cpSync(path.join(this.resources,'python'),staging,{recursive:true,verbatimSymlinks:true});
    else {const archive=await download(args.downloadUrl,staging+'.zip',args.sha256);extract(archive,staging);}
    const name=process.platform==='win32'?'python.exe':'python3.9';
    const executable=walk(staging,file=>path.basename(file)===name)[0];if(!executable)throw new Error('运行包不含当前平台的 Python 3.9');
    const version=await run(executable,['--version']);if(!version.startsWith('Python 3.9.'))throw new Error('恢复核心需要 CPython 3.9，下载运行库版本不兼容');
    const source=process.platform==='win32'?path.dirname(executable):path.dirname(path.dirname(executable));
    const target=path.join(this.dataDir,'runtime/python');this.removeManaged(target);fs.cpSync(source,target,{recursive:true,verbatimSymlinks:true});
    this.settings.ai_runtime_disabled=false;write(this.settingsFile,this.settings);return this.runtimeStatus();
  }
  parameters(input) {return Object.fromEntries((Array.isArray(input)?input.map(p=>[p.key,p.value]):Object.entries(input||{})).map(([key,value])=>[String(key).toLowerCase(),value]));}
  clearCache(options) {const mapping={update_packages:'updates',preset_temp_files:'imports',runtime_downloads:'runtime-downloads',template_tests:'template-tests',ai_editing_requests:'requests',backups:'backups'};for(const[flag,folder]of Object.entries(mapping))if(options[flag])this.removeManaged(path.join(this.cache,folder));if(options.agent_context)this.removeManaged(path.join(this.dataDir,'agent-context.json'));if(options.workbench_records){this.removeManaged(path.join(this.dataDir,'workbench-tasks.json'));}return '已清理选中的缓存。';}
  resetData(options) {const mapping={hot_templates:'hot-templates',local_hot_templates:'hot-templates',video_templates:'video-templates',local_video_templates:'video-templates',subtitle_presets:'subtitle-presets',presets:'presets',python_runtime:'runtime/python',ffmpeg_runtime:'runtime/ffmpeg'};for(const[flag,folder]of Object.entries(mapping))if(options[flag])this.removeManaged(path.join(this.dataDir,folder));if(options.python_runtime)this.settings.ai_runtime_disabled=true;if(options.ffmpeg_runtime)this.settings.ffmpeg_disabled=true;if(options.python_runtime||options.ffmpeg_runtime)write(this.settingsFile,this.settings);return '已重置选中的本地数据。';}
}
module.exports = {Service, mediaType, resolvePresetDirectory};
