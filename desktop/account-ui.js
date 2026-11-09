(() => {
  if (document.getElementById('zm-account-button')) return;
  const invoke = name => window.xycutDesktop.invoke('account_sso_' + name, {});
  const button = document.createElement('button');
  button.id = 'zm-account-button'; button.type = 'button'; button.textContent = 'AI超市账户';
  button.setAttribute('aria-label', 'AI超市账户');
  const modal = document.createElement('dialog'); modal.id = 'zm-account-dialog';
  modal.setAttribute('aria-labelledby', 'zm-account-title');
  const title = document.createElement('h2'); title.id = 'zm-account-title'; title.textContent = 'AI 超市账户';
  const note = document.createElement('p'); note.textContent = '使用 AI 超市的同一账户，在浏览器中安全登录。';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const profile = document.createElement('p');
  const wallet = document.createElement('p');
  const storage = document.createElement('p'); storage.className = 'zm-account-note';
  const actions = document.createElement('div'); actions.className = 'zm-account-actions';
  const login = document.createElement('button'); login.textContent = '使用 AI 超市登录';
  const refresh = document.createElement('button'); refresh.textContent = '刷新账户';
  const logout = document.createElement('button'); logout.textContent = '退出账户';
  const recharge = document.createElement('button');recharge.textContent='充值积分';
  const membership = document.createElement('button');membership.textContent='会员中心';
  const close = document.createElement('button'); close.textContent = '关闭';
  actions.append(login, refresh, recharge, membership, logout, close);
  modal.append(title, note, status, profile, wallet, storage, actions);
  document.body.append(button, modal);
  let timer, busy = false, current;
  function paint(value) {
    current = value;
    status.textContent = value.pending ? '已打开浏览器，等待登录完成…' : value.message || (value.authenticated ? '已登录' : '尚未登录');
    profile.textContent = value.profile ? `${value.profile.phone || value.profile.sub}` : '';
    wallet.textContent=value.account?.wallet?'可用积分：'+String(value.account.wallet.available??value.account.wallet.balance??'未知'):'';
    const level=value.account?.membership?.member_level??value.profile?.member_level;
    if(level!==undefined&&level!==null)profile.textContent+=' · 会员等级：L'+level;
    storage.textContent = value.authenticated && !value.persistent ? '此设备未启用安全会话保存，关闭软件后需要重新登录。' : value.platform_mode?'AI 调用扣除当前账户积分；本地套模板和草稿导出校验会员权限。':'统一账户服务尚未配置。';
    recharge.hidden=membership.hidden=!value.authenticated||!value.cloud;recharge.disabled=membership.disabled=busy;
    login.hidden = value.authenticated; login.disabled = busy || !value.configured || value.pending;
    refresh.hidden = !value.authenticated; refresh.disabled = busy;
    logout.hidden = !value.has_session && !value.pending; logout.disabled = busy;
    logout.textContent = value.pending ? '取消登录' : '退出账户';
    button.textContent = value.authenticated ? 'AI超市 · 已登录' : 'AI超市账户';
    clearTimeout(timer);
    if (value.pending && modal.open) timer = setTimeout(() => perform('status'), 1500);
  }
  async function perform(action) {
    if (busy) return;
    busy = true; if (current) paint(current);
    try { if(action==='billing-recharge'||action==='billing-membership'){await window.xycutDesktop.invoke('account_sso_billing',{intent:action==='billing-recharge'?'recharge':'membership'});status.textContent='已打开 AI 超市页面，完成后点击刷新账户。';}else paint(await invoke(action)); }
    catch (error) { status.textContent = error.message || '账户操作失败，请重试'; }
    finally { busy = false; if (current) {login.disabled = !current.configured || current.pending; refresh.disabled = logout.disabled = recharge.disabled = membership.disabled = false;} }
  }
  button.addEventListener('click', () => { modal.showModal(); perform('status'); });
  login.addEventListener('click', () => perform('login'));
  refresh.addEventListener('click', () => perform('refresh'));
  logout.addEventListener('click', () => perform('logout'));
  recharge.addEventListener('click',()=>perform('billing-recharge'));
  membership.addEventListener('click',()=>perform('billing-membership'));
  close.addEventListener('click', () => modal.close());
  modal.addEventListener('close', () => { clearTimeout(timer); button.focus(); });
  perform('status');
})();
