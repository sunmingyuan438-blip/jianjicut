const {createBroker} = require('./broker.cjs');
const {MysqlStore} = require('./store.cjs');
function configuration(env) {
  const required = ['DATABASE_URL','AIGZM_PUBLIC_URL','AIGZM_API_ORIGIN','AIGZM_AUTHORIZATION_UI_ORIGIN','AIGZM_CLIENT_ID','AIGZM_CLIENT_SECRET','AIGZM_EXPECTED_ISSUER','AIGZM_ENVIRONMENT','ZHANGMEN_SESSION_KEY'];
  if (required.some(name => !env[name])) throw new Error('平台账户服务缺少必要环境变量');
  if (!['sandbox','production'].includes(env.AIGZM_ENVIRONMENT) || env.AIGZM_CLIENT_ID.startsWith('sbx_') !== (env.AIGZM_ENVIRONMENT === 'sandbox')) throw new Error('应用环境与 Client ID 不一致');
  const key = Buffer.from(env.ZHANGMEN_SESSION_KEY, 'base64');
  if (key.length !== 32 || key.toString('base64') !== env.ZHANGMEN_SESSION_KEY) throw new Error('ZHANGMEN_SESSION_KEY 必须是 32 字节的标准 Base64');
  const memberPolicy = JSON.parse(env.ZHANGMEN_MEMBER_POLICY || '{"local_edit":1,"template_apply":1,"draft_export":1,"ai_invoke":0}'), models = JSON.parse(env.ZHANGMEN_MODELS || '{}');
  for (const [name,value] of Object.entries(memberPolicy)) if (!['template_apply','draft_export','local_edit','ai_invoke'].includes(name) || !Number.isInteger(value) || value < 0 || value > 4) throw new Error('会员门槛配置无效');
  for (const [name,value] of Object.entries(models)) if (!['analyze','embedding','asr_short','asr_long','image'].includes(name) || typeof value !== 'string' || !/^[\w.-]{1,128}$/.test(value)) throw new Error('模型映射配置无效');
  return {key,publicUrl:env.AIGZM_PUBLIC_URL,idpWebUrl:env.AIGZM_AUTHORIZATION_UI_ORIGIN,idpApiUrl:env.AIGZM_API_ORIGIN,clientId:env.AIGZM_CLIENT_ID,clientSecret:env.AIGZM_CLIENT_SECRET,
    returnUris:JSON.parse(env.ZHANGMEN_DESKTOP_RETURN_URIS || '["http://127.0.0.1:17652/account/sso/callback"]'),
    cloud:{expectedIssuer:env.AIGZM_EXPECTED_ISSUER,memberPolicy,models,billingReturnUri:env.AIGZM_BILLING_RETURN_URI || ''}};
}
async function start(env = process.env) {
  const config = configuration(env);
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool(env.DATABASE_URL);
  const store = new MysqlStore({pool,key:config.key,namespace:config.cloud.expectedIssuer+':'+config.clientId});
  let initialized = false;
  const path=require('node:path'),fs=require('node:fs'),webRoot=path.join(__dirname,'../web');
  const webHost=fs.existsSync(path.join(webRoot,'frontend'))?require('./web.cjs').createWebHost({root:webRoot,frontend:path.join(webRoot,'frontend')}):null;
  const server = createBroker({...config,store,ready:()=>initialized,webHost});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(env.PORT || 8080),'0.0.0.0',resolve);});
  console.log('掌门cut平台服务已监听；正在准备独立数据表');
  store.init().then(()=>{initialized=true;console.log('掌门cut平台服务已就绪');}).catch(()=>{console.error('数据存储准备失败，请检查应用专属数据库；不输出连接信息');server.close();void store.close().catch(()=>{});process.exitCode=1;});
  process.once('SIGTERM',()=>{initialized=false;server.close(()=>store.close().then(()=>process.exit(0),()=>process.exit(1)));setTimeout(()=>process.exit(0),9000).unref();});
  return server;
}
if(require.main===module)start().catch(()=>{console.error('平台账户服务启动失败，请检查必要环境变量、HTTPS 地址及数据库配置；不输出配置内容');process.exitCode=1;});
module.exports={configuration,start};
