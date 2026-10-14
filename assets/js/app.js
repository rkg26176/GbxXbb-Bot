/* ═══════════════════════════════════════════════════════════════
   BigBasket Mini — app.js
   Wire layer (verbatim) + state + gate/auth + router + 5 tab modules
   ═══════════════════════════════════════════════════════════════ */

/* ════════ VERBATIM WIRE LAYER (do not change) ════════ */
async function encryptPayload(obj){const iv=crypto.getRandomValues(new Uint8Array(12)),k=crypto.getRandomValues(new Uint8Array(16)),p=new TextEncoder().encode(JSON.stringify(obj)),ck=await crypto.subtle.importKey('raw',k,'AES-GCM',false,['encrypt']),ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},ck,p),pk=new Uint8Array(iv.length+k.length+ct.byteLength);pk.set(iv,0);pk.set(k,iv.length);pk.set(new Uint8Array(ct),iv.length+k.length);return btoa(String.fromCharCode(...pk))}
async function decryptPayload(b64){const b=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)),ck=await crypto.subtle.importKey('raw',b.slice(12,28),'AES-GCM',false,['decrypt']),p=await crypto.subtle.decrypt({name:'AES-GCM',iv:b.slice(0,12)},ck,b.slice(28));return JSON.parse(new TextDecoder().decode(p))}
const API='/tata_bb_api_v2/';
const GAME_API=API+'games/';
async function gameCall(op,data){return apiCall(op,data,GAME_API);}
/* Global busy overlay — blocks input while a request is in flight (slow proxy calls), so quick
   repeated clicks can't double-fire. Ref-counted; a short delay avoids flashing on fast calls. */
let _busyN=0,_busyTimer=null;
function pushBusy(){ _busyN++; if(_busyN===1 && !_busyTimer){ _busyTimer=setTimeout(()=>{ _busyTimer=null; if(_busyN>0){ const ov=document.getElementById('busyOverlay'); if(ov) ov.classList.add('on'); } },130); } }
function popBusy(){ _busyN=Math.max(0,_busyN-1); if(_busyN===0){ if(_busyTimer){ clearTimeout(_busyTimer); _busyTimer=null; } const ov=document.getElementById('busyOverlay'); if(ov) ov.classList.remove('on'); } }

async function apiCall(op,payload,customApi){
  // Bulk Orders drives its own progress UI, so mute the shared busy overlay + auto error-toasts
  // for every op while a batch runs (S._poBusy) — otherwise each per-account step flashes/spams.
  const silent = (op==='bb_cart_preload' || op==='bb_app_data' || S._poBusy);   // background loads — no UI blocking
  if(!silent) pushBusy();
  try{
    const url=(customApi||API)+'?accesscode='+accessCode;
    const enc=await encryptPayload(payload),resp=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({op,session_key:sessionKey,data:enc})}),json=await resp.json();
    if(resp.status===401){ return handleSessionLost(); }   // handshake token / server session expired
    if(json.logs?.length)json.logs.forEach(l=>{ try{ console.debug('[bb]', l.ok?'ok':'err', l.message); }catch(e){} });  // backend diagnostics → console, not toasts
    if(json.op==='pong')return null;
    const decoded=await decryptPayload(json.data);
    if(decoded.message && !S._poBusy)log(decoded.message,decoded.ok?'success':'error');   // single auto error-toast (de-duped vs explicit showToast); muted during a Bulk Orders batch
    if(decoded.next_op==='require_access'){ return handleSessionLost(); }
    return{op:json.op,decoded};
  } catch(e){
    // Network drop, non-JSON gateway (502/504/HTML), or a decrypt throw — never let the promise
    // reject (an unhandled rejection strands callers that re-enable a button only after a resolved
    // await, e.g. the coupon OTP flow). Surface one error toast and return null; every caller
    // already treats null as failure.
    try{ console.debug('[bb] apiCall failed', op, e); }catch(_){}
    if(!S._poBusy) showToast('Network error — please try again.','error');
    return null;
  } finally { if(!silent) popBusy(); }
}

/* Session lost — the server session was garbage-collected or the handshake token expired.
   Self-heal WITHOUT a manual reopen: if this device has a stored access code, reload once (mints a
   fresh token) — the boot handler then re-submits the code silently. A 15s guard prevents reload
   loops; if we truly can't renew, fall back to the manual gate. */
function handleSessionLost(){
  let code=''; try{ code=localStorage.getItem('bb_ac')||''; }catch(e){}
  let last=0; try{ last=+sessionStorage.getItem('bb_renew_at')||0; }catch(e){}
  if(code && (Date.now()-last)>15000){
    try{ sessionStorage.setItem('bb_renew_at', String(Date.now())); }catch(e){}
    location.reload();          // fresh page → fresh token → boot auto-submits the stored code
    return null;
  }
  ['loginScreen','sheetOverlay','topbar','bottomNav','mainHdr','sc'].forEach(id=>{const e=document.getElementById(id); if(e) e.style.display='none';});
  const g=document.getElementById('accessGate'); if(g) g.style.display='flex';
  const ge=document.getElementById('gate_err'); if(ge) ge.textContent='Session expired — re-enter your access code.';
  return null;
}

/* Keep the ACTIVE account's csurftoken fresh so CSRF-protected writes (address save, cart, checkout)
   never hit BB's ~5-10 min token TTL. Fires bb_app_data (which reseeds csurftoken) SILENTLY every 4
   minutes while an account is active, plus whenever the app returns to the foreground. No UI, no
   user action — the token in that account's session is replaced under the hood before it can go stale. */
let _csurfTimer=null, _csurfAt=0;
function refreshCsurf(){
  if(!S.encData) return;                        // only while an account is active
  if(Date.now()-_csurfAt < 60000) return;       // throttle: at most once/min
  _csurfAt=Date.now();
  apiCall('bb_app_data',{encData:S.encData}).then(r=>{ if(r&&r.decoded&&r.decoded.encData) S.encData=r.decoded.encData; }).catch(()=>{});
}
function startCsurfKeepAlive(){
  if(_csurfTimer) clearInterval(_csurfTimer);
  _csurfTimer=setInterval(refreshCsurf, 300000);   // 5 min — comfortably under BB's ~10 min csurftoken TTL
}

/* ════════ SEARCH TRANSPORT (verbatim) — direct GET to proxy.php ════════ */
const PROXY_URL = './bigbasket/proxy.php';
async function proxyGet(params, latLng){
  let processedLatLng = latLng || '';
  if (processedLatLng){ processedLatLng = processedLatLng.replace(/=+$/, ''); processedLatLng = processedLatLng + '=='; }
  // Always carry the CURRENT mode's entry context so search/term reflect a BB Now⇄Scheduled toggle
  // immediately (proxy.php prefers these over the session value).
  const qs = new URLSearchParams({ ...params, entry_context:S.modeCtx, entry_context_id:ECID() }).toString() + '&lat_lng=' + processedLatLng;
  const res = await fetch(`${PROXY_URL}?${qs}`, { credentials:'include' });
  return res.json();
}

/* ════════ GLOBAL STATE ════════ */
const S = {
  access: null,          // {code, role, balance, per_order_limit}
  accounts: [],          // list_accounts_by_code rows
  activePhone: null,
  encData: null,         // active per-account login blob (round-tripped on every BB op)
  latLng: '',            // base64 lat|lng from login chain
  loginMethod: 'bb',     // 'bb' | 'tn'
  orderType: 'Quick',    // 'Quick' | 'Scheduled'
  modeCtx: 'bbnow',      // 'bbnow' (10) | 'bb-b2c' (100)
  cart: new Map(),       // pid -> {pid,fcid,desc,sp,qty,img,w}
  loggedIn: false,
  // search
  searchSlug:'', searchPage:1, searchTotalPages:1, searchHasMore:false, searchLoading:false,
  searchSort:'', searchFilters:[],           // applied sort + filters ([{type,name,values[],level}])
  searchSortOpts:[], searchFilterOpts:[],    // definitions from the page-1 response
  searchTotalCount:0,
  // checkout transient
  checkout:null,
};
const ECID = ()=> S.modeCtx==='bb-b2c' ? 100 : 10;

/* ════════ DOM HELPERS ════════ */
const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const el = (tag,cls,html)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;};
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&','<':'<','>':'>','"':'"'}[c]));
const inr = n => '₹'+(Math.round((+n||0)*100)/100).toLocaleString('en-IN');
const initials = n => (String(n||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('')||'?').toUpperCase();
const delay = ms => new Promise(r=>setTimeout(r,ms));

/* ════════ TOAST + LOG (apiCall depends on log()) ════════ */
let _lastToast={msg:'',at:0};
function showToast(msg,type='info'){
  if(!msg || type!=='error') return;          // only surface real errors — suppress success/info noise
  const now=Date.now();
  if(msg===_lastToast.msg && now-_lastToast.at<2500) return;   // de-dupe: same error within 2.5s = one toast
  _lastToast={msg, at:now};
  const root=$('#toastRoot'); if(!root) return;
  const t=el('div','toast err',esc(msg));
  root.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),300);},2600);
}
function log(msg,type='info'){ if(type==='error') showToast(msg,type); /* sink — info/success suppressed */ }

/* ════════ BOTTOM SHEET (with back-navigation) ════════ */
let _sheetBack=null;
function openSheet(title, render, backFn){
  $('#sheet_title').textContent = title;
  const body=$('#sheet_body'); body.innerHTML='';
  $('#sheetOverlay').style.display='flex';
  _sheetBack = (typeof backFn==='function') ? backFn : null;
  const x=$('#sheet_x'); if(x){ x.textContent = _sheetBack ? '‹' : '✕'; x.title = _sheetBack ? 'Back' : 'Close'; }
  if(typeof render==='function') render(body);
  else if(render instanceof Node) body.appendChild(render);
}
function sheetDismiss(){ const b=_sheetBack; _sheetBack=null; if(b) b(); else closeSheet(); }   // ‹ goes back, ✕ closes
function closeSheet(){ _sheetBack=null; try{ clearTimeout(_pollTimer); _pollTimer=null; }catch(e){} $('#sheetOverlay').style.display='none'; $('#sheet_body').innerHTML=''; }
function sheetBody(){ return $('#sheet_body'); }
function getLineItems(ord){
  const items=[]; const grp=ord.line_items_grp;
  if(grp && typeof grp==='object'){ Object.keys(grp).forEach(k=>{ if(grp[k] && grp[k].line_items) items.push(...grp[k].line_items); }); }
  if(Array.isArray(ord.items)){ ord.items.forEach(cat=>{ if(cat && cat.line_items) items.push(...cat.line_items); else if(cat && (cat.desc||cat.description)) items.push(cat); }); }
  return items;
}
function statusStep(status){
  const s=String(status||'').toLowerCase();
  if(/deliver|complete|arrived/.test(s)) return 3;
  if(/out.?for|dispatch|shipped|on.?the.?way/.test(s)) return 2;
  if(/pack|process|prepar/.test(s)) return 1;
  return 0;
}

/* Landing "just ordered" social proof — public op, no session/encryption. Shows a live "x ago". */
let _lo=null;
async function loadLastOrder(){
  try{
    const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'last_order_info'})});
    const d=await r.json();
    if(!(d && d.has_order)) return;
    _lo={ name:d.masked_name||'Someone', phone:d.masked_phone||'', baseAgo:parseInt(d.ago), baseTs:Date.now() };
    paintLastOrder();
    clearInterval(window._loTimer); window._loTimer=setInterval(paintLastOrder, 1000);
  }catch(e){}
}
/* Human "x ago" from a seconds count. */
function agoText(sec){
  sec=parseInt(sec); if(!isFinite(sec)||sec<0) return '';
  if(sec<5)  return 'just now';
  if(sec<60) return sec+'s ago';
  const m=Math.floor(sec/60); if(m<60) return m+' min ago';
  const h=Math.floor(m/60);   if(h<24) return h+' hr ago';
  const dys=Math.floor(h/24); return dys+' day'+(dys>1?'s':'')+' ago';
}
function paintLastOrder(){
  const el=document.getElementById('lastOrder'); if(!el||!_lo) return;
  el.style.display='flex';
  if(el.offsetParent===null){ clearInterval(window._loTimer); return; }   // gate hidden → stop ticking
  const elapsed = isFinite(_lo.baseAgo) ? _lo.baseAgo + Math.floor((Date.now()-_lo.baseTs)/1000) : NaN;
  const when = agoText(elapsed);
  el.innerHTML=`<span class="lo-dot"></span><span><b>${esc(_lo.name)}</b> (${esc(_lo.phone)}) just placed an order ✅${when?` · ${when}`:''}</span>`;
}

/* ════════ INIT ════════ */
document.addEventListener('DOMContentLoaded', ()=>{
  // gate
  $('#gate_btn').addEventListener('click', submitGate);
  $('#gate_code').addEventListener('keydown', e=>{ if(e.key==='Enter') submitGate(); });
  // Silent renew: if this device validated a code before, re-submit it automatically on load
  // (fresh WebView / after a session-expiry reload) so the user never re-types it.
  try{ const _sc=localStorage.getItem('bb_ac'); if(_sc){ $('#gate_code').value=_sc; submitGate(); } }catch(e){}
  startCsurfKeepAlive();   // silent 4-min csurftoken refresh for the active account
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible'){ refreshCsurf(); refreshAccessBalance(); } });
  loadLastOrder();   // social-proof "just ordered" badge on the landing (public, no session)
  // sheet close
  $('#sheet_x').addEventListener('click', sheetDismiss);
  $('#sheetOverlay').addEventListener('click', e=>{ if(e.target.id==='sheetOverlay') closeSheet(); });
  // login wiring
  wireLogin();
  // top bar — theme toggle stays on the bar; Profile opens only when an account is chosen
  $('#theme_dot').addEventListener('click', ()=>document.body.classList.toggle('theme-alt'));
  $('#tb_profile').addEventListener('click', profileOrPicker);
  { const bb=$('#tb_bal'); if(bb) bb.addEventListener('click', ()=>refreshAccessBalance()); }
  { const lo=$('#tb_logout'); if(lo) lo.addEventListener('click', ()=>{ if(confirm('Log out and end this session? You can then enter another access code.')) logoutAndReset(); }); }
  const tbLeft=document.querySelector('.tb-left'); if(tbLeft){ tbLeft.style.cursor='pointer'; tbLeft.addEventListener('click', profileOrPicker); }
  $$('#mode_seg .seg-opt').forEach(b=>b.addEventListener('click',async ()=>{
    $$('#mode_seg .seg-opt').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const m=b.dataset.mode;
    S.modeCtx = m==='scheduled' ? 'bb-b2c' : 'bbnow';
    S.orderType = m==='scheduled' ? 'Scheduled' : 'Quick';
    document.body.classList.toggle('bbnow', S.modeCtx==='bbnow');
    showToast(m==='scheduled'?'Scheduled mode':'BB Now mode');
    // Tell the backend to switch entry context (bbnow⇄bb-b2c) and re-establish the serviceable area,
    // so search (proxy.php) + cart use the right context — otherwise scheduled keeps hitting bbnow → SERVE3056.
    if(S.encData){
      const r = await apiCall('bb_set_mode', {encData:S.encData, mode:S.modeCtx});
      // If BB Now isn't serviceable for this address, don't strand the user there — bounce to Scheduled.
      if(S.modeCtx==='bbnow' && r && r.decoded && r.decoded.mode_serviceable===false){
        showToast("This address isn't available for BB Now — staying on Scheduled",'error');
        await switchToScheduled();
        return;
      }
      if(S.searchSlug) runSearch(S.searchSlug);   // re-run current search in the new context
      preloadCart(true);                            // re-resolve cart prices in the new context
    }
  }));
  // nav
  $$('#bottomNav .nav-item').forEach(b=>b.addEventListener('click',()=>route(b.dataset.nav)));
  $('#cartStrip').addEventListener('click', ()=>route('cart'));
});

/* ═══════════════════════════════════════════════════════════════
   GATE  →  validate_access_code  →  list_accounts_by_code
   ═══════════════════════════════════════════════════════════════ */
async function submitGate(){
  const code = $('#gate_code').value.trim().toUpperCase();
  const errEl = $('#gate_err');
  errEl.textContent='';
  if(!code){ errEl.textContent='Enter your access code'; return; }
  $('#gate_btn').disabled=true; $('#gate_btn').textContent='Verifying…';
  try{
    const r = await apiCall('validate_access_code', {code, phone:'', context:'order', checker_enabled:false});
    if(!r){ errEl.textContent='Session error, retry'; return; }
    const d = r.decoded;
    if(!d.ok){ try{ localStorage.removeItem('bb_ac'); }catch(e){}  errEl.textContent = d.message || 'Invalid access code'; return; }
    try{ localStorage.setItem('bb_ac', code); }catch(e){}   // remember for silent renew after a session expiry
    S.access = d.access_data || {code};
    S.features = d.features || {};   // feature flags from config.php (e.g. games)
    $('#accessGate').style.display='none';
    await loadAccountsRoster(true);
  }catch(e){ errEl.textContent='Network error'; }
  finally{ $('#gate_btn').disabled=false; $('#gate_btn').textContent='Continue'; }
}

async function loadAccountsRoster(boot=false){
  const r = await apiCall('list_accounts_by_code', {});
  if(!r){ return; }
  const d = r.decoded;
  S.accounts = d.accounts || [];
  S.activePhone = d.active_phone || S.activePhone;
  if(boot){
    if(S.accounts.length === 0){
      // FORCE full-screen login from zero
      openLogin(false);
    } else {
      // land on Accounts tab to pick
      showShell();
      route('accounts');
      showToast(S.accounts.length+' account(s) found — pick one');
    }
  }
  return S.accounts;
}

/* show the app shell (top bar + nav) */
/* Access-code balance is a login-time snapshot that goes stale after a recharge (or an order/refund
   in another session). Pull the live value from the server and repaint the header chip. */
async function refreshAccessBalance(){
  if(!S.access) return;
  try{
    const r=await apiCall('access_refresh',{});
    if(r && r.decoded && r.decoded.ok){
      if(r.decoded.balance!=null) S.access.balance=r.decoded.balance;
      if(r.decoded.per_order_limit!=null) S.access.per_order_limit=r.decoded.per_order_limit;
      paintTopbar();
    }
  }catch(e){}
}
let _balTimer=null;
function startBalancePolling(){
  if(_balTimer) return;
  _balTimer=setInterval(()=>{ if(S.loggedIn && S.access && document.visibilityState==='visible') refreshAccessBalance(); }, 60000);
}
function showShell(){
  $('#topbar').style.display='flex';
  $('#app').style.display='block';
  $('#bottomNav').style.display='flex';
  paintTopbar();
  refreshAccessBalance();   // pull the latest balance immediately (e.g. right after a recharge)
  startBalancePolling();
  syncBotSettings();        // load the per-code Address-uniqueness toggle (default ON) for manual saves
}
/* Cache the per-access-code Bot Settings so manual address saves know the Address-uniqueness state.
   Default ON: S.addressUnique stays undefined (treated as on) if this can't load. */
async function syncBotSettings(){
  try{ const r=await apiCall('bot_settings_get', {}); if(r && r.decoded && r.decoded.ok) S.addressUnique = bsIsOn(r.decoded.address_unique); }catch(e){}
}
function paintTopbar(){
  const idx = (S.accounts||[]).findIndex(a=>a.mobile_no===S.activePhone);
  const acct = idx>=0 ? S.accounts[idx] : null;
  const name = acct ? (acct.name||'BigBasket') : (S.loggedIn?'BigBasket':'Pick an account');
  const serial = (idx>=0) ? '#'+(idx+1)+' · ' : '';   // chosen account's serial (its position in the roster)
  $('#tb_name').textContent = name;
  const jtag = (acct && acct.source==='json') ? ' · JSON' : '';
  const ph = acct ? acctLabel(acct) : (S.activePhone ? ('+91 '+S.activePhone) : '');
  $('#tb_phone').textContent = S.activePhone ? (serial+ph+jtag) : '—';
  $('#tb_avatar').textContent = initials(name);
  // Profile is locked until an account is active
  const pb=$('#tb_profile'); if(pb) pb.classList.toggle('disabled', !S.encData);
  const balEl=$('#tb_bal');
  if(balEl){
    if(S.access && S.access.balance!=null){
      const b=+S.access.balance||0, lim=+(S.access.per_order_limit||0);
      balEl.textContent=inr(b);
      balEl.classList.toggle('low', lim>0 && b<lim);
    } else balEl.textContent='₹—';
  }
}
/* Profile is disabled until an account is chosen — then it opens the account picker instead. */
function profileOrPicker(){ openProfileSheet(); }   // always reachable — logout lives here even before an account is picked

/* Log out: end the (7-day) session so the user can enter a DIFFERENT access code. Clears the stored
   code so the silent auto-renew won't log the old one straight back in, resets state, shows the gate. */
async function logoutAndReset(){
  try{ await apiCall('logout', {}); }catch(e){}
  try{ localStorage.removeItem('bb_ac'); }catch(e){}
  try{ sessionStorage.removeItem('bb_renew_at'); }catch(e){}
  S.access=null; S.features={}; S.accounts=[]; S.activePhone=null; S.loggedIn=false;
  S.encData=null; try{ S.cart.clear(); }catch(e){} S._cartLoadedFor=null; S.selectedAddressId=null; S.addrDecoded=null; S._activeAddr=null; S.latLng=null; S.ourAddress=null;
  closeSheet();
  ['topbar','bottomNav','loginScreen','sheetOverlay','app'].forEach(id=>{ const e=document.getElementById(id); if(e) e.style.display='none'; });
  const g=document.getElementById('accessGate'); if(g) g.style.display='flex';
  const gc=document.getElementById('gate_code'); if(gc) gc.value='';
  const ge=document.getElementById('gate_err'); if(ge) ge.textContent='';
}

/* ═══════════════════════════════════════════════════════════════
   ROUTER
   ═══════════════════════════════════════════════════════════════ */
const TAB_RENDER = {
  search: renderSearchTab,
  cart: renderCartTab,
  address: renderAddressTab,
  accounts: renderAccountsTab,
  orders: renderOrdersTab,
  plugins: renderPluginsTab,
};
function renderPluginsTab(c){
  const f = S.features || {};   // per-plugin on/off from config.php (default ON unless explicitly false)
  const cards = [];
  if(f.bulk_orders !== false) cards.push(`
    <div class="plug-card" id="plug_po">
      <div class="plug-ico">⚡</div>
      <div class="plug-body"><div class="plug-name">Bulk Orders</div>
        <div class="plug-sub">Order the same default cart across several accounts in one go</div></div>
      <div class="plug-chev">›</div>
    </div>`);
  if(f.shop !== false) cards.push(`
    <div class="plug-card" id="plug_shop">
      <div class="plug-ico">🛒</div>
      <div class="plug-body"><div class="plug-name">Shop</div>
        <div class="plug-sub">Buy ready-made accounts — added straight under your code</div></div>
      <div class="plug-chev">›</div>
    </div>`);
  if(f.coupon_shop !== false) cards.push(`
    <div class="plug-card" id="plug_coupshop">
      <div class="plug-ico">🏪</div>
      <div class="plug-body"><div class="plug-name">Coupon Store</div>
        <div class="plug-sub">Buy ready-made coupon codes — revealed instantly</div></div>
      <div class="plug-chev">›</div>
    </div>`);
  if(f.giveaway !== false) cards.push(`
    <div class="plug-card" id="plug_giveaway">
      <div class="plug-ico">🎁</div>
      <div class="plug-body"><div class="plug-name">Giveaway</div>
        <div class="plug-sub">Claim free coupons for ordering through the app</div></div>
      <div class="plug-chev">›</div>
    </div>`);
  if(f.coupons !== false) cards.push(`
    <div class="plug-card" id="plug_coup">
      <div class="plug-ico">🎟️</div>
      <div class="plug-body"><div class="plug-name">Generate Coupons</div>
        <div class="plug-sub">Claim app coupons via OTP — copy &amp; use instantly</div></div>
      <div class="plug-chev">›</div>
    </div>`);
  if(f.bot_settings !== false) cards.push(`
    <div class="plug-card" id="plug_botset">
      <div class="plug-ico">⚙️</div>
      <div class="plug-body"><div class="plug-name">Bot Settings</div>
        <div class="plug-sub">Control how the bot handles your accounts</div></div>
      <div class="plug-chev">›</div>
    </div>`);
  c.innerHTML = `<div class="plug-wrap">
    <h2 class="plug-h">Plugins</h2>
    ${cards.join('') || '<div class="empty"><div class="e-emoji">🧩</div><span class="muted">No plugins enabled</span></div>'}
  </div>`;
  const po=$('#plug_po', c); if(po) po.onclick = poOpen;
  const sh=$('#plug_shop', c); if(sh) sh.onclick = shopOpen;
  const csp=$('#plug_coupshop', c); if(csp) csp.onclick = coupShopOpen;
  const cp=$('#plug_coup', c); if(cp) cp.onclick = coupOpen;
  const gv=$('#plug_giveaway', c); if(gv) gv.onclick = giveawayOpen;
  const bs=$('#plug_botset', c); if(bs) bs.onclick = botSettingsOpen;
}

/* ═══════════════ BOT SETTINGS PLUGIN ═══════════════
   Per-access-code toggles. Currently: Address Scrubber on/off (default ON for everyone). When a user
   turns it off, the 24/7 address-scrub worker SKIPS every order under this access code; turning it back
   on resumes scrubbing their orders. */
async function botSettingsOpen(){
  const c=poC(); c.innerHTML='<div class="center muted mt16">Loading…</div><div class="spin"></div>';
  const r=await apiCall('bot_settings_get', {});
  if(!r || !r.decoded || !r.decoded.ok){
    c.innerHTML=`<div class="plug-wrap">${poBackBtn()}<h2 class="plug-h">Bot Settings</h2><div class="warn-box">${esc((r&&r.decoded&&r.decoded.message)||'Settings are unavailable.')}</div></div>`;
    poWireBack(); return;
  }
  botSettingsRender(r.decoded);
}
function bsIsOn(v){ return v !== false && v != 0 && v !== '0'; }
function botSettingsRender(d){
  const c=poC();
  const scrubOn=bsIsOn(d.address_scrub), uniqOn=bsIsOn(d.address_unique);
  S.addressUnique = uniqOn;   // keep the manual-save cache in sync
  c.innerHTML=`<div class="plug-wrap">${poBackBtn()}<h2 class="plug-h">Bot Settings</h2>
    <div class="bs-row">
      <div class="bs-info">
        <div class="bs-name">Address uniqueness</div>
        <div class="bs-desc">On by default. When you save an address, its text fields get a small random tweak + 30 m lat/lng jitter.</div>
      </div>
      <button class="bs-toggle${uniqOn?' on':''}" id="bsUniq" data-set="address_unique" role="switch" aria-checked="${uniqOn?'true':'false'}"><span class="bs-knob"></span></button>
    </div>
    <div class="bs-row">
      <div class="bs-info">
        <div class="bs-name">Address Scrubber</div>
        <div class="bs-desc">Off by default. Turn it on to automatically clean the delivery address on your delivered orders — the real details are scrambled and the address removed after delivery. Turn it off any time to stop.</div>
      </div>
      <button class="bs-toggle${scrubOn?' on':''}" id="bsScrub" data-set="address_scrub" role="switch" aria-checked="${scrubOn?'true':'false'}"><span class="bs-knob"></span></button>
    </div>
  </div>`;
  poWireBack();
  $$('.bs-toggle', c).forEach(t=>t.onclick=()=>botSettingsToggle(t));
}
async function botSettingsToggle(btn){
  const setting = btn.dataset.set;
  const next = !btn.classList.contains('on');
  btn.disabled=true;
  const r=await apiCall('bot_settings_set', { setting, value: next?1:0 });
  btn.disabled=false;
  if(!r || !r.decoded || !r.decoded.ok){ showToast((r&&r.decoded&&r.decoded.message)||'Could not save','error'); return; }
  const on=bsIsOn(r.decoded[setting]);
  btn.classList.toggle('on', on); btn.setAttribute('aria-checked', on?'true':'false');
  if(setting==='address_unique') S.addressUnique = on;
  showToast((setting==='address_unique'?'Address uniqueness':'Address scrubber')+(on?' turned on':' turned off'),'success');
}

/* ═══════════════ GIVEAWAY PLUGIN ═══════════════
   Users with >= config.giveaway.min_orders orders (by access code) can claim
   config.giveaway.coupons_per_claim coupons ONCE per active giveaway_id, from a
   pre-generated Navi pool. A new giveaway_id lets everyone claim again. */
async function giveawayOpen(){
  const c=poC(); c.innerHTML='<div class="center muted mt16">Loading…</div><div class="spin"></div>';
  const r=await apiCall('giveaway_info', {});
  if(!r || !r.decoded.ok){
    c.innerHTML=`<div class="plug-wrap">${poBackBtn()}<h2 class="plug-h">Giveaway</h2><div class="warn-box">${esc((r&&r.decoded&&r.decoded.message)||'Giveaway is unavailable.')}</div></div>`;
    poWireBack(); return;
  }
  giveawayRender(r.decoded);
}
function gvCoupon(code){ return `<div class="gv-coupon"><span class="gv-code">${esc(code)}</span><button class="gv-copy coup-hcopy" data-code="${esc(code)}">📋</button></div>`; }
function giveawayRender(d){
  const c=poC(); let body;
  if(!d.active){
    body=`<div class="empty"><div class="e-emoji">🎁</div><span class="muted">${esc(d.message||'No giveaway is running right now.')}</span></div>`;
  } else if(d.claimed){
    body=`<div class="gv-box"><div class="gv-emoji">🎉</div><div class="gv-won">You've claimed this giveaway!</div></div>
      ${(d.coupons||[]).map(gvCoupon).join('')||'<div class="muted center">No coupons on record.</div>'}
      <div class="muted" style="text-align:center;font-size:12px;margin-top:10px">A new giveaway lets you claim again.</div>`;
  } else if(!d.eligible){
    const pct=Math.max(0,Math.min(100,Math.round((d.orders/Math.max(1,d.min_orders))*100)));
    body=`<div class="gv-box"><div class="gv-emoji">🔒</div>
      <div class="gv-title">Unlock ${d.coupons_per_claim} free coupon${d.coupons_per_claim===1?'':'s'}</div>
      <div class="gv-sub">Place ${d.min_orders} orders through the app to become eligible.</div>
      <div class="gv-prog"><div class="gv-prog-bar" style="width:${pct}%"></div></div>
      <div class="gv-count">You've placed <b>${d.orders}</b> / ${d.min_orders} orders</div></div>`;
  } else {
    const poolOut=(d.pool_available||0) < (d.coupons_per_claim||1);
    body=`<div class="gv-box"><div class="gv-emoji">🎁</div>
      <div class="gv-title">You're eligible!</div>
      <div class="gv-sub">Claim ${d.coupons_per_claim} free coupon${d.coupons_per_claim===1?'':'s'} — ${d.orders} orders placed.</div>
      ${poolOut?`<div class="warn-box">🎁 All coupons have been claimed — this giveaway is fully claimed.</div>`
               :`<button class="btn-primary" id="gvClaim">🎉 Claim ${d.coupons_per_claim} coupon${d.coupons_per_claim===1?'':'s'}</button>`}</div>`;
  }
  c.innerHTML=`<div class="plug-wrap">${poBackBtn()}<h2 class="plug-h">Giveaway${d.title?` · ${esc(d.title)}`:''}</h2>${body}</div>`;
  poWireBack();
  const cb=$('#gvClaim'); if(cb) cb.onclick=giveawayClaim;
  $('.gv-copy').forEach(b=>b.onclick=()=>coupCopy(b.dataset.code,b));
}
async function giveawayClaim(){
  const btn=$('#gvClaim'); if(btn){ btn.disabled=true; btn.textContent='Claiming…'; }
  const r=await apiCall('giveaway_claim', {});
  if(!r){ if(btn){ btn.disabled=false; btn.textContent='🎉 Claim'; } return; }
  const d=r.decoded;
  if(d.ok) showToast(d.message||'Claimed!','success');
  else if(!d.already) showToast(d.message||'Could not claim','error');
  giveawayOpen();   // re-fetch → claimed coupons / exhausted / updated progress
}

/* Display label for an account's number. scripthub (shop-bought) accounts NEVER show the real
   number — only their base64-decoded m_id — so sold numbers are not disclosed anywhere in the UI. */
function decodeMid(m){ try{ return atob(String(m||'')); }catch(e){ return String(m||''); } }
function acctLabel(a){
  if(a && a.source==='scripthub') return 'ID '+decodeMid(a.m_id);
  return '+91 '+((a && (a.mobile_no||a.mobile))||'');
}

/* ═══════════════ SHOP PLUGIN ═══════════════ */
const SHOP = { available:0, price:20, max:5, qty:1 };
async function shopOpen(){
  const c = poC(); c.innerHTML = '<div class="center muted mt16">Loading…</div><div class="spin"></div>';
  const r = await apiCall('shop_stock', {});
  if(!r || !r.decoded.ok){ c.innerHTML='<div class="warn-box">Could not load the shop.</div>'; return; }
  SHOP.available = r.decoded.available||0; SHOP.price = r.decoded.price||20; SHOP.max = r.decoded.max||5; SHOP.qty = 1;
  shopRenderBuy();
}
function shopRenderBuy(){
  const c = poC();
  const bal = (S.access && S.access.balance!=null) ? +S.access.balance : null;
  const affordable = (bal!=null && SHOP.price>0) ? Math.floor(bal/SHOP.price) : Infinity;   // how many the balance covers
  const maxBuy = Math.max(0, Math.min(SHOP.max, SHOP.available, affordable));                 // stock ∧ per-purchase cap ∧ balance
  if(SHOP.qty>maxBuy) SHOP.qty = Math.max(1, maxBuy);
  if(SHOP.qty<1) SHOP.qty = 1;
  c.innerHTML = `<div class="plug-wrap">
    <button class="btn-ghost" id="poBack">‹ Plugins</button>
    <h2 class="plug-h">Shop</h2>
    <div class="shop-stock"><div class="shop-big">${SHOP.available}</div><div class="muted">accounts in stock</div></div>
    <div class="po-sec"><div class="po-sec-h">Price</div><div class="muted">₹${SHOP.price} per account${bal!=null?` · your balance ₹${bal}`:''}</div></div>
    <div class="warn-box">⚠️ Every account is live-checked at purchase. <b>No refund</b> if an account is later revoked by BigBasket through your own fault — misuse, spam, fraud flags or policy violations.</div>
    ${SHOP.available<=0
      ? `<div class="warn-box">Out of stock right now — check back later.</div>`
      : (maxBuy<=0
        ? `<div class="warn-box">Insufficient balance — you need ₹${SHOP.price} to buy an account${bal!=null?` (your balance ₹${bal})`:''}.</div>`
        : `
    <div class="po-sec"><div class="po-sec-h">How many? <span class="muted">(max ${maxBuy})</span></div>
      <div class="shop-step">
        <button class="shop-pm" id="shopMinus" aria-label="decrease">−</button>
        <span class="shop-qty" id="shopQty">${SHOP.qty}</span>
        <button class="shop-pm" id="shopPlus" aria-label="increase">+</button>
      </div></div>
    <button class="btn-primary po-start" id="shopBuy">Buy <span id="shopBuyN">${SHOP.qty}</span> · ₹<span id="shopBuyT">${SHOP.qty*SHOP.price}</span></button>`)}
  </div>`;
  const b=$('#poBack',c); if(b) b.onclick=()=>renderPluginsTab(c);
  const setQ=()=>{
    if(SHOP.qty<1) SHOP.qty=1; if(SHOP.qty>maxBuy) SHOP.qty=maxBuy;
    const q=$('#shopQty',c), n=$('#shopBuyN',c), t=$('#shopBuyT',c);
    if(q)q.textContent=SHOP.qty; if(n)n.textContent=SHOP.qty; if(t)t.textContent=SHOP.qty*SHOP.price;
    const mi=$('#shopMinus',c), pl=$('#shopPlus',c);
    if(mi) mi.disabled = SHOP.qty<=1;
    if(pl) pl.disabled = SHOP.qty>=maxBuy;
  };
  const mi=$('#shopMinus',c); if(mi) mi.onclick=()=>{ SHOP.qty--; setQ(); };
  const pl=$('#shopPlus',c); if(pl) pl.onclick=()=>{ SHOP.qty++; setQ(); };
  setQ();
  const buy=$('#shopBuy',c); if(buy) buy.onclick=shopBuy;
}
async function shopBuy(){
  const btn=$('#shopBuy'); if(btn) btn.disabled=true;
  const r = await apiCall('shop_buy', { qty:SHOP.qty });
  if(btn) btn.disabled=false;
  if(!r) return;
  if(!r.decoded.ok){ showToast(r.decoded.message||'Purchase failed','error'); return; }
  if(r.decoded.new_balance!=null && S.access) S.access.balance = r.decoded.new_balance;
  try{ await loadAccountsRoster(true); }catch(e){}   // new scripthub accounts appear in the roster
  shopRenderResult(r.decoded);
}
function shopRenderResult(d){
  const c = poC();
  const rows = (d.bought||[]).map(b=>`<div class="po-row po-placed">
    <span class="po-row-mid"><b>${esc((b.name||'').trim()||'Account')}</b> <span class="muted">ID ${esc(decodeMid(b.m_id))}</span></span>
    <span class="po-stat">✅ added</span></div>`).join('');
  c.innerHTML = `<div class="plug-wrap"><h2 class="plug-h">Purchased</h2>
    <div class="po-tot">Bought ${d.count} · charged ₹${d.charged} · balance ₹${d.new_balance}</div>
    <div class="po-prog">${rows}</div>
    <div class="muted" style="margin:6px 2px 12px">They're now under your access code in Accounts. Their number stays hidden — use them in Bulk Orders.</div>
    <button class="btn-primary" id="shopMore">Back to Shop</button>
    <button class="btn-ghost" id="shopAcc">Go to Accounts</button></div>`;
  const m=$('#shopMore',c); if(m) m.onclick=shopOpen;
  const a=$('#shopAcc',c); if(a) a.onclick=()=>route('accounts');
}

/* ═══════════════ COUPON STORE PLUGIN (buy ready-made coupon codes) ═══════════════ */
function csCopyBtns(c){
  $$('.cs-copy', c).forEach(b=> b.onclick=()=>{
    try{ navigator.clipboard.writeText(b.dataset.c); }catch(e){}
    const t=b.textContent; b.textContent='Copied ✓'; b.disabled=true;
    setTimeout(()=>{ b.textContent=t; b.disabled=false; }, 1500);
  });
}
async function coupShopOpen(){
  const c = poC(); c.innerHTML = '<div class="center muted mt16">Loading…</div><div class="spin"></div>';
  const r = await apiCall('coupon_shop_list', {});
  if(!r || !r.decoded.ok){
    c.innerHTML = `<div class="plug-wrap"><button class="btn-ghost" id="poBack">‹ Plugins</button>
      <div class="warn-box" style="margin-top:12px">${esc((r&&r.decoded&&r.decoded.message)||'Could not load the Coupon Store.')}</div></div>`;
    poWireBack(); return;
  }
  coupShopRender(r.decoded);
}
function coupShopRender(d){
  const c = poC();
  const bal = (d.balance!=null)?+d.balance:((S.access&&S.access.balance!=null)?+S.access.balance:null);
  const cards = (d.listings||[]).map(l=>{
    const out=l.available<=0, cant=(bal!=null && l.price>bal);
    const btn = out ? `<span class="muted">Out of stock</span>`
      : cant ? `<span class="muted">Need ${inr(l.price)}</span>`
      : `<button class="btn-primary coup-buy" data-id="${l.id}" data-price="${l.price}">Buy · ${inr(l.price)}</button>`;
    return `<div class="cs-card">
      <div class="cs-main"><div class="cs-title">${esc(l.title)}</div>
        ${l.subtitle?`<div class="cs-sub muted">${esc(l.subtitle)}</div>`:''}
        <div class="cs-meta muted">${l.available} in stock</div></div>
      <div class="cs-act">${btn}</div></div>`;
  }).join('');
  c.innerHTML = `<div class="plug-wrap">
    <button class="btn-ghost" id="poBack">‹ Plugins</button>
    <h2 class="plug-h">Coupon Store</h2>
    ${bal!=null?`<div class="muted" style="margin:0 2px 8px">Your balance ${inr(bal)}</div>`:''}
    ${cards || '<div class="empty"><div class="e-emoji">🎟️</div><span class="muted">No coupons available right now</span></div>'}
    <button class="btn-ghost mt12" id="csHist">🧾 My coupons</button>
  </div>`;
  poWireBack();
  $$('.coup-buy', c).forEach(b=> b.onclick=()=> coupShopBuy(+b.dataset.id, b));
  const h=$('#csHist',c); if(h) h.onclick=coupShopHistory;
}
async function coupShopBuy(listingId, btn){
  if(btn) btn.disabled=true;
  const r = await apiCall('coupon_shop_buy', { listing_id:listingId, qty:1 });
  if(btn) btn.disabled=false;
  if(!r) return;
  if(!r.decoded.ok){ showToast(r.decoded.message||'Purchase failed','error'); return; }
  if(r.decoded.new_balance!=null && S.access) S.access.balance = r.decoded.new_balance;
  coupShopResult(r.decoded);
}
function coupShopResult(d){
  const c = poC();
  const codes = d.codes||[];
  const codeRows = codes.map(code=>`<div class="cs-code"><code>${esc(code)}</code><button class="btn-line cs-copy" data-c="${esc(code)}">Copy</button></div>`).join('');
  c.innerHTML = `<div class="plug-wrap"><h2 class="plug-h">Purchased</h2>
    <div class="po-tot">${esc(d.title||'Coupon')} · charged ${inr(d.charged)} · balance ${inr(d.new_balance)}</div>
    <div class="po-sec"><div class="po-sec-h">Your coupon${codes.length>1?'s':''}</div>${codeRows}</div>
    ${d.redeem?`<div class="cs-redeem"><b>How to redeem</b><div class="muted">${esc(d.redeem)}</div></div>`:''}
    <button class="btn-primary mt12" id="csMore">Back to Store</button>
    <button class="btn-ghost" id="csHist2">🧾 My coupons</button></div>`;
  csCopyBtns(c);
  const m=$('#csMore',c); if(m) m.onclick=coupShopOpen;
  const h=$('#csHist2',c); if(h) h.onclick=coupShopHistory;
}
async function coupShopHistory(){
  const c = poC(); c.innerHTML = '<div class="center muted mt16">Loading…</div><div class="spin"></div>';
  const r = await apiCall('coupon_shop_history', {});
  const rows = (r&&r.decoded&&r.decoded.coupons)||[];
  const html = rows.length
    ? rows.map(x=>`<div class="cs-hist"><div class="cs-main"><div class="cs-title">${esc(x.title)}</div><code>${esc(x.code)}</code></div><button class="btn-line cs-copy" data-c="${esc(x.code)}">Copy</button></div>`).join('')
    : '<div class="empty"><div class="e-emoji">🧾</div><span class="muted">No coupons bought yet</span></div>';
  c.innerHTML = `<div class="plug-wrap"><button class="btn-ghost" id="poBack">‹ Store</button><h2 class="plug-h">My coupons</h2>${html}</div>`;
  const b=$('#poBack',c); if(b) b.onclick=coupShopOpen;
  csCopyBtns(c);
}

/* ═══════════════ GENERATE COUPONS PLUGIN (Navi) ═══════════════
   App picker → mobile → OTP → verify+login+activate → coupon (copy). A History tab lists
   every coupon this access code has generated. The whole Navi OTP/login/activate flow runs
   server-side (NaviClient.php); the client only drives the 3-step UI. */
const COUP = { apps:[], available:true, app:null, tab:'generate', step:'form', mobile:'', coupon:null };
function coupAppName(id){ const a=(COUP.apps||[]).find(x=>x.id===id); return a?a.name:(id?id.charAt(0).toUpperCase()+id.slice(1):'App'); }

/* epoch-ms → "12 Jul 2026, 07:59 PM" in IST (the plugin's timestamps are ms integers, unlike
   istTime() which parses DB datetime strings). */
function istFromMs(ms){
  const n=+ms; if(!n||isNaN(n)) return '—';
  const p={}; new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).formatToParts(new Date(n)).forEach(x=>p[x.type]=x.value);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${(p.dayPeriod||'').toUpperCase()}`;
}

async function coupCopy(text, btn){
  let ok=false;
  try{ if(navigator.clipboard && navigator.clipboard.writeText){ await navigator.clipboard.writeText(text); ok=true; } }catch(e){}
  if(!ok){ try{ const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.focus(); ta.select(); ok=document.execCommand('copy'); ta.remove(); }catch(e){} }
  if(btn){ const o=btn.innerHTML; btn.innerHTML=btn.classList.contains('coup-hcopy')?'✅':'✅ Copied!'; btn.classList.add('ok'); setTimeout(()=>{ btn.innerHTML=o; btn.classList.remove('ok'); }, 1500); }
  else if(!ok) showToast('Copy failed — long-press the code to copy','error');
}

async function coupOpen(){
  COUP.tab='generate'; COUP.step='form'; COUP.mobile=''; COUP.coupon=null;
  const c = poC(); c.innerHTML = '<div class="center muted mt16">Loading…</div><div class="spin"></div>';
  const r = await apiCall('coupon_apps', {});
  if(!r || !r.decoded.ok){
    c.innerHTML = `<div class="plug-wrap">${poBackBtn()}<h2 class="plug-h">Generate Coupons</h2>
      <div class="warn-box">${esc((r&&r.decoded&&r.decoded.message)||'Coupons are unavailable.')}</div></div>`;
    poWireBack(); return;
  }
  COUP.apps = r.decoded.apps || [];
  COUP.available = r.decoded.available !== false;
  COUP.app = (COUP.apps[0]||{}).id || null;
  coupRender();
}

function coupRender(){
  const c = poC();
  c.innerHTML = `<div class="plug-wrap">
    ${poBackBtn()}
    <h2 class="plug-h">Generate Coupons</h2>
    <div class="coup-tabs">
      <button class="coup-tab ${COUP.tab==='generate'?'on':''}" data-t="generate">Generate</button>
      <button class="coup-tab ${COUP.tab==='history'?'on':''}" data-t="history">History</button>
    </div>
    <div id="coupBody"></div>
  </div>`;
  poWireBack();
  $$('.coup-tab', c).forEach(b=>b.onclick=()=>{ COUP.tab=b.dataset.t; coupRender(); });
  if(COUP.tab==='generate') coupRenderGenerate(); else coupRenderHistory();
}

function coupRenderGenerate(){
  const body = $('#coupBody', poC()); if(!body) return;
  if(COUP.step==='result'){ return coupRenderResult(); }
  if(!COUP.apps.length){ body.innerHTML='<div class="empty"><div class="e-emoji">🧩</div><span class="muted">No apps available right now</span></div>'; return; }
  if(!COUP.app || !COUP.apps.some(a=>a.id===COUP.app)) COUP.app = COUP.apps[0].id;
  const warn = COUP.available ? '' : '<div class="warn-box">⚠️ Coupon service is temporarily unavailable on the server.</div>';

  const appCards = COUP.apps.map(a=>`
    <button class="coup-app ${COUP.app===a.id?'on':''}" data-a="${esc(a.id)}">
      <span class="coup-app-ico">${a.ico}</span>
      <span class="coup-app-body"><span class="coup-app-name">${esc(a.name)}</span><span class="coup-app-sub">${esc(a.sub)}</span></span>
      <span class="coup-app-chk">${COUP.app===a.id?'✓':''}</span>
    </button>`).join('');

  let form='';
  if(COUP.step==='form'){
    form = `
      <div class="po-sec"><div class="po-sec-h">Mobile number</div>
        <div class="coup-mobrow">
          <span class="coup-cc">+91</span>
          <input id="coupMobile" class="coup-inp" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit number" value="${esc(COUP.mobile)}">
        </div>
      </div>
      <button class="btn-primary po-start" id="coupSend">Send OTP</button>`;
  } else if(COUP.step==='otp'){
    form = `
      <div class="coup-note">OTP sent to <b>+91 ${esc(COUP.mobile)}</b></div>
      <div class="po-sec"><div class="po-sec-h">Enter OTP</div>
        <input id="coupOtp" class="coup-inp coup-otp" type="tel" inputmode="numeric" maxlength="8" placeholder="••••••" autocomplete="one-time-code">
      </div>
      <button class="btn-primary po-start" id="coupVerify">Verify &amp; Claim Coupon</button>
      <button class="btn-ghost" id="coupChange">‹ Change number</button>`;
  } else if(COUP.step==='claimed'){
    form = `<div class="warn-box">📵 This number has <b>already claimed</b> a coupon. Try a different number.</div>
      <button class="btn-primary po-start" id="coupChange2">Use another number</button>`;
  }

  body.innerHTML = `${warn}<div class="po-sec"><div class="po-sec-h">Choose app</div><div class="coup-apps">${appCards}</div></div>${form}`;
  $$('.coup-app', body).forEach(b=>b.onclick=()=>{ COUP.app=b.dataset.a; coupRenderGenerate(); });
  const mob=$('#coupMobile', body); if(mob){ mob.oninput=()=>{ mob.value=mob.value.replace(/\D/g,'').slice(0,10); COUP.mobile=mob.value; }; }
  const send=$('#coupSend', body); if(send) send.onclick=coupSend;
  const ver=$('#coupVerify', body); if(ver) ver.onclick=coupVerify;
  const ch=$('#coupChange', body); if(ch) ch.onclick=()=>{ COUP.step='form'; coupRenderGenerate(); };
  const ch2=$('#coupChange2', body); if(ch2) ch2.onclick=()=>{ COUP.step='form'; COUP.mobile=''; coupRenderGenerate(); };
}

async function coupSend(){
  const mob=$('#coupMobile'); const v=((mob?mob.value:COUP.mobile)||'').replace(/\D/g,'');
  if(v.length!==10){ showToast('Enter a valid 10-digit number','error'); return; }
  COUP.mobile=v;
  const btn=$('#coupSend'); if(btn){ btn.disabled=true; btn.textContent='Sending…'; }
  const r=await apiCall('coupon_otp_send',{ app:COUP.app, mobile:v });
  if(btn){ btn.disabled=false; btn.textContent='Send OTP'; }
  if(!r) return;
  const d=r.decoded;
  if(d.claimed){ COUP.step='claimed'; coupRenderGenerate(); return; }
  if(!d.ok) return;                                  // error already surfaced by apiCall
  COUP.step='otp'; coupRenderGenerate();
  setTimeout(()=>{ const o=$('#coupOtp'); if(o) o.focus(); }, 60);
}

async function coupVerify(){
  const o=$('#coupOtp'); const otp=((o?o.value:'')||'').replace(/\D/g,'');
  if(!otp){ showToast('Enter the OTP','error'); return; }
  const btn=$('#coupVerify'); if(btn){ btn.disabled=true; btn.textContent='Claiming…'; }
  const r=await apiCall('coupon_otp_verify',{ otp });
  if(btn){ btn.disabled=false; btn.innerHTML='Verify &amp; Claim Coupon'; }
  if(!r) return;
  const d=r.decoded;
  if(d.reset){ COUP.step='form'; coupRenderGenerate(); return; }   // OTP session expired → resend
  if(!d.ok) return;                                                // e.g. Invalid OTP — stay to retry
  COUP.coupon=d.coupon||null; COUP.step='result'; coupRenderGenerate();
}

function coupRenderResult(){
  const body=$('#coupBody', poC()); if(!body) return;
  const cp=COUP.coupon||{}; const code=cp.code||'—';
  const valid = cp.valid_upto ? istFromMs(cp.valid_upto) : null;
  body.innerHTML=`
    <div class="coup-done">
      <div class="coup-done-ico">🎉</div>
      <div class="coup-done-t">Coupon generated</div>
      <div class="coup-done-sub">for +91 ${esc(cp.mobile||COUP.mobile)}</div>
      <div class="coup-code" id="coupCode">${esc(code)}</div>
      <button class="btn-primary coup-copy" id="coupCopy">📋 Copy code</button>
      ${valid?`<div class="coup-valid">Valid till <b>${esc(valid)}</b></div>`:''}
    </div>
    <button class="btn-line" id="coupAgain">＋ Generate another</button>`;
  const cpBtn=$('#coupCopy', body); if(cpBtn) cpBtn.onclick=()=>coupCopy(code, cpBtn);
  const ag=$('#coupAgain', body); if(ag) ag.onclick=()=>{ COUP.step='form'; COUP.mobile=''; COUP.coupon=null; coupRenderGenerate(); };
}

async function coupRenderHistory(){
  const body=$('#coupBody', poC()); if(!body) return;
  body.innerHTML='<div class="center muted mt16">Loading…</div><div class="spin"></div>';
  const r=await apiCall('coupon_history',{});
  if(!r||!r.decoded.ok){ body.innerHTML='<div class="warn-box">Could not load history.</div>'; return; }
  const list=r.decoded.coupons||[];
  if(!list.length){ body.innerHTML='<div class="empty"><div class="e-emoji">🎟️</div><span class="muted">No coupons generated yet</span></div>'; return; }
  const now=Date.now();
  body.innerHTML=`<div class="coup-hist">${list.map(x=>{
    const expired = x.valid_upto && x.valid_upto < now;
    const validTxt = x.valid_upto ? (expired ? 'Expired' : 'Valid till '+istFromMs(x.valid_upto)) : (x.status||'');
    return `<div class="coup-hrow">
      <div class="coup-hmain">
        <span class="coup-hcode">${esc(x.code)}</span>
        <button class="coup-hcopy" data-code="${esc(x.code)}" title="Copy">📋</button>
      </div>
      <div class="coup-hmeta"><span class="coup-happ">${esc(coupAppName(x.app))}</span><span>📱 +91 ${esc(x.mobile)}</span><span>🕒 ${esc(istFromMs(x.created_ms))}</span></div>
      <div class="coup-hmeta"><span class="${expired?'coup-exp':'coup-ok'}">${esc(validTxt)}</span></div>
    </div>`;
  }).join('')}</div>`;
  $$('.coup-hcopy', body).forEach(b=>b.onclick=()=>coupCopy(b.dataset.code, b));
}

/* ═══════════════════════════════════════════════════════════════════════════
   BULK ORDERS  —  drive the existing per-account ops (switch → address →
   cart → checkout → coupon → place) across up to 10 unused accounts.
   Sessions are single-active on the server, so this is an automated back-to-back
   batch, not literal concurrency. Reuses every proven op; nothing new server-side
   except po_setup (which just feeds this screen).
   ═══════════════════════════════════════════════════════════════════════════ */
const PO = { accounts:[], carts:[], addresses:[], cap:10, sel:new Set(),
             cartId:null, addrIdx:0, coupons:[], _poolPtr:0, mode:'cod', contactMode:'default', slots:[], results:[] };
function poC(){ return document.getElementById('tab-plugins'); }

async function poOpen(){
  const c = poC(); c.innerHTML = '<div class="center muted mt16">Loading…</div><div class="spin"></div>';
  const r = await apiCall('po_setup', {});
  if(!r || !r.decoded.ok){ c.innerHTML='<div class="warn-box">Could not load Bulk Orders.</div>'; return; }
  PO.accounts = r.decoded.accounts||[]; PO.carts = r.decoded.master_carts||[];
  PO.addresses = r.decoded.master_addresses||[]; PO.cap = r.decoded.cap||10;
  PO.sel = new Set(); PO.cartId = (PO.carts[0]||{}).id||null; PO.addrIdx = 0;
  PO.coupons = []; PO.mode = 'cod'; PO.contactMode = 'default'; PO.slots = []; PO.results = []; PO.suffix = true; PO.jitterMax = 20;
  poRenderSetup();
}

function poBackBtn(){ return `<button class="btn-ghost" id="poBack">‹ Plugins</button>`; }
function poWireBack(){ const b=$('#poBack', poC()); if(b) b.onclick=()=>renderPluginsTab(poC()); }

function poRenderSetup(){
  const c = poC();
  // precondition: need at least one default cart AND one default address
  if(!PO.carts.length || !PO.addresses.length){
    c.innerHTML = `<div class="plug-wrap">${poBackBtn()}<h2 class="plug-h">Bulk Orders</h2>
      <div class="warn-box">You need a <b>default cart</b> and a <b>default address</b> first.
      ${!PO.carts.length?'<br>• No default cart yet — open Cart → save one as a master cart.':''}
      ${!PO.addresses.length?'<br>• No default address yet — open Address → ★ Make master on an address.':''}</div>
      <div class="row-btns">
        <button class="btn-line" id="poGoCart">Go to Cart</button>
        <button class="btn-line" id="poGoAddr">Go to Address</button>
      </div></div>`;
    poWireBack();
    $('#poGoCart', c).onclick=()=>route('cart'); $('#poGoAddr', c).onclick=()=>route('address');
    return;
  }
  const acctRows = PO.accounts.map(a=>`
    <label class="po-acct">
      <input type="checkbox" class="po-ck" data-m="${esc(a.mobile_no)}" ${PO.sel.has(a.mobile_no)?'checked':''}>
      <span class="po-acct-mid"><span class="po-acct-name">${esc(a.name||'BigBasket user')}</span>
        <span class="po-acct-ph">${esc(acctLabel(a))}</span></span>
      ${a.source==='json'?'<span class="acct-tag">JSON</span>':''}${a.source==='scripthub'?'<span class="acct-tag">SHOP</span>':''}
    </label>`).join('');
  const cartRows = PO.carts.map(ct=>`
    <label class="po-pick"><input type="radio" name="poCart" value="${ct.id}" ${ct.id===PO.cartId?'checked':''}>
      <span>${esc(ct.label||'Cart')} <span class="muted">· ${ct.count} item${ct.count===1?'':'s'}</span></span></label>`).join('');
  const addrRows = PO.addresses.map((a,i)=>`
    <label class="po-pick"><input type="radio" name="poAddr" value="${i}" ${i===PO.addrIdx?'checked':''}>
      <span>${esc(a.label||a.nick||'Address')} <span class="muted">· ${esc(a.area||'')} ${esc(a.pincode||'')}</span></span></label>`).join('');
  c.innerHTML = `<div class="plug-wrap">${poBackBtn()}
    <h2 class="plug-h">Bulk Orders</h2>
    <div class="warn-box po-warn">⚠️ Put your <b>personal number</b> in the <b>Landmark</b> box of your default address — that's the number that reaches you for delivery.</div>
    <div class="muted po-mode-note">Mode: <b>${S.orderType==='Scheduled'?'Scheduled':'BB Now'}</b> — change with the BB Now / Sched toggle above.${S.orderType==='Scheduled'?' You’ll pick delivery slots after prepare.':''}</div>
    ${PO.accounts.length?'':'<div class="warn-box">No unused accounts with a saved session are available.</div>'}
    <div class="po-sec"><div class="po-sec-h">1 · Accounts <span class="muted" id="poCount">(0 / ${PO.cap})</span></div>
      <div class="po-acct-list">${acctRows||'<div class="muted">None</div>'}</div></div>
    <div class="po-sec"><div class="po-sec-h">2 · Default cart</div>${cartRows}</div>
    <div class="po-sec"><div class="po-sec-h">3 · Default address <span class="muted">(saved to each account with a 10–20 m jitter)</span></div>${addrRows}
      <div class="po-contact">
        <div class="po-contact-h">Delivery contact number</div>
        <label class="po-chk"><input type="checkbox" id="poCtAcct" ${PO.contactMode==='account'?'checked':''}> Use each account's own number</label>
        <label class="po-chk"><input type="checkbox" id="poCtRand" ${PO.contactMode==='random'?'checked':''}> Use a random number (Indian, starts 7–9)</label>
        <div class="muted po-contact-note">Both off → use the default address's saved number</div>
      </div></div>
    <div class="po-sec"><div class="po-sec-h">4 · Coupon <span class="muted">(optional — one code for all, or one per line for a pool)</span></div>
      <textarea id="poCoupons" class="po-ta" rows="2" placeholder="SAVE100&#10;(or paste several codes, one per line)"></textarea></div>
    <div class="po-sec"><div class="po-sec-h">5 · Payment</div>
      <div class="seg po-seg" id="poMode">
        <button class="seg-opt active" data-m="cod">Cash on Delivery</button>
        <button class="seg-opt" data-m="upi">UPI</button></div></div>
    <div class="po-sec">
      <label class="po-chk"><input type="checkbox" id="poSuffix" ${PO.suffix?'checked':''}> 🎲 Randomise each address — adds random letters to every text field (name, house, apartment, landmark, area) and breaks any number typed into a field. Only pincode and contact number stay unchanged (GPS is jittered by the slider below).</label>
      <div style="margin-top:10px">
        <label style="font-size:13px;color:var(--tx)">Address GPS jitter: <b id="poJitVal">${PO.jitterMax||20}</b> m <span class="muted">(random 10 to value, per account)</span></label>
        <input type="range" id="poJitter" min="10" max="200" step="5" value="${PO.jitterMax||20}" style="width:100%;margin-top:6px">
      </div>
    </div>
    <button class="btn-primary po-start" id="poStart" disabled>Start</button>
  </div>`;
  poWireBack();
  const upd=()=>{ const n=PO.sel.size; $('#poCount',c).textContent=`(${n} / ${PO.cap})`; $('#poStart',c).disabled = n===0; };
  const ctAcct=$('#poCtAcct',c), ctRand=$('#poCtRand',c);
  const syncCt=()=>{ PO.contactMode = (ctAcct&&ctAcct.checked)?'account':((ctRand&&ctRand.checked)?'random':'default'); };
  // Shop (scripthub) accounts can't use "own number" (it would leak into the Address tab). If any is
  // selected, disable JUST that checkbox — random and the default-address number stay available as designed.
  const lockCt=()=>{
    if(!ctAcct) return;
    const hasShop = [...PO.sel].some(m=>{ const a=PO.accounts.find(x=>x.mobile_no===m); return a && a.source==='scripthub'; });
    if(hasShop){ if(ctAcct.checked){ ctAcct.checked=false; syncCt(); } ctAcct.disabled=true; }
    else { ctAcct.disabled=false; }
  };
  $$('.po-ck', c).forEach(ck=>ck.onchange=()=>{
    const m=ck.dataset.m;
    if(ck.checked){ if(PO.sel.size>=PO.cap){ ck.checked=false; showToast(`Max ${PO.cap} accounts`,'error'); return; } PO.sel.add(m); }
    else PO.sel.delete(m);
    upd(); lockCt();
  });
  $$('input[name=poCart]', c).forEach(r=>r.onchange=()=>{ PO.cartId=+r.value; });
  $$('input[name=poAddr]', c).forEach(r=>r.onchange=()=>{ PO.addrIdx=+r.value; });
  $$('#poMode .seg-opt', c).forEach(bt=>bt.onclick=()=>{ PO.mode=bt.dataset.m; $$('#poMode .seg-opt',c).forEach(x=>x.classList.toggle('active',x===bt)); });
  if(ctAcct) ctAcct.onchange=()=>{ if(ctAcct.checked && ctRand) ctRand.checked=false; syncCt(); };
  if(ctRand) ctRand.onchange=()=>{ if(ctRand.checked && ctAcct) ctAcct.checked=false; syncCt(); };
  const sfx=$('#poSuffix',c); if(sfx) sfx.onchange=()=>{ PO.suffix=sfx.checked; };
  const jit=$('#poJitter',c), jitv=$('#poJitVal',c);
  if(jit) jit.oninput=()=>{ PO.jitterMax=+jit.value; if(jitv) jitv.textContent=jit.value; };
  $('#poStart', c).onclick=poStart;
  upd(); lockCt();
}

/* Random lat/lng offset within [minM,maxM] metres at a random bearing, so no two saved addresses
   share byte-identical coordinates (a duplicate-address fraud signal). 1° lat ≈ 111320 m; lng scaled
   by cos(lat). Shared by Bulk Orders and the normal "reuse a default address" save. */
function jitterLatLng(lat, lng, minM, maxM){
  lat = Number(lat)||0; lng = Number(lng)||0;
  const d = minM + (maxM-minM)*Math.random(), br = 2*Math.PI*Math.random();
  const dLat = (d*Math.cos(br))/111320;
  const dLng = (d*Math.sin(br))/(111320*Math.cos(lat*Math.PI/180) || 1);
  return { lat:+(lat+dLat).toFixed(7), lng:+(lng+dLng).toFixed(7) };
}
function poJitter(lat, lng){ const mx=Math.max(10, Math.min(200, (+PO.jitterMax)||20)); return jitterLatLng(lat, lng, 10, mx); }   // Bulk Orders: 10–20 m per account

/* A random valid Indian mobile: first digit 7/8/9, then 9 random digits. */
function poRandomIndianMobile(){ let n = String(7 + Math.floor(Math.random()*3)); for(let i=0;i<9;i++) n += Math.floor(Math.random()*10); return n; }
/* Delivery contact for one account, per the plugin's contact-number choice. A scripthub (shop-bought)
   account may NOT use its own number (it would be saved into the address → visible in the buyer's
   Address tab). If 'own number' is somehow active for one, it falls back to the default-address number.
   Otherwise the toggle drives it as designed: random → random, both-off → default address number. */
function poContactFor(mobile, m, acct){
  const isShop = acct && acct.source==='scripthub';
  if(PO.contactMode==='account') return isShop ? String((m&&m.addressMo)||'').replace(/\D/g,'') : String(mobile||'').replace(/\D/g,'');
  if(PO.contactMode==='random')  return poRandomIndianMobile();
  return String((m&&m.addressMo)||'').replace(/\D/g,'');   // default: the master address's saved number
}

/* Scheduled slots. A slot is matched across accounts by date+window label (its ids differ per PO). */
function poSlotKey(s){ return (s.slot_date||'')+'|'+(s.slot||''); }
async function poGetSlots(checkout){
  const r = await apiCall('bb_get_slots', checkout);
  if(!r || !r.decoded.ok) return [];
  return parseSlots(r.decoded.slots).filter(s=>!s._unavailable);   // available slots only
}
/* Assign the FIRST of the operator's chosen slots (priority order) that's available for this account.
   Returns the checkout with the slot assigned, or null if none of the chosen slots are available. */
async function poAssignSlot(checkout){
  const byKey = {}; (await poGetSlots(checkout)).forEach(s=>{ byKey[poSlotKey(s)] = s; });
  for(const key of PO.slots){
    const s = byKey[key]; if(!s) continue;
    const payload = { ...checkout, slot_date:s.slot_date, slot_definition_id:s.slot_definition_id,
      template_slot_id:s.template_slot_id, shipment_group_id:s.shipment_group_id, shipment_id:s.shipment_id };
    const r = await apiCall('bb_set_slots', payload);
    if(r && r.decoded.ok) return { ...payload, ...r.decoded, encData:checkout.encData };
  }
  return null;
}
function poNextCoupon(){   // '' = no coupon; null = pool exhausted (skip)
  if(!PO.coupons.length) return '';
  if(PO.coupons.length===1) return PO.coupons[0];
  return PO.coupons[PO._poolPtr++] ?? null;
}

async function poStart(){
  PO.coupons = ($('#poCoupons', poC()).value||'').split('\n').map(s=>s.trim()).filter(Boolean);
  PO._poolPtr = 0; PO.results = [];
  const mobiles = [...PO.sel];
  S._poBusy = true;
  try { await poPrepare(mobiles); }
  finally { S._poBusy = false; }
}

/* Live progress list — one row per account through the batch. */
function poStatusText(r){
  const M = { pending:'⏳ waiting', prep:'⏳ preparing…', ready:'✓ ready',
    skip:'⤫ skipped', placing:'⏳ placing…', placed:'✅ ordered (COD)',
    placed_unpaid:'⚠ placed · unpaid', paid:'✅ paid', fail:'⤫ failed' };
  return M[r.status]||r.status;
}
function poRenderProgress(title, foot){
  const c = poC();
  const rows = PO.results.map(r=>`<div class="po-row po-${r.status}">
    <span class="po-row-mid"><b>${esc(r.name||'BigBasket user')}</b><span class="muted"> ${esc(acctLabel({source:r.source,m_id:r.m_id,mobile_no:r.mobile}))}</span>
      ${r.toPay!=null&&r.status!=='skip'&&r.status!=='fail'?`<span class="po-pay">${inr(r.toPay)}</span>`:''}
      ${r.reason?`<span class="po-reason">${esc(r.reason)}</span>`:''}</span>
    <span class="po-stat">${poStatusText(r)}</span></div>`).join('');
  c.innerHTML = `<div class="plug-wrap"><h2 class="plug-h">${esc(title)}</h2>
    <div class="po-prog">${rows||'<div class="muted">…</div>'}</div>
    <div id="poFoot">${foot||''}</div></div>`;
  const b=$('#poFoot', c); return b;
}

async function poPrepare(mobiles){
  PO.results = mobiles.map(m=>{ const a=PO.accounts.find(x=>x.mobile_no===m)||{}; return { mobile:m, name:a.name, source:a.source, m_id:a.m_id, status:'pending', toPay:null, reason:'' }; });
  poRenderProgress('Preparing orders…');
  for(let i=0;i<PO.results.length;i++){
    PO.results[i].status='prep'; poRenderProgress('Preparing orders…');
    const out = await poPrepareAccount(PO.results[i].mobile, PO.results[i].name);
    PO.results[i] = { ...PO.results[i], ...out };
    poRenderProgress('Preparing orders…');
  }
  poRenderReview();
}

async function poPrepareAccount(mobile, name){
  const modeCtx = S.modeCtx, ecid = ECID(), orderType = S.orderType;
  const sw = await apiCall('switch_account', { mobile_no:mobile, mode:modeCtx });
  if(!sw || !sw.decoded.ok) return { status:'skip', reason:(sw&&sw.decoded&&sw.decoded.revoked)?'revoked by BB':((sw&&sw.decoded&&sw.decoded.message)||'switch failed') };
  const enc = sw.decoded.encData;
  // save the default address (jittered) into this account
  const m = PO.addresses[PO.addrIdx] || {};
  const j = poJitter(Number(m.lat)||0, Number(m.lng)||0);
  const obj = { nick:m.nick||'Home', first_name:m.first_name||'', last_name:m.last_name||'',
    house_no:String(m.house_no||''), apartment_name:String(m.apartment_name||''), landmark:String(m.landmark||''),
    area:String(m.area||''), pincode:String(m.pincode||''), lat:j.lat, lng:j.lng,
    addressMo: poContactFor(mobile, m, PO.accounts.find(x=>x.mobile_no===mobile)) };
  // Optional per-account uniqueness (Bulk Orders' own checkbox): randomises every text field + breaks any
  // embedded number. NEVER touches pincode, contact number, lat/lng. (Same logic as manual saves.)
  if(PO.suffix) randomizeAddress(obj);
  const as = await apiCall('bb_address_save', { encData:enc, mobileno:mobile,
    address: btoa(JSON.stringify(obj)), lat_long: btoa(j.lat+'|'+j.lng), from_master:true });
  if(!as || !as.decoded.ok || !as.decoded.address_id) return { status:'skip', reason:'address save failed' };
  const enc2 = as.decoded.encData || enc, addressId = as.decoded.address_id, ourAddress = as.decoded.our_address||'';
  // empty any leftover cart first, so the order is EXACTLY the default cart (no stray items)
  await apiCall('bb_cart_clear', { encData:enc2 });
  // add the default cart's items
  await apiCall('add_master_cart_to_cart', { encData:enc2, cart_id:PO.cartId });
  // checkout the (live) cart against the saved address
  const ck = await poCheckout(enc2, addressId, ourAddress, modeCtx, ecid, orderType);
  if(!ck.ok) return { status:'skip', reason:ck.reason, addressId };
  // coupon (single / pooled) — skip on failure or exhausted pool
  const code = poNextCoupon();
  if(code===null) return { status:'skip', reason:'coupon pool exhausted', addressId };
  let checkout = ck.checkout, applied=false;
  if(code){
    const vr = await poApplyCoupon(checkout, code);
    if(!vr.ok) return { status:'skip', reason:'coupon failed'+(vr.msg?': '+vr.msg:''), addressId, couponCode:code };
    checkout = vr.checkout; applied=true;
  }
  const bill = computeBill(checkout.po_summary||{});
  // Scheduled: fetch THIS account's real delivery slots (used to build the batch slot picker). No slots → skip.
  let slots = [];
  if(orderType==='Scheduled'){
    slots = await poGetSlots(checkout);
    if(!slots.length) return { status:'skip', reason:'no delivery slots', addressId };
  }
  return { status:'ready', addressId, addrObj:obj, ourAddress, couponCode:code, couponApplied:applied,
           toPay:bill.toPay, modeCtx, ecid, orderType, slots };
}

async function poCheckout(enc, addressId, ourAddress, modeCtx, ecid, orderType){
  const r = await apiCall('bb_checkout', { encData:enc, address_id:addressId, lat_long:S.latLng, our_address:ourAddress,
    entry_context_id:ecid, entry_context:modeCtx, options:{ platform:'bigbasket_app', order_type:orderType }, items:[] });
  if(!r || !r.decoded.ok) return { ok:false, reason:(r&&r.decoded&&r.decoded.all_fail)?'all items unavailable':((r&&r.decoded&&r.decoded.message)||'checkout failed') };
  const d = r.decoded;
  if((d.avail_fail && d.avail_fail.length) || d.partial_fail_ok) return { ok:false, reason:'some items unavailable' };
  if(d.next_op==='bb_get_slots') return { ok:false, reason:'needs a delivery slot' };   // scheduled manual — out of scope for v1
  return { ok:true, checkout:{ ...d, encData:enc } };
}

async function poApplyCoupon(checkout, code){
  const r = await apiCall('bb_add_voucher', { ...checkout, voucher:code, voucher_op:'apply', use_wallet:false, use_neucoins:false });
  if(!r || !r.decoded.ok) return { ok:false, msg:(r&&r.decoded&&r.decoded.message)||'not applicable' };
  return { ok:true, checkout:{ ...checkout, ...r.decoded, encData:checkout.encData } };
}

function poRenderReview(){
  const ready = PO.results.filter(r=>r.status==='ready');
  if(!ready.length){
    poRenderProgress('Review', `<div class="warn-box">No account is ready to order.</div><button class="btn-line" id="poCancel">Back to Plugins</button>`);
    const cn=$('#poCancel', poC()); if(cn) cn.onclick=()=>renderPluginsTab(poC());
    return;
  }
  const total = ready.reduce((s,r)=>s+(+r.toPay||0),0);
  const sched = (S.orderType==='Scheduled');
  // Scheduled: batch slot picker (union of ready accounts' available slots), choose 2+ in priority order.
  let slotHtml = '';
  if(sched){
    const map = {};
    ready.forEach(r=>(r.slots||[]).forEach(s=>{ const k=poSlotKey(s); if(!map[k]) map[k]={key:k, date:s.display_slot_date||s.slot_date||'', label:s.slot||'', tod:s.time_of_the_day||''}; }));
    const byDate={}; Object.values(map).forEach(s=>{ (byDate[s.date]=byDate[s.date]||[]).push(s); });
    const groups = Object.keys(byDate).map(dt=>`<div class="po-slot-date">${esc(dt)}</div>`+
      byDate[dt].map(s=>`<label class="po-chk"><input type="checkbox" class="po-slotck" data-k="${esc(s.key)}" ${PO.slots.includes(s.key)?'checked':''}> ${esc(s.label)}${s.tod?' · '+esc(s.tod):''}</label>`).join('')).join('');
    slotHtml = `<div class="po-contact"><div class="po-contact-h">Delivery slots <span class="muted">(pick 2+ — if one is full for an account, the next you picked is used)</span></div>
      <div id="poSlotList">${groups||'<div class="muted">No slots available for the ready accounts</div>'}</div>
      <div class="muted po-contact-note" id="poSlotCount">0 chosen</div></div>`;
  }
  const payLabel = PO.mode==='cod' ? `Place ${ready.length} COD order${ready.length===1?'':'s'}`
                                   : `Pay ${ready.length} order${ready.length===1?'':'s'} — show QR one by one`;
  const foot = `<div class="po-tot">${ready.length} ready · total ${inr(total)} (${PO.mode.toUpperCase()})</div>
    ${slotHtml}
    <button class="btn-primary" id="poConfirm" ${sched && PO.slots.length<2?'disabled':''}>${payLabel}</button>
    <button class="btn-ghost" id="poCancel">Cancel</button>`;
  poRenderProgress('Review', foot);
  const cancel=$('#poCancel', poC()); if(cancel) cancel.onclick=()=>renderPluginsTab(poC());
  if(sched){
    const upd=()=>{ const n=PO.slots.length; const el=$('#poSlotCount',poC()); if(el) el.textContent=`${n} chosen${n<2?' — pick at least 2':''}`; const cf=$('#poConfirm',poC()); if(cf) cf.disabled=n<2; };
    $$('.po-slotck', poC()).forEach(ck=>ck.onchange=()=>{ const k=ck.dataset.k;
      if(ck.checked){ if(!PO.slots.includes(k)) PO.slots.push(k); } else { PO.slots=PO.slots.filter(x=>x!==k); } upd(); });
    upd();
  }
  const conf=$('#poConfirm', poC());
  if(conf) conf.onclick=async()=>{ if(sched && PO.slots.length<2){ showToast('Pick at least 2 slots','error'); return; }
    S._poBusy=true; try{ PO.mode==='cod' ? await poPlaceCOD() : await poUpiSequence(); } finally { S._poBusy=false; } };
}

async function poPlaceCOD(){
  const readyIdx = PO.results.map((r,i)=>r.status==='ready'?i:-1).filter(i=>i>=0);
  for(const i of readyIdx){
    PO.results[i].status='placing'; poRenderProgress('Placing COD orders…');
    const fin = await poFinalize(PO.results[i], 'cod');
    PO.results[i] = { ...PO.results[i], ...fin };
    poRenderProgress('Placing COD orders…');
  }
  await poRestoreActive();
  poRenderSummary();
}

async function poUpiSequence(){
  const readyIdx = PO.results.map((r,i)=>r.status==='ready'?i:-1).filter(i=>i>=0);
  for(const i of readyIdx){
    PO.results[i].status='placing'; poRenderProgress('UPI payment…');
    const fin = await poUpiOne(PO.results[i]);
    PO.results[i] = { ...PO.results[i], ...fin };
    poRenderProgress('UPI payment…');
  }
  await poRestoreActive();
  poRenderSummary();
}

/* Re-establish an account (switch → checkout → coupon) and place it. Address + cart were already
   done in prepare and persist on BB, so they are NOT redone — only the session-scoped checkout is. */
async function poReestablish(res){
  const sw = await apiCall('switch_account', { mobile_no:res.mobile, mode:res.modeCtx });
  if(!sw || !sw.decoded.ok) return { ok:false, reason:'switch failed at placement' };
  const ck = await poCheckout(sw.decoded.encData, res.addressId, res.ourAddress, res.modeCtx, res.ecid, res.orderType);
  if(!ck.ok) return { ok:false, reason:ck.reason };
  let checkout = ck.checkout;
  if(res.couponCode){
    const vr = await poApplyCoupon(checkout, res.couponCode);
    if(!vr.ok) return { ok:false, reason:'coupon failed at placement' };
    checkout = vr.checkout;
  }
  // Scheduled: assign the first chosen slot that's available for this account (else skip it).
  if(res.orderType==='Scheduled'){
    const withSlot = await poAssignSlot(checkout);
    if(!withSlot) return { ok:false, reason:'chosen slots full/unavailable' };
    checkout = withSlot;
  }
  return { ok:true, checkout };
}

async function poFinalize(res, method){
  const re = await poReestablish(res);
  if(!re.ok) return { status:'fail', reason:re.reason };
  const payload = { ...re.checkout, payment_method:method, voucher:res.couponCode||null };
  const pr = await apiCall('bb_place_order', payload);
  if(!pr || !pr.decoded.ok) return { status:'fail', reason:(pr&&pr.decoded&&pr.decoded.message)||'place failed' };
  return { status:'placed' };
}

async function poUpiOne(res){
  const re = await poReestablish(res);
  if(!re.ok) return { status:'fail', reason:re.reason };
  let checkout = re.checkout;
  let jd; try{ jd=extractJuspay(checkout); }catch(e){ return { status:'fail', reason:'no UPI signature' }; }
  const payload = { ...checkout, payment_method:'upi', voucher:res.couponCode||null, juspay_details:jd };
  const pr = await apiCall('bb_place_order', payload);
  if(!pr || !pr.decoded.ok) return { status:'fail', reason:(pr&&pr.decoded&&pr.decoded.message)||'place failed' };
  // order is now placed (pending) — collect payment via QR + poll
  return await poCollectUpi(res, { ...checkout, ...pr.decoded, encData:checkout.encData }, pr.decoded);
}

function poCollectUpi(res, checkout, pd){
  return new Promise(async resolve=>{
    let jd; try{ jd=extractJuspay(checkout); }catch(e){ resolve({ status:'placed_unpaid', reason:'no UPI signature' }); return; }
    const jt = await apiCall('bb_juspay_txn', { bb_txn_id: pd.bb_txn_id||checkout.bb_txn_id,
      order_details: jd.order_details||jd.qc_order_details, signature: jd.signature||jd.qc_signature,
      customer_id: jd.customer_id, merchant_key_id: jd.merchant_key_id||'6729' });
    if(!jt || !jt.decoded.ok){ resolve({ status:'placed_unpaid', reason:'QR generation failed' }); return; }
    const upi = jt.decoded.upi_url || jt.decoded.intent_url || '';
    const amount = jt.decoded.amount || res.toPay || '';
    const orderIds = pd.order_ids || jt.decoded.order_ids, txnId = pd.bb_txn_id||checkout.bb_txn_id;
    let done=false, timer=null, count=0;
    const finish=(r)=>{ if(done)return; done=true; try{clearTimeout(timer);}catch(e){} resolve(r); };
    // render QR under the live progress list
    const links = upiAppLinks(upi);
    poRenderProgress('UPI payment…', `<div class="qr-wrap">
        <div class="qr-amt">${esc(acctLabel({source:res.source,m_id:res.m_id,mobile_no:res.mobile}))} · ${amount?inr(amount):''}</div>
        <div class="qr-box">${upi?`<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(upi)}" alt="UPI QR">`:'<span class="muted">QR unavailable</span>'}</div>
        <div class="qr-hint muted">Scan with any UPI app to pay this account</div>
        ${upiAppButtonsHtml(links)}
        <div class="qr-poll" id="poQrPoll">Waiting for payment…</div>
        <button class="btn-ghost" id="poQrSkip">Skip this account →</button></div>`);
    wireUpiApps(poC(), links);
    const skip=$('#poQrSkip', poC()); if(skip) skip.onclick=()=>{ apiCall('bb_payment_poll',{encData:checkout.encData, order_ids:orderIds, txn_id:txnId, timeout:true}); finish({ status:'placed_unpaid', reason:'skipped by you' }); };
    const tick=async()=>{
      count++;
      const pr=await apiCall('bb_payment_poll', { encData:checkout.encData, order_ids:orderIds, txn_id:txnId, timeout:null });
      const st=((pr&&pr.decoded&&pr.decoded.payment_status)||'').toLowerCase();
      const pn=$('#poQrPoll', poC()); if(pn) pn.textContent='Status: '+(st||'pending')+' ('+count+')';
      if(st.includes('success')||['charged','complete','completed','captured','paid'].includes(st)){ finish({ status:'paid' }); return; }
      if(['failed','authorization_failed','auth_failed','declined','cancelled','canceled','expired'].includes(st)){ finish({ status:'placed_unpaid', reason:'payment '+st }); return; }
      if(count>=40){ await apiCall('bb_payment_poll',{encData:checkout.encData, order_ids:orderIds, txn_id:txnId, timeout:true}); finish({ status:'placed_unpaid', reason:'payment timeout' }); return; }
      timer=setTimeout(tick, 5000);
    };
    timer=setTimeout(tick, 5000);
  });
}

/* Return the server session to whatever account the user had active before the batch. */
async function poRestoreActive(){ if(S.activePhone){ try{ await apiCall('switch_account',{ mobile_no:S.activePhone, mode:S.modeCtx }); }catch(e){} } }

function poRenderSummary(){
  const placed = PO.results.filter(r=>r.status==='placed').length;
  const paid   = PO.results.filter(r=>r.status==='paid').length;
  const unpaid = PO.results.filter(r=>r.status==='placed_unpaid').length;
  const skip   = PO.results.filter(r=>r.status==='skip').length;
  const fail   = PO.results.filter(r=>r.status==='fail').length;
  const bits = [];
  if(placed) bits.push(`✅ ${placed} COD placed`);
  if(paid)   bits.push(`✅ ${paid} paid`);
  if(unpaid) bits.push(`⚠ ${unpaid} placed·unpaid`);
  if(skip)   bits.push(`⤫ ${skip} skipped`);
  if(fail)   bits.push(`⤫ ${fail} failed`);
  const foot = `<div class="po-tot">${bits.join(' · ')||'Nothing processed'}</div>
    <button class="btn-primary" id="poDone">Done</button>
    <button class="btn-ghost" id="poOrders">View orders</button>`;
  poRenderProgress('Summary', foot);
  const d=$('#poDone', poC()); if(d) d.onclick=()=>renderPluginsTab(poC());
  const o=$('#poOrders', poC()); if(o) o.onclick=()=>route('orders');
}
function route(name){
  $$('#bottomNav .nav-item').forEach(b=>b.classList.toggle('active', b.dataset.nav===name));
  $$('.tab').forEach(t=>{ t.hidden = t.dataset.tab!==name; });
  // Always reload the cart fresh each time the Cart tab is opened (server is the source of truth —
  // items may have changed, been ordered, or migrated). renderCartTab then re-fetches via preloadCart.
  if(name==='cart') S._cartLoadedFor=null;
  const fn = TAB_RENDER[name];
  if(fn) fn($('#tab-'+name));
}

/* ═══════════════════════════════════════════════════════════════
   FULL-SCREEN LOGIN FLOW
   validate(gate done) → bb_signup_otp/signup_otp → [show_number_check
   → send_otp_continue] → verify → render_app_selection → app_selection
   → bb_initialize → bb_login → bb_app_data → bb_address_list
   ═══════════════════════════════════════════════════════════════ */
function openLogin(allowClose){
  S._loginAdding = !!allowClose;   // true = "+ Add account" (already in app) → return to Accounts after login
  $('#loginScreen').style.display='flex';
  $('#login_close').style.display = allowClose ? 'block' : 'none';
  // When there's no ✕ (new user, 0 accounts — forced here at boot), offer a way back to the access
  // gate so they aren't trapped into adding an account just to change the access code.
  { const lo=$('#login_logout'); if(lo) lo.style.display = allowClose ? 'none' : 'block'; }
  resetLoginSteps();
  $('#login_title').textContent = S.accounts.length ? 'Add a BigBasket account' : 'Login to BigBasket';
}
function closeLogin(){ $('#loginScreen').style.display='none'; }
function resetLoginSteps(){
  showLoginStep('phone');
  $('#login_err').textContent=''; $('#login_spin').style.display='none';
  $('#login_phone').value=''; $('#login_otp').value='';
}
function showLoginStep(step){
  ['phone','numcheck','otp','appsel','json'].forEach(s=>{
    const node=$('#login_'+s+'_step'); if(node) node.style.display = (s===step)?'block':'none';
  });
  const sub=$('#login_sub');
  if(sub) sub.textContent = step==='otp'    ? 'Enter the OTP sent to your number'
                          : step==='appsel' ? 'Signing you in...'
                          : step==='json'   ? 'Paste your BigBasket login token'
                          : "We'll send an OTP to verify your number";
}
function loginBusy(b){ $('#login_spin').style.display=b?'block':'none'; }
function loginErr(m){ $('#login_err').textContent=m||''; }

function wireLogin(){
  $('#login_close').addEventListener('click', closeLogin);
  { const lo=$('#login_logout'); if(lo) lo.addEventListener('click', ()=>{ if(confirm('End this session and enter a different access code?')) logoutAndReset(); }); }
  // method seg
  $$('#login_method_seg .seg-opt').forEach(b=>b.addEventListener('click',()=>{
    $$('#login_method_seg .seg-opt').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); S.loginMethod=b.dataset.m;
  }));
  // order type seg
  $$('#login_ordertype_seg .seg-opt').forEach(b=>b.addEventListener('click',()=>{
    $$('#login_ordertype_seg .seg-opt').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); S.orderType=b.dataset.o;
  }));
  $('#login_send').addEventListener('click', loginSendOtp);
  $('#login_continue').addEventListener('click', loginNumberContinue);
  $('#login_numback').addEventListener('click', ()=>{ showLoginStep('phone'); });
  $('#login_verify').addEventListener('click', loginVerifyOtp);
  $('#login_resend').addEventListener('click', ()=>{ resetLoginSteps(); });
  $('#login_appsel_go').addEventListener('click', loginAppSelection);
  $('#login_appsel_back') && $('#login_appsel_back').addEventListener('click', ()=>{ loginErr(''); resetLoginSteps(); });
  // JSON-token login (shown in both homepage login and "+ Add account")
  $('#login_json_show') && $('#login_json_show').addEventListener('click', ()=>{ loginErr(''); showLoginStep('json'); });
  $('#login_json_back') && $('#login_json_back').addEventListener('click', ()=>{ loginErr(''); showLoginStep('phone'); });
  $('#login_json_go')   && $('#login_json_go').addEventListener('click', loginJsonSubmit);
  $('#login_json_file') && $('#login_json_file').addEventListener('change', async (e)=>{
    const files=e.target.files; if(!files || !files.length) return;
    loginErr(''); const st=$('#login_json_bulk_status'); if(st) st.textContent='Reading file(s)…';
    let objs=[]; try{ objs=await jsonCollectFromFiles(files); }catch(err){ if(st) st.textContent='Could not read file(s)'; }
    e.target.value='';
    await jsonBulkImport(objs);
  });
}

async function loginJsonSubmit(){
  loginErr('');
  const raw = $('#login_json').value.trim();
  if(!raw){ loginErr('Paste the JSON token(s) first'); return; }
  const objs = parseJsonsJs(raw);
  if(objs.length===0){ loginErr('No valid JSON with "bbAuthToken" found'); return; }
  if(objs.length>1){ return jsonBulkImport(objs); }   // multiple pasted → bulk add
  const obj = objs[0];
  loginBusy(true); $('#login_json_go').disabled=true;
  try{
    const r = await apiCall('bb_json_login', { json: JSON.stringify(obj), order_type:S.orderType });
    if(!r){ loginErr('Session error'); return; }
    if(!r.decoded.ok){ loginErr(r.decoded.message || 'JSON login failed'); return; }
    if(r.decoded.encData) S.encData = r.decoded.encData;
    S.loggedIn = true;
    S.activePhone = r.decoded.mobileno || S.activePhone;
    closeLogin();
    await loadAccountsRoster(false);
    showShell();
    route('search');
    showToast(r.decoded.message || 'Logged in','success');
  } finally { loginBusy(false); $('#login_json_go').disabled=false; }
}

/* Parse pasted/file text into account JSON objects — a JSON array, a single object, or several
   objects separated by commas / newlines / back-to-back. Brace-matched (JWT/base64 values never
   contain { }, so this is safe). Accepts BOTH key styles and normalises to the camelCase keys the
   backend (bb_json_login) expects: camel {bbAuthToken,mId,bbVisitorId} OR snake {bb_token,m_id,visitor_id}. */
function normAcctJson(o){
  if(!o || typeof o!=='object') return null;
  const tok = o.bbAuthToken || o.bb_token;
  if(!tok) return null;
  return { ...o,
    bbAuthToken: tok,
    mId:         o.mId || o.m_id || '',
    bbVisitorId: o.bbVisitorId || o.visitor_id || '' };
}
function parseJsonsJs(raw){
  raw=(raw||'').trim(); if(!raw) return [];
  try{
    const j=JSON.parse(raw);
    const norm=(Array.isArray(j)?j:[j]).map(normAcctJson).filter(Boolean);
    if(norm.length) return norm;
  }catch(e){}
  const out=[]; let depth=0,start=-1;
  for(let i=0;i<raw.length;i++){ const c=raw[i];
    if(c==='{'){ if(depth===0) start=i; depth++; }
    else if(c==='}'){ depth--; if(depth===0 && start>=0){ try{ const o=normAcctJson(JSON.parse(raw.slice(start,i+1))); if(o) out.push(o); }catch(e){} start=-1; } }
  }
  return out;
}
/* Read account JSONs out of uploaded files. .json/.txt → text; .zip → unzip its .json/.txt entries. */
async function jsonCollectFromFiles(files){
  let objs=[];
  for(const f of files){
    const ext=(f.name.split('.').pop()||'').toLowerCase();
    if(ext==='zip'){
      try{ const entries=await unzipEntries(await f.arrayBuffer());
        for(const e of entries){ const x=(e.name.split('.').pop()||'').toLowerCase(); if(x==='json'||x==='txt') objs=objs.concat(parseJsonsJs(e.text)); } }
      catch(err){ showToast('Could not read '+f.name,'error'); }
    } else { try{ objs=objs.concat(parseJsonsJs(await f.text())); }catch(e){} }   // .json/.txt (or any text)
  }
  return objs;
}
/* Minimal in-browser unzip: reads the central directory and inflates stored/deflate entries via
   DecompressionStream. Returns [{name,text}]. No external library. */
async function unzipEntries(buf){
  const dv=new DataView(buf), u8=new Uint8Array(buf), td=new TextDecoder();
  let eocd=-1; for(let i=buf.byteLength-22;i>=0;i--){ if(dv.getUint32(i,true)===0x06054b50){ eocd=i; break; } }
  if(eocd<0) throw new Error('not a zip');
  const count=dv.getUint16(eocd+10,true); let p=dv.getUint32(eocd+16,true); const meta=[];
  for(let n=0;n<count;n++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true), compSize=dv.getUint32(p+20,true);
    const nl=dv.getUint16(p+28,true), el=dv.getUint16(p+30,true), cl=dv.getUint16(p+32,true);
    const off=dv.getUint32(p+42,true), name=td.decode(u8.subarray(p+46,p+46+nl));
    meta.push({name,method,compSize,off}); p+=46+nl+el+cl;
  }
  const out=[];
  for(const m of meta){
    const lp=m.off; if(dv.getUint32(lp,true)!==0x04034b50) continue;
    const lnl=dv.getUint16(lp+26,true), lel=dv.getUint16(lp+28,true);
    const start=lp+30+lnl+lel, comp=u8.subarray(start,start+m.compSize);
    let text;
    if(m.method===0){ text=td.decode(comp); }
    else if(m.method===8 && typeof DecompressionStream!=='undefined'){ text=await new Response(new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text(); }
    else continue;
    out.push({name:m.name, text});
  }
  return out;
}
/* Add many accounts by looping the proven bb_json_login op (each member/details-validated). Progress
   is shown in #login_json_bulk_status; the shared busy overlay/toasts are muted during the loop. */
async function jsonBulkImport(objects){
  const seen=new Set();
  const list=(objects||[]).filter(o=>{ const t=o&&o.bbAuthToken; if(!t||seen.has(t)) return false; seen.add(t); return true; });
  const st=$('#login_json_bulk_status');
  if(!list.length){ loginErr('No valid account JSONs found (need "bbAuthToken")'); if(st) st.textContent=''; return; }
  let added=0,dupe=0,dead=0,fail=0;
  loginBusy(true); $('#login_json_go').disabled=true; S._poBusy=true;
  try{
    for(let i=0;i<list.length;i++){
      if(st) st.textContent=`Importing ${i+1} / ${list.length} … ✓${added} · dup ${dupe} · dead ${dead} · fail ${fail}`;
      let r=null; try{ r=await apiCall('bb_json_login', { json: JSON.stringify(list[i]), order_type:S.orderType }); }catch(e){}
      const d=r&&r.decoded;
      if(d&&d.ok){ added++; if(d.encData) S.encData=d.encData; S.activePhone=d.mobileno||S.activePhone; }
      else if(d&&d.already_exists) dupe++;
      else if(d&&/revoke|expire|authenticate|did not/i.test(d.message||'')) dead++;
      else fail++;
    }
  } finally { S._poBusy=false; loginBusy(false); $('#login_json_go').disabled=false; }
  if(st) st.textContent=`Done — added ${added}, duplicate ${dupe}, dead ${dead}, failed ${fail}`;
  showToast(`Bulk: ${added} added · ${dupe} dup · ${dead} dead · ${fail} failed`, added?'success':'error');
  if(added>0){ S.loggedIn=true; await loadAccountsRoster(false); closeLogin(); showShell(); route('accounts'); }
}

async function loginSendOtp(){
  const phone = $('#login_phone').value.replace(/\D/g,'');
  loginErr('');
  if(phone.length!==10){ loginErr('Enter a valid 10-digit number'); return; }
  S.loginPhone = phone;
  const checker = $('#login_checker').checked;
  // re-validate access with the phone so server links phone↔code + sets checker flag
  loginBusy(true); $('#login_send').disabled=true;
  try{
    const v = await apiCall('validate_access_code', {code:S.access.code, phone, context:'order', checker_enabled:checker});
    if(v && v.decoded && !v.decoded.ok){ loginErr(v.decoded.message||'Phone rejected for this code'); return; }
    const op = S.loginMethod==='bb' ? 'bb_signup_otp' : 'signup_otp';
    const r = await apiCall(op, {phone});
    if(!r){ loginErr('Session error'); return; }
    routeLogin(r.decoded);
  }catch(e){ loginErr('Network error'); }
  finally{ loginBusy(false); $('#login_send').disabled=false; }
}

async function loginNumberContinue(){
  loginErr(''); loginBusy(true); $('#login_continue').disabled=true;
  try{
    const r = await apiCall('send_otp_continue', {login_method:S.loginMethod});
    if(!r){ loginErr('Session error'); return; }
    routeLogin(r.decoded);
  } finally { loginBusy(false); $('#login_continue').disabled=false; }
}

async function loginVerifyOtp(){
  const otp = $('#login_otp').value.replace(/\D/g,'');
  loginErr('');
  if(otp.length<4){ loginErr('Enter the OTP'); return; }
  const op = S.loginMethod==='bb' ? 'bb_verify_otp' : 'verify_otp';
  loginBusy(true); $('#login_verify').disabled=true;
  try{
    const r = await apiCall(op, {otp});
    if(!r){ loginErr('Session error'); return; }
    if(!r.decoded.ok){ loginErr(r.decoded.message || 'OTP verification failed'); return; }
    routeLogin(r.decoded);
  } finally { loginBusy(false); $('#login_verify').disabled=false; }
}

/* drive login next_op locally (login is a forced screen, not the main router) */
function routeLogin(d){
  if(d && d.login_method) S.loginMethod = d.login_method;
  const next = d && d.next_op;
  switch(next){
    case 'show_number_check': {
      showLoginStep('numcheck');
      const status = d.number_status==='old' ? 'This number looks <b>already used</b>.' :
                     d.number_status==='new' ? 'This appears to be a <b>fresh</b> number.' :
                     'Number checked.';
      const nb=$('#login_numcheck_body');
      nb.className = 'numcheck-body ' + (d.number_status==='old' ? 'warn' : d.number_status==='new' ? 'ok' : '');
      nb.innerHTML = status + '<br><span class="muted">Tap Continue to receive the OTP.</span>';
      break;
    }
    case 'bb_verify_otp':
    case 'verify_otp':
      showLoginStep('otp');
      $('#login_otp').value=''; $('#login_otp').focus();
      break;
    case 'render_app_selection':
      if(d.encData) S.encData = d.encData;     // carry the credential blob forward
      showLoginStep('appsel');
      // After verifying, don't make the user tap "Login & Order" — auto-run the login chain and land in the
      // app. Deferred so loginVerifyOtp's finally (spinner off) runs first, then loginAppSelection re-shows it.
      // The appsel screen stays as a fallback (with its error) only if the chain fails.
      setTimeout(loginAppSelection, 0);
      break;
    case 'checkout_failed':
    case 'checker_failed':
      loginErr('Number checker failed for this number.');
      showLoginStep('phone');
      break;
    case 'end':
      loginErr(d.message || 'Cannot proceed with this number.');
      showLoginStep('phone');
      break;
    default:
      // OTP-sent responses sometimes rename op to send_otp with next_op verify
      if(next==='send_otp'){ showLoginStep('otp'); break; }
      loginErr(d && d.message ? d.message : 'Unexpected step: '+next);
  }
}

/* app_selection submit → kicks off the bb_initialize chain */
async function loginAppSelection(){
  loginErr(''); loginBusy(true); $('#login_appsel_go').disabled=true;
  try{
    const r = await apiCall('app_selection', {
      encData: S.encData,   // forward the credential blob so bb_initialize decrypts a REAL mobile_no,
                            // restores the cookies verify_otp saved to the DB, and SKIPS the slow
                            // BigbasketInit proxy call — the missing mobile_no was forcing that extra
                            // upstream call every time, which is what intermittently timed out.
      app:'bigbasket',
      options:{ context:'bblogin_and_orders', order_type:S.orderType }
    });
    if(!r || !r.decoded.ok){ loginErr((r&&r.decoded.message)||'App selection failed'); return; }
    // run the auto-chain bb_initialize → bb_login → bb_app_data → bb_address_list
    const ok = await runLoginChain(r.decoded);
    if(ok){
      S.loggedIn = true;
      S.activePhone = r.decoded.mobileno || S.loginPhone || S.activePhone;
      closeLogin();
      await loadAccountsRoster(false);
      showShell();
      route(S._loginAdding ? 'accounts' : 'search');   // adding an account → Accounts tab; first login → Search
      showToast('Logged in','success');
    }
  } finally { loginBusy(false); $('#login_appsel_go').disabled=false; }
}

/* Auto-fire the bb_initialize → bb_login → bb_app_data → bb_address_list chain.
   Returns true on reaching render_address_manager. Captures encData + latLng. */
async function runLoginChain(decoded){
  // Adding / re-logging a NEW account makes it the active account WITHOUT going through switchAccount.
  // Drop any previous account's cached address state so ensureAddresses()/checkout don't reuse the old
  // account's address_id + latLng; seedDefaultAddress() below re-seeds fresh values for this account.
  S.addrDecoded=null; S._activeAddr=null; S.selectedAddressId=null; S.latLng=null; S.ourAddress=null;
  let cur = decoded;
  const order = {
    'bb_initialize':'bb_login',
    'bb_login':'bb_app_data',
    'bb_app_data':'bb_address_list',
    'bb_address_list':null,
  };
  let next = cur.next_op; // 'bb_initialize'
  let guard=0;
  while(next && order.hasOwnProperty(next) && guard++<8){
    let r = await apiCall(next, cur);
    if(!r){
      // Transient null = slow proxy / gateway 504 / dropped connection during bb_initialize's upstream
      // BigbasketInit+DoorInfo calls. The server session and access code are still intact and every op in
      // this chain is idempotent, so retry ONCE after a short pause before failing. This is exactly what
      // was surfacing as the intermittent "Session initialize failed".
      await new Promise(res=>setTimeout(res, 900));
      r = await apiCall(next, cur);
    }
    if(!r){ loginErr('Could not reach the server during '+next+' — please try again.'); return false; }
    cur = r.decoded;
    if(cur.encData) S.encData = cur.encData;
    if(cur.lat_long) S.latLng = cur.lat_long;
    if(!cur.ok && next!=='bb_login'){ loginErr(cur.message||('Failed at '+next)); /* keep going if BB list empty */ }
    next = cur.next_op;
    if(next==='render_address_manager'){ seedDefaultAddress(cur); return true; }
  }
  seedDefaultAddress(cur);
  return next==='render_address_manager' || !!S.encData;
}

/* Seed S.latLng + S.selectedAddressId from the current/default address so search
   has a location BEFORE the user manually picks one (review fix #1). */
function seedDefaultAddress(d){
  const addrs=(d&&d.addresses)||[];
  if(!addrs.length) return;
  const a = addrs.find(x=>x.is_current_delivery) || addrs.find(x=>x.is_default) || addrs[0];
  if(!a) return;
  if(!S.selectedAddressId) S.selectedAddressId=a.id;
  if(!S.latLng && a.lat && a.lng) S.latLng = btoa(`${a.lat}|${a.lng}`);
  if(!S.ourAddress) S.ourAddress=`${a.first_name||''} ${a.last_name||''} ${a.address1||''}, ${a.area||''} ${a.city_name||''} ${a.pin||''}`.replace(/\s+/g,' ').trim();
}

/* Pull juspay order_details+signature from the CURRENT po_summary. IMPORTANT: always prefer the fresh
   po_summary over any top-level src.juspay_details — that top-level value gets frozen on the first UPI
   order and, since Telegram keeps one long-lived WebView across many orders, a later order would reuse
   order #1's signature (bound to a consumed bb_txn_id) → Juspay rejects it → "UPI init failed" after a
   couple of orders. The top-level value is only a last-resort fallback. */
function extractJuspay(src){
  src=src||{};
  const po=src.po_summary||{};
  if(po.juspay_details) return po.juspay_details;
  const od=po.order_details;
  if(od && (po.signature||po.qc_signature)){
    return {
      order_details: typeof od==='string'?od:JSON.stringify(od),
      signature: po.signature||po.qc_signature,
      customer_id: (od && typeof od==='object')?od.customer_id:undefined,
      merchant_key_id: po.merchant_key_id||'6729'
    };
  }
  // No FRESH signature on the current po_summary — NEVER reuse a stale/cached one (it's bound to a
  // consumed bb_txn_id and would always be rejected by Juspay). Fail loudly; the caller aborts cleanly.
  throw new Error('No fresh UPI signature in the current checkout');
}

/* ═══════════════════════════════════════════════════════════════
   SEARCH TAB
   ═══════════════════════════════════════════════════════════════ */
function ensureActiveAccount(container, label){
  if(S.encData) return true;
  if(S.accounts.length>0){
    container.innerHTML='';
    container.appendChild(el('div','empty',
      `<div class="e-emoji">👤</div>Pick an account first to ${esc(label||'continue')}.<br><br>
       <button class="btn-line" onclick="route('accounts')">Go to Accounts</button>`));
  } else {
    openLogin(false);
  }
  return false;
}

function renderSearchTab(c){
  if(!ensureActiveAccount(c,'shop')) return;
  preloadCart();   // reflect the account's existing cart on the steppers (loads once per account)
  c.innerHTML = `
    <div class="search-wrap">
      <div class="search-bar">
        <span class="sb-ico">🔍</span>
        <input id="searchInput" type="text" placeholder="Search milk, eggs, atta…" autocomplete="off">
      </div>
      <div id="suggBox"></div>
    </div>
    <div id="filterBar" class="filter-bar" hidden></div>
    <div id="searchResults"></div>`;
  const inp = $('#searchInput', c);
  let tmr=null;
  inp.addEventListener('input', ()=>{
    const q=inp.value.trim();
    clearTimeout(tmr);
    if(q.length<3){ $('#suggBox').innerHTML=''; return; }
    tmr=setTimeout(()=>fetchSuggestions(q), 220);
  });
  inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ $('#suggBox').innerHTML=''; runSearch(inp.value.trim()); }});
  window.onscroll = ()=>{
    if(($('#tab-search').hidden)) return;
    if(!S.searchHasMore || S.searchLoading) return;
    if(window.innerHeight + window.scrollY >= document.body.offsetHeight - 240) loadMoreProducts();
  };
}

async function fetchSuggestions(q){
  try{
    const data = await proxyGet({term:q}, S.latLng);
    const list = (data.terms_info||[]).slice(0,8);
    const box = $('#suggBox'); if(!box) return;
    if(!list.length){ box.innerHTML=''; return; }
    box.innerHTML = `<div class="sugg">${list.map(t=>
      `<div class="sugg-item" data-t="${esc(t.term)}"><span class="s-ico">🔍</span>${esc(t.term)}</div>`).join('')}</div>`;
    $$('.sugg-item', box).forEach(it=>it.addEventListener('click',()=>{
      $('#searchInput').value = it.dataset.t; box.innerHTML=''; runSearch(it.dataset.t);
    }));
  }catch(e){ /* ignore */ }
}

async function runSearch(term, keepFilters){
  if(!term){ return; }
  S.searchSlug=term; S.searchPage=1; S.searchTotalPages=1; S.searchHasMore=false;
  if(!keepFilters){ S.searchSort=''; S.searchFilters=[]; S.searchSortOpts=[]; S.searchFilterOpts=[]; S.searchTotalCount=0; const fb=$('#filterBar'); if(fb){ fb.hidden=true; fb.innerHTML=''; } }
  const rc=$('#searchResults');
  rc.innerHTML = `<div class="skel-grid">${'<div class="skel"></div>'.repeat(6)}</div>`;
  await loadProductsPage(1, true);
}

async function loadMoreProducts(){
  if(!S.searchHasMore || S.searchLoading) return;
  await loadProductsPage(S.searchPage+1, false);
}

async function loadProductsPage(page, replace){
  S.searchLoading=true;
  try{
    const params = {products:1, slug:S.searchSlug, page};
    if(S.searchSort)          params.sort    = S.searchSort;
    if(S.searchFilters.length) params.filters = JSON.stringify(S.searchFilters);
    const data = await proxyGet(params, S.latLng);
    const rc=$('#searchResults');
    if(data.error){ if(replace) rc.innerHTML=`<div class="empty"><div class="e-emoji">😕</div>${esc(data.display_msg||'Search unavailable right now.')}</div>`; return; }
    const tab = data?.tabs?.[0] || {};
    const products = tab?.product_info?.products || [];
    S.searchPage = data._page || page;
    S.searchTotalPages = data._total_pages || tab?.product_info?.number_of_pages || 1;
    S.searchHasMore = !!data._has_more;
    // capture filter/sort definitions + count from the (page-1) response
    if(replace){
      if((tab.filter_opts||[]).length) S.searchFilterOpts = tab.filter_opts;
      if((tab.sort_opts||[]).length)   S.searchSortOpts   = tab.sort_opts;
      S.searchTotalCount = tab?.product_info?.total_count || products.length;
      renderFilterBar();
    }
    let grid = $('#productGrid');
    if(replace || !grid){
      rc.innerHTML = `<div class="grid" id="productGrid"></div><div class="load-more" id="loadMore"></div>`;
      grid = $('#productGrid');
    }
    if(replace && products.length===0){ rc.innerHTML=`<div class="empty"><div class="e-emoji">🔎</div>No products${(S.searchFilters.length||S.searchSort)?' match these filters':` for “${esc(S.searchSlug)}”`}.</div>`; return; }
    products.forEach(p=>grid.appendChild(productCard(p)));
    $('#loadMore').textContent = S.searchHasMore ? 'Loading more…' : (products.length?'· end of results ·':'');
  }catch(e){ /* ignore */ }
  finally{ S.searchLoading=false; }
}

/* ════════ SEARCH FILTERS + SORT ════════ */
const SORT_DEFAULT = [
  {display_name:'Relevance', value:'relevance'},
  {display_name:'Price(low to high)', value:'pricelth'},
  {display_name:'Price(high to low)', value:'pricehtl'},
  {display_name:'Discount(high to low)', value:'dphtl'},
];
function activeFilter(type){ return S.searchFilters.find(f=>f.type===type); }
function filterCount(){ return S.searchFilters.reduce((n,f)=>n+(f.values?.length||0),0) + (S.searchSort && S.searchSort!=='relevance' ? 1 : 0); }

function renderFilterBar(){
  const bar=$('#filterBar'); if(!bar) return;
  const opts=S.searchFilterOpts||[];
  if(!opts.length){ bar.hidden=true; bar.innerHTML=''; return; }
  const nSel=filterCount();
  const chips = opts.map(o=>{
    const af=activeFilter(o.type); const n=af?.values?.length||0;
    return `<button class="fchip${n?' on':''}" data-sec="${esc(o.type)}">${esc(o.name)}${n?` (${n})`:''} <span class="fchip-caret">▾</span></button>`;
  }).join('');
  const sortName = (S.searchSortOpts.find(s=>s.value===(S.searchSort||'relevance'))||{}).display_name || 'Relevance';
  bar.hidden=false;
  bar.innerHTML = `
    <button class="fchip fchip-main" data-sec="__main">⚙ Filter & Sort${nSel?` · ${nSel}`:''}</button>
    <button class="fchip${S.searchSort&&S.searchSort!=='relevance'?' on':''}" data-sec="__sort">Sort: ${esc(sortName)} <span class="fchip-caret">▾</span></button>
    ${chips}
    <span class="fbar-count">${S.searchTotalCount} products</span>`;
  $$('.fchip', bar).forEach(b=> b.onclick = ()=> openFilterSheet(b.dataset.sec==='__main' ? (S.searchSortOpts.length?'__sort':opts[0].type) : b.dataset.sec));
}

let _draft = null;    // {sort, filters:[{type,name,values[],level}]}
let _countTmr = null;
function openFilterSheet(section){
  // work on a draft; commit only on "Show N products"
  _draft = { sort: S.searchSort||'relevance', filters: JSON.parse(JSON.stringify(S.searchFilters||[])) };
  const opts = S.searchFilterOpts||[];
  const sortOpts = (S.searchSortOpts&&S.searchSortOpts.length)?S.searchSortOpts:SORT_DEFAULT;
  const sections = [{key:'__sort', name:'Sort by', _sort:true}, ...opts.map(o=>({key:o.type, name:o.name, opt:o}))];
  let active = section || sections[0].key;

  openSheet('Filters', (body)=>{
    body.innerHTML = `
      <div class="flt">
        <div class="flt-side" id="fltSide"></div>
        <div class="flt-main" id="fltMain"></div>
      </div>
      <div class="flt-foot">
        <button class="flt-clear" id="fltClear">Clear</button>
        <button class="flt-show" id="fltShow">Show products</button>
      </div>`;
    const side=$('#fltSide',body), main=$('#fltMain',body);
    const draftCount=(type)=> (_draft.filters.find(f=>f.type===type)?.values?.length)||0;

    function paintSide(){
      side.innerHTML = sections.map(s=>{
        const n = s._sort ? (_draft.sort&&_draft.sort!=='relevance'?1:0) : draftCount(s.key);
        return `<button class="flt-tab${s.key===active?' on':''}" data-k="${esc(s.key)}">${esc(s.name)}${n?`<span class="flt-badge">${n}</span>`:''}</button>`;
      }).join('');
      $$('.flt-tab',side).forEach(b=>b.onclick=()=>{ active=b.dataset.k; paintSide(); paintMain(); });
    }
    function paintMain(){
      if(active==='__sort'){
        main.innerHTML = sortOpts.map(s=>`
          <label class="flt-opt"><span>${esc(s.display_name)}</span>
            <input type="radio" name="fsort" value="${esc(s.value)}" ${(_draft.sort||'relevance')===s.value?'checked':''}></label>`).join('');
        $$('input[name=fsort]',main).forEach(r=>r.onchange=()=>{ _draft.sort=r.value; paintSide(); refreshCount(); });
        return;
      }
      const opt = (opts.find(o=>o.type===active))||{values:[]};
      const cur = _draft.filters.find(f=>f.type===active)?.values || [];
      const vals = opt.values||[];
      const searchable = vals.length>8;
      main.innerHTML = `
        ${searchable?`<div class="flt-search"><input id="fltSearch" placeholder="Search ${esc(opt.name)}"></div>`:''}
        <div class="flt-opts" id="fltOpts">${vals.map(v=>optRow(opt,v,cur)).join('')}</div>`;
      wireOpts(opt);
      if(searchable){ $('#fltSearch',main).oninput=(e)=>{ const q=e.target.value.toLowerCase();
        $$('.flt-opt',main).forEach(row=>{ row.hidden = !row.dataset.name.includes(q); }); }; }
    }
    function optRow(opt,v,cur){
      const val=String(v.slug ?? v.url ?? v.name);
      const on=cur.includes(val);
      return `<label class="flt-opt" data-name="${esc(String(v.name).toLowerCase())}">
        ${v.image?`<img class="flt-ico" src="${esc(v.image)}" alt="">`:''}
        <span>${esc(v.name)}</span>
        <input type="checkbox" value="${esc(val)}" ${on?'checked':''}></label>`;
    }
    function wireOpts(opt){
      $$('#fltOpts input[type=checkbox]',main).forEach(cb=>cb.onchange=()=>{
        let f=_draft.filters.find(x=>x.type===opt.type);
        if(!f){ f={type:opt.type, name:opt.name, values:[], level:0}; _draft.filters.push(f); }
        if(cb.checked){ if(!f.values.includes(cb.value)) f.values.push(cb.value); }
        else { f.values=f.values.filter(x=>x!==cb.value); }
        _draft.filters = _draft.filters.filter(x=>x.values.length);
        paintSide(); refreshCount();
      });
    }
    async function refreshCount(){
      const btn=$('#fltShow'); if(!btn) return;
      btn.textContent='Show …'; clearTimeout(_countTmr);
      _countTmr=setTimeout(async()=>{
        try{
          const p={count:1, slug:S.searchSlug};
          if(_draft.sort&&_draft.sort!=='relevance') p.sort=_draft.sort;
          if(_draft.filters.length) p.filters=JSON.stringify(_draft.filters);
          const r=await proxyGet(p, S.latLng);
          btn.textContent = (r && r.count!=null) ? `Show ${r.count} products` : 'Show products';
        }catch(e){ btn.textContent='Show products'; }
      }, 250);
    }

    paintSide(); paintMain(); refreshCount();
    $('#fltClear',body).onclick=()=>{ _draft={sort:'relevance',filters:[]}; paintSide(); paintMain(); refreshCount(); };
    $('#fltShow',body).onclick=()=>{
      S.searchSort = _draft.sort==='relevance' ? '' : _draft.sort;
      S.searchFilters = _draft.filters;
      closeSheet();
      runSearch(S.searchSlug, true);
    };
  });
}

function productToItem(p){
  return {
    pid: String(p.id),
    fcid: p?.inv_info?.skus?.[0]?.fc_id ?? '',
    desc: p.desc,
    sp: +(p?.pricing?.discount?.prim_price?.sp ?? 0),
    img: p?.images?.[0]?.m || p?.images?.[0]?.s || '',
    w: p.w || '',
    qty: 0,
  };
}

function variantPack(v){ return v.w || v.pack_desc || (v.magnitude?`${v.magnitude} ${v.unit||''}`.trim():'') || 'Pack'; }

function productCard(p){
  // variants: parent is the default, children are the other pack sizes
  const variants = [p, ...((p.children||[]))];
  const off = p?.pricing?.discount?.d_text;
  const card = el('div','card');
  const it0 = productToItem(p);
  card.dataset.pid = it0.pid;
  card._variants = variants;
  card.innerHTML = `
    ${off?`<span class="card-off">${esc(off)}</span>`:''}
    <div class="card-img">${it0.img?`<img loading="lazy" src="${esc(it0.img)}" alt="">`:'🛒'}</div>
    <div class="card-body">
      <div class="card-name">${esc(it0.desc)}</div>
      <div class="card-var"></div>
      <div class="card-price"></div>
      <div class="card-foot"></div>
    </div>`;
  selectVariant(card, 0);
  return card;
}

/* switch the card to variant index i: updates price, pack selector and the cart item */
function selectVariant(card, i){
  const variants = card._variants || [];
  const v = variants[i] || variants[0];
  const it = productToItem(v);
  card._item = it;
  card.dataset.pid = it.pid;
  const mrp = v?.pricing?.discount?.mrp;
  const varBox = $('.card-var', card);
  if(variants.length>1){
    varBox.hidden=false;
    varBox.innerHTML = `<select class="var-sel">${variants.map((vv,idx)=>{
      const sp=+(vv?.pricing?.discount?.prim_price?.sp??0);
      return `<option value="${idx}" ${idx===i?'selected':''}>${esc(variantPack(vv))} · ${inr(sp)}</option>`;
    }).join('')}</select>`;
    $('.var-sel',varBox).onchange = (e)=> selectVariant(card, +e.target.value);
  } else {
    varBox.hidden = !it.w;
    varBox.innerHTML = it.w?`<span class="card-w">${esc(it.w)}</span>`:'';
  }
  $('.card-price', card).innerHTML = `
    <span class="card-sp">${inr(it.sp)}</span>
    ${mrp && (+mrp>it.sp)?`<span class="card-mrp">${inr(mrp)}</span>`:''}`;
  paintCardFoot(card);
}

function cartQty(pid){ const c=S.cart.get(pid); return c?c.qty:0; }
function paintCardFoot(card){
  const foot = $('.card-foot', card);
  const pid = card.dataset.pid;
  const qty = cartQty(pid);
  if(qty<=0){
    foot.innerHTML = `<button class="btn-add">Add</button>`;
    $('.btn-add',foot).onclick = ()=>changeQty(card._item, +1, card);
  } else {
    foot.innerHTML = `<div class="stepper"><button data-d="-1">−</button><span class="qv">${qty}</span><button data-d="1">+</button></div>`;
    $$('.stepper button',foot).forEach(b=>b.onclick=()=>changeQty(card._item, +b.dataset.d, card));
  }
}

/* one unit per call to bb_cart_add_single / bb_cart_remove_single */
let _cartBusy=false;
async function changeQty(item, delta, card){
  if(_cartBusy){ return; } _cartBusy=true;
  try{
    if(delta>0){
      if(!item.fcid){ showToast('Open this item in Search to add more','error'); return; }   // preloaded item — needs product info
      const prev = (S.cart.get(item.pid)||{}).qty || 0;
      const r = await apiCall('bb_cart_add_single', {encData:S.encData, pid:item.pid, fcid:item.fcid, desc:item.desc, entry_context:S.modeCtx, entry_context_id:ECID()});
      if(!r) return;
      if(r.decoded.encData) S.encData=r.decoded.encData;
      if(!r.decoded.ok){ showToast(r.decoded.message||'Could not add','error'); return; }
      const e = S.cart.get(item.pid) || {...item, qty:0};
      const bbQty = parseInt(r.decoded.item_qty);              // BB's authoritative qty — never trust optimistic ±1
      e.qty = (Number.isFinite(bbQty) && bbQty>0) ? bbQty : (e.qty+1);
      e.fcid=item.fcid; e.img=item.img; e.w=item.w; e.sp=item.sp; e.desc=item.desc;
      S.cart.set(item.pid, e);
      if(Number.isFinite(bbQty) && bbQty>0 && bbQty===prev) showToast('Max quantity reached for this item','error');
    } else {
      if(cartQty(item.pid)<=0) return;
      const r = await apiCall('bb_cart_remove_single', {encData:S.encData, pid:item.pid, entry_context:S.modeCtx, entry_context_id:ECID()});
      if(!r) return;
      if(r.decoded.encData) S.encData=r.decoded.encData;
      if(!r.decoded.ok){ showToast(r.decoded.message||'Could not remove','error'); return; }
      const e = S.cart.get(item.pid);
      if(e){ const bbQty=parseInt(r.decoded.item_qty); e.qty = Number.isFinite(bbQty) ? bbQty : (e.qty-1); if(e.qty<=0) S.cart.delete(item.pid); else S.cart.set(item.pid,e); }
    }
    if(card) paintCardFoot(card);
    refreshCartUI();
  } finally { _cartBusy=false; }
}

/* ════════ cart count/total surfaces ════════ */
function cartCount(){ let n=0; S.cart.forEach(i=>n+=i.qty); return n; }
function cartTotal(){ let t=0; S.cart.forEach(i=>t+=i.sp*i.qty); return t; }
function refreshCartUI(){
  const n=cartCount(), t=cartTotal();
  const badge=$('#nav_cart_badge');
  if(n>0){ badge.hidden=false; badge.textContent=n; } else badge.hidden=true;
  const strip=$('#cartStrip');
  const onCart = !$('#tab-cart').hidden;
  if(n>0 && !onCart){ strip.style.display='flex'; $('#cartStrip_txt').textContent=`${n} item${n>1?'s':''} · ${inr(t)}`; }
  else strip.style.display='none';
  if(onCart) renderCartTab($('#tab-cart'));
}

/* Preload the account's EXISTING BigBasket cart (pid→qty) — never clears it.
   Existing items then show in the cart + reflect on search steppers; user can edit/remove/add more. */
/* One-tap: flip the top toggle to Scheduled. Reuses the existing #mode_seg handler (bb_set_mode +
   re-establish bb-b2c serviceable area + preloadCart), so cart/checkout resolve in the right context. */
async function switchToScheduled(){
  const seg=document.querySelector('#mode_seg .seg-opt[data-mode="scheduled"]');
  if(seg){ seg.click(); return; }
  S.modeCtx='bb-b2c'; S.orderType='Scheduled'; document.body.classList.remove('bbnow');
  if(S.encData){ await apiCall('bb_set_mode',{encData:S.encData, mode:'bb-b2c'}); await preloadCart(true); }
}

async function preloadCart(force){
  if(!S.encData) return;
  if(!force && S._cartLoadedFor===S.activePhone) return;
  S._cartLoadedFor=S.activePhone;
  try{
    const r=await apiCall('bb_cart_preload',{encData:S.encData, entry_context:S.modeCtx, entry_context_id:ECID()});
    if(!r || !r.decoded.ok) return;
    if(r.decoded.encData) S.encData=r.decoded.encData;
    S._cartResolveFailed = !!r.decoded.resolve_failed;   // true = transient throttle → offer Retry
    S._modeUnserviceable = !!r.decoded.mode_unserviceable; // true = address not serviceable in the selected mode → guide to Scheduled
    const ci=r.decoded.cart_info||{};
    // Enriched cards (image/name/price/fc_id) resolved server-side via short-list-products.
    const enriched={}; (r.decoded.items||[]).forEach(it=>{ enriched[String(it.pid)]=it; });
    Object.keys(ci).forEach(k=>{
      const pid=String(k), qty=parseInt(ci[k])||0;
      if(qty<=0){ S.cart.delete(pid); return; }
      const e=enriched[pid];
      const ex=S.cart.get(pid);
      // The server-resolved card for THIS mode is authoritative. Using it (not the existing entry) is
      // what lets a ₹0 placeholder — left over from a mode where the resolve failed, e.g. BB Now on a
      // Scheduled-only address — UPGRADE to the real price once we switch to a mode that resolves it.
      if(e && (e.fcid || e.img || e.unavailable || +e.sp>0)){                    // resolved card (available OR sold-out) from checkout
        S.cart.set(pid,{pid,fcid:String(e.fcid||''),desc:e.desc||('#'+pid),sp:+e.sp||0,mrp:+e.mrp||0,img:e.img||'',w:e.w||'',qty,unavailable:!!e.unavailable});
      } else if(ex){                                                             // no fresh data this mode → keep what we had, just sync qty
        ex.qty=qty; S.cart.set(pid,ex);
      } else {                                                                   // never seen → minimal placeholder
        S.cart.set(pid,{pid,fcid:'',desc:'Item already in cart',sp:0,mrp:0,img:'',w:'',qty,_pre:true});
      }
    });
    refreshCartUI();
    document.querySelectorAll('#productGrid .card').forEach(c=>paintCardFoot(c));  // reflect on visible product cards
  }catch(e){}
}

/* ═══════════════════════════════════════════════════════════════
   CART TAB  (native single-page checkout)
   ═══════════════════════════════════════════════════════════════ */
function renderCartTab(c){
  $('#cartStrip').style.display='none';
  if(!S.encData){ ensureActiveAccount(c,'view your cart'); return; }
  // (Re)resolve the cart if it hasn't loaded for this account — e.g. after an address switch,
  // where the cart may have migrated to a different area. Resolves once, then re-renders.
  if(S._cartLoadedFor!==S.activePhone){
    c.innerHTML='<div class="center muted mt16">Loading your cart…</div><div class="spin"></div>';
    preloadCart().then(()=>{ if(c.isConnected) renderCartTab(c); });
    return;
  }
  const items=[...S.cart.values()];
  if(!items.length){
    c.innerHTML=`<div class="tab-h">Cart (0)</div>
      <div class="empty" style="padding:24px 0"><div class="e-emoji">🛒</div>Your cart is empty.<br>
      <button class="btn-line mt12" onclick="route('search')">Browse products</button></div>
      <div id="masterCartSec" class="mc-sec"></div>`;
    renderMasterCarts(c);
    return;
  }
  const sub=cartTotal();
  // If the resolver was throttled, prices/images couldn't load — say so + offer a retry instead
  // of silently showing ₹0 cards.
  // Address not serviceable in the SELECTED mode (deterministic) → guide, NOT a Retry.
  // BB Now unserviceable → offer Scheduled; Scheduled also unserviceable → try again later.
  // If the cart won't price, say WHY + give the fix. On BB Now a non-loading cart is almost always
  // "this address is Scheduled-only" → offer Switch to Scheduled (+ Retry for a rare real throttle).
  // On Scheduled: a hard "not serviceable" ⇒ try later; anything transient ⇒ Retry.
  const bbnow = S.modeCtx==='bbnow';
  const notLoaded = S._modeUnserviceable || (S._cartResolveFailed && items.some(i=>i._pre));
  let svcBanner='';
  if(notLoaded && bbnow){
    svcBanner = `<div class="warn-box" style="display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap">
         <span>Couldn't load your cart on BB Now — this address may be Scheduled-only.</span>
         <span style="display:flex;gap:8px"><button class="btn-line" id="cartToSched" style="width:auto;padding:6px 14px">Switch to Scheduled</button><button class="btn-line" id="cartRetry" style="width:auto;padding:6px 14px">Retry</button></span></div>`;
  } else if(notLoaded && S._modeUnserviceable){
    svcBanner = `<div class="warn-box"><span>Not deliverable to this address right now — please try again later.</span></div>`;
  } else if(notLoaded){
    svcBanner = `<div class="warn-box" style="display:flex;align-items:center;gap:10px;justify-content:space-between">
         <span>Couldn't load item prices right now.</span>
         <button class="btn-line" id="cartRetry" style="width:auto;padding:6px 14px">Retry</button></div>`;
  }
  const failedBanner = '';
  c.innerHTML = `
    <div class="tab-h">Cart (${cartCount()})</div>
    ${svcBanner}${failedBanner}
    <div id="cartLines"></div>
    <div class="bill" id="cartBill"></div>
    <button class="btn-primary mt16" id="cartCheckout">Checkout · ${inr(sub)}</button>
    <button class="btn-line mt12" id="saveMasterCart">💾 Save this cart as a master cart</button>
    <div id="masterCartSec" class="mc-sec"></div>`;
  const wrap=$('#cartLines',c);
  items.forEach(it=>wrap.appendChild(cartLine(it)));
  paintBill($('#cartBill',c), {sub_total:sub, total:sub});
  // Selected mode not serviceable / cart didn't price → block checkout at the button (not just on click).
  const ckBtn=$('#cartCheckout',c);
  if(notLoaded){
    ckBtn.disabled=true; ckBtn.style.opacity='0.5'; ckBtn.style.cursor='not-allowed';
    ckBtn.textContent = bbnow ? 'Not available on BB Now' : 'Not deliverable to this address';
  } else {
    ckBtn.disabled=false; ckBtn.style.opacity=''; ckBtn.style.cursor='';
    ckBtn.onclick = startCheckout;
  }
  $('#saveMasterCart',c).onclick = saveCurrentCartAsMaster;
  renderMasterCarts(c);
  const rt=$('#cartRetry',c); if(rt) rt.onclick=async()=>{ S._cartLoadedFor=null; c.innerHTML='<div class="center muted mt16">Loading…</div><div class="spin"></div>'; await preloadCart(true); if(c.isConnected) renderCartTab(c); };
  const ts=$('#cartToSched',c); if(ts) ts.onclick=()=>switchToScheduled();
}

/* ── Master carts (saved cart templates, shared across accounts under the code) ── */
function b64u(str){ return btoa(unescape(encodeURIComponent(str))); }   // unicode-safe base64

const MASTER_CART_CAP = 2;          // max master carts per access code (also enforced server-side)
let _masterCartCount = 0;
/* Reflect the cap on the "Save this cart as a master cart" button. */
function updateMasterCartSaveBtn(){
  const btn=document.getElementById('saveMasterCart'); if(!btn) return;
  const full=_masterCartCount>=MASTER_CART_CAP;
  btn.disabled=full; btn.style.opacity=full?'0.55':''; btn.style.cursor=full?'not-allowed':'';
  btn.textContent = full ? `🔒 Master cart limit reached (${MASTER_CART_CAP} max)` : '💾 Save this cart as a master cart';
}

async function renderMasterCarts(container){
  const sec=$('#masterCartSec', container) || document.getElementById('masterCartSec'); if(!sec) return;
  sec.innerHTML='<div class="mc-hd">Master carts</div><div class="mc-empty">Loading…</div>';
  const r=await apiCall('list_master_carts', {});
  const carts=(r&&r.decoded&&r.decoded.carts)||[];
  _masterCartCount = carts.length; updateMasterCartSaveBtn();
  if(!carts.length){ sec.innerHTML=`<div class="mc-hd">Master carts · 0/${MASTER_CART_CAP}</div><div class="mc-empty">No master carts yet. Build a cart and tap “Save this cart as a master cart”.</div>`; return; }
  sec.innerHTML=`<div class="mc-hd">Master carts · ${carts.length}/${MASTER_CART_CAP} · add to this account in one tap</div>`+
    carts.map(mc=>`<div class="mc-card">
      <div class="mc-card-main">
        <div class="mc-card-t">🧺 ${esc(mc.label)}</div>
        <div class="mc-card-s">${mc.count} item${mc.count!==1?'s':''}${mc.pincode?(' · '+esc(mc.pincode)):''}</div>
      </div>
      <div class="mc-card-acts">
        <button class="mc-btn mc-add" data-id="${mc.id}">➕ Add</button>
        <button class="mc-btn mcc-edit" data-id="${mc.id}" title="Rename">✎</button>
        <button class="mc-btn mc-del mcc-del" data-id="${mc.id}" title="Delete">🗑</button>
      </div></div>`).join('');
  $$('.mc-add',sec).forEach(b=>b.onclick=()=>addMasterCartToCart(+b.dataset.id));
  $$('.mcc-edit',sec).forEach(b=>b.onclick=()=>editMasterCart(carts.find(x=>x.id===+b.dataset.id)));
  $$('.mcc-del',sec).forEach(b=>b.onclick=()=>deleteMasterCart(+b.dataset.id));
}

function saveCurrentCartAsMaster(){
  if(_masterCartCount>=MASTER_CART_CAP){ showToast(`Master cart limit reached (${MASTER_CART_CAP} max). Delete one first.`,'error'); return; }
  const items=[...S.cart.values()].filter(i=>!i.unavailable).map(i=>({pid:i.pid,fcid:i.fcid,desc:i.desc,sp:i.sp,mrp:i.mrp,img:i.img,w:i.w,qty:i.qty}));
  if(!items.length){ showToast('Cart is empty','error'); return; }
  openSheet('Save master cart', b=>{
    b.innerHTML=`<div class="field"><label>Name</label><input id="mcName" placeholder="e.g. Weekly staples" value="Cart ${new Date().toLocaleDateString('en-IN')}"></div>
      <div class="muted" style="font-size:12px;margin-bottom:12px">${items.length} item(s) will be saved. Add them to any account's cart later in one tap.</div>
      <button class="btn-primary" id="mcSaveGo">Save master cart</button>`;
    $('#mcSaveGo',b).onclick=async()=>{
      const addr=S._activeAddr||{};
      const r=await apiCall('save_master_cart', {items:b64u(JSON.stringify(items)), label:$('#mcName',b).value.trim(), pincode:String(addr.pin||addr.pincode||''), area:String(addr.area||'')});
      if(!r || !r.decoded.ok){ showToast((r&&r.decoded.message)||'Save failed','error'); return; }
      showToast('Saved as master cart','success'); closeSheet(); renderMasterCarts($('#tab-cart'));
    };
  });
}

async function addMasterCartToCart(id){
  showToast('Adding master cart to this account…');
  const r=await apiCall('add_master_cart_to_cart', {encData:S.encData, cart_id:id});
  if(!r || !r.decoded.ok){ showToast((r&&r.decoded.message)||'Add failed','error'); return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  showToast(r.decoded.message||'Added','success');
  S._cartLoadedFor=null; await preloadCart(true);
  renderCartTab($('#tab-cart'));
}

async function deleteMasterCart(id){
  if(!confirm('Delete this master cart?')) return;
  const r=await apiCall('delete_master_cart', {cart_id:id});
  if(!r || !r.decoded.ok){ showToast('Delete failed','error'); return; }
  showToast('Master cart deleted','success'); renderMasterCarts($('#tab-cart'));
}

function editMasterCart(mc){
  if(!mc) return;
  openSheet('Rename master cart', b=>{
    b.innerHTML=`<div class="field"><label>Name</label><input id="mcRn" value="${esc(mc.label||'')}"></div>
      <button class="btn-primary" id="mcRnGo">Save</button>`;
    $('#mcRnGo',b).onclick=async()=>{
      const r=await apiCall('update_master_cart', {cart_id:mc.id, label:$('#mcRn',b).value.trim()||mc.label});
      if(!r || !r.decoded.ok){ showToast('Rename failed','error'); return; }
      showToast('Renamed','success'); closeSheet(); renderMasterCarts($('#tab-cart'));
    };
  });
}

function cartLine(it){
  const ln=el('div','line'+(it.unavailable?' line-oos':''));
  const meta = it.unavailable
    ? '<div class="line-oos-tag">Sold out at this address</div>'
    : ((+it.sp>0)?`<div class="line-sp">${inr(it.sp)}</div>`:(it._pre?'<div class="line-w">in cart · search to edit price</div>':''));
  ln.innerHTML=`
    ${it.img?`<img class="line-img" src="${esc(it.img)}">`:'<div class="line-img"></div>'}
    <div class="line-mid">
      <div class="line-name">${esc(it.desc)}</div>
      ${it.w?`<div class="line-w">${esc(it.w)}</div>`:''}
      ${meta}
    </div>
    <div class="line-right">
      ${it.unavailable
        ? `<button class="line-rm" title="Remove">Remove</button>`
        : `<div class="stepper-sm"><button data-d="-1">−</button><span class="qv">${it.qty}</span><button data-d="1">+</button></div>`}
    </div>`;
  $$('.stepper-sm button',ln).forEach(b=>b.onclick=async()=>{
    await changeQty(it, +b.dataset.d, null);
  });
  const rm=$('.line-rm',ln); if(rm) rm.onclick=async()=>{ await changeQty(it, -(it.qty||1), null); };
  return ln;
}

function paintBill(node, b){
  const handling = b.delivery_charge ?? 0;
  const voucher = b.voucher_savings ?? 0;
  const total = b.final_total ?? b.total ?? ((b.sub_total||0)+handling-voucher);
  node.innerHTML = `
    <div class="bill-row"><span>Item total</span><span class="v">${inr(b.sub_total)}</span></div>
    <div class="bill-row"><span>Handling / delivery</span><span class="v">${handling?inr(handling):'FREE'}</span></div>
    ${voucher?`<div class="bill-row save"><span>Voucher</span><span class="v">− ${inr(voucher)}</span></div>`:''}
    <div class="bill-row total"><span>To pay</span><span class="v">${inr(total)}</span></div>`;
}

/* ════════ CHECKOUT next_op chain ════════ */
async function startCheckout(){
  if(!S.encData){ showToast('No active account','error'); return; }
  if(!S.cart.size){ showToast('Your cart is empty','error'); return; }
  S.checkout=null;   // fresh checkout — never carry a previous order's po_summary / juspay signature forward
  openSheet('Checkout', b=>{ b.innerHTML='<div class="center muted mt16">Preparing your order…</div><div class="spin"></div>'; });
  const addrs = await ensureAddresses();
  if(!addrs.length){
    openSheet('Delivery address', b=>{
      b.innerHTML=`<div class="warn-box">Add a delivery address to place this order.</div><button class="btn-primary" id="goAddr">+ Add address</button>`;
      $('#goAddr',b).onclick=()=>{ closeSheet(); openAddAddress(); };
    });
    return;
  }
  // keep the user's current pick if still valid, else fall back to BB's active/default
  let a = S.selectedAddressId ? addrs.find(x=>String(x.id)===String(S.selectedAddressId)) : null;
  if(!a) a = addrs.find(x=>x.is_current_delivery) || addrs.find(x=>x.is_default) || addrs[0];
  setActiveAddress(a);
  // Serviceability gate: never run a checkout when the cart couldn't load in this mode. On BB Now that's
  // almost always "address is Scheduled-only" → offer the switch; on Scheduled a hard fail ⇒ try later.
  const bbnow = S.modeCtx==='bbnow';
  const cartBroken = S._modeUnserviceable || (bbnow && S._cartResolveFailed);
  if(cartBroken){
    openSheet(bbnow?'BB Now unavailable':'Not deliverable', b=>{
      b.innerHTML = bbnow
        ? `<div class="warn-box">Couldn't load your cart on BB Now — this address may be Scheduled-only.</div><button class="btn-primary" id="toSched">Switch to Scheduled</button>`
        : `<div class="warn-box">This address isn't deliverable right now. Please try again later.</div><button class="btn-line" id="svcClose">Close</button>`;
      const t=$('#toSched',b); if(t) t.onclick=async()=>{ closeSheet(); await switchToScheduled(); route('cart'); };
      const cl=$('#svcClose',b); if(cl) cl.onclick=()=>closeSheet();
    });
    return;
  }
  await runCheckout();
}

/* Load + cache the account's saved addresses (shared with the Address tab). */
async function ensureAddresses(){
  if(S.addrDecoded && Array.isArray(S.addrDecoded.addresses)) return S.addrDecoded.addresses;
  const r=await apiCall('bb_address_list', {encData:S.encData, mobileno:S.activePhone});
  if(!r || !r.decoded.ok) return [];
  if(r.decoded.encData) S.encData=r.decoded.encData;
  S.addrDecoded=r.decoded;
  return r.decoded.addresses||[];
}
function setActiveAddress(a){
  S._activeAddr=a;
  S.selectedAddressId=a.id;
  S.latLng=btoa(`${a.lat}|${a.lng}`);
  S.ourAddress=`${a.first_name||''} ${a.last_name||''} ${a.address1||''}, ${a.area||''} ${a.city_name||''} ${a.pin||''}`.trim();
}

/* Run /bb_checkout for the active address, then open the review sheet. */
async function runCheckout(){
  const items=[...S.cart.values()].map(i=>({pid:i.pid,fcid:i.fcid,desc:i.desc,qty:i.qty}));
  openSheet('Checkout', b=>{ b.innerHTML='<div class="center muted mt16">Preparing your order…</div><div class="spin"></div>'; });
  const base = {
    encData:S.encData, address_id:S.selectedAddressId, lat_long:S.latLng, our_address:S.ourAddress,
    entry_context_id:ECID(), entry_context:S.modeCtx,
    options:{ platform:'bigbasket_app', order_type:S.orderType }, items,
  };
  const r = await apiCall('bb_checkout', base);
  if(!r){ closeSheet(); return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  if(!r.decoded.ok){ handleCheckout(r.decoded); return; }
  initReview(r.decoded);
}

function handleCheckout(d){
  if(d && d.encData) S.encData=d.encData;
  switch(d.next_op){
    case 'bb_add_voucher': initReview(d); break;
    case 'bb_get_slots':   autoGetSlots(d); break;
    case 'bb_set_slots':   /* slot picker confirm path handled inline */ break;
    case 'bb_place_order': renderPaymentChoice(d); break;
    case 'bb_upi_pay':     handleUpiPayment(d); break;
    case 'end':            renderOrderResult(d); break;
    default:
      if(d.all_fail || (d.avail_fail && d.avail_fail.length && !d.partial_fail_ok)){ renderCheckoutFail(d); break; }
      if(d.message) showToast(d.message, d.ok?'success':'error');
  }
}

function renderCheckoutFail(d){
  openSheet('Some items unavailable', b=>{
    b.innerHTML=`<div class="warn-box">Some items in your cart are out of stock right now.</div>
      <div class="row-btns">
        <button class="btn-line" id="ck_back">Back to cart</button>
        ${d.partial_fail_ok?'<button class="btn-primary" id="ck_cont">Continue anyway</button>':''}
      </div>`;
    $('#ck_back',b).onclick=()=>{ closeSheet(); route('cart'); };
    const cont=$('#ck_cont',b); if(cont) cont.onclick=()=>{ if(d.po_summary) initReview(d); else { closeSheet(); route('cart'); } };
  });
}

/* ── Review & pay sheet — bill, voucher state, wallet/neucoins toggles, address picker ── */
function initReview(d){
  S.checkout = {...(S.checkout||{}), ...d};
  const ps = S.checkout.po_summary || {};
  const w = ps.wallet_details || {}, n = ps.neucoins_details || {};
  // mirror BB's own applied state (it auto-applies wallet + neucoins by default)
  S.useWallet   = (w.state==='on');
  S.useNeucoins = (n.state==='on');
  const vd = ps.voucher_details || {};
  S.appliedVoucher = (vd.state==='on' && vd.evoucher_code)
    ? { code:vd.evoucher_code, discount:Math.abs(+vd.value||0), display:vd.display_value||'' } : null;
  S._reviewNext = null;   // set once a voucher op (or skip) tells us the real next step
  renderReview();
}

function computeBill(ps){
  // All amounts come straight from the server summary. order_details.final_total
  // (== juspay_details.amount) is ALREADY net of wallet + neucoins — never subtract them again.
  const od = ps.order_details || {};
  const sub = +od.sub_total || 0;
  const handling = (ps.total_charges!=null ? +ps.total_charges : (+od.delivery_charge||0));
  const voucher = Math.abs(+((od.savings||{}).voucher) || 0);
  const w = ps.wallet_details || {}, n = ps.neucoins_details || {};
  const wEnable = (w.enable!==false) && (w.visible!==false) && ((+w.balance||0)>0);
  const nEnable = (n.enable!==false) && (n.visible!==false) && ((+n.balance||0)>0);
  const wOn = (w.state==='on'), nOn = (n.state==='on');
  const wApplied = wOn ? Math.abs(+w.value||0) : 0;
  const nApplied = nOn ? Math.abs(+n.value||0) : 0;
  // final_total is authoritative for "To pay" — it tracks voucher + wallet + neucoins. juspay.amount
  // is the gateway figure and goes STALE on voucher apply (BB doesn't recompute it), so it's only a fallback.
  const toPay = (od.final_total!=null) ? +od.final_total
              : (ps.juspay_details && ps.juspay_details.amount!=null) ? +ps.juspay_details.amount
              : Math.max(0,(ps.total_with_charges!=null?+ps.total_with_charges:sub+handling-voucher)-wApplied-nApplied);
  // Instant-discount voucher vs CASHBACK voucher: BB reflects an instant discount in final_total, but a
  // cashback voucher leaves final_total at the full amount (credited to bbWallet AFTER delivery). If the
  // payable did NOT drop by (roughly) the voucher amount, treat it as cashback so the bill can say so.
  const voucherIsCashback = voucher>0 && ((sub+handling-wApplied-nApplied) - toPay) < (voucher*0.5);
  return { sub, handling, voucher, voucherIsCashback, wEnable, nEnable, wBal:+w.balance||0, nBal:+n.balance||0, wApplied, nApplied, toPay, wOn, nOn };
}

function creditRow(k, ico, label, bal, on){
  return `<label class="co-credit">
    <span class="cc-ico">${ico}</span>
    <span class="cc-mid"><span class="cc-name">${label}</span><span class="cc-bal">Balance ${inr(bal)}</span></span>
    <input type="checkbox" id="tg_${k}" class="cc-box" ${on?'checked':''}></label>`;
}

/* Items in this order (from po_summary, post-migration) — name + qty + line price; image from
   the cart cache when we have it. Lets the user see exactly what they're paying for / what
   changed after an area switch. */
function reviewItemsHtml(ps){
  const items = ps.items || [];
  if(!items.length) return '';
  const rows = items.map(it=>{
    const pid = String(it.sku||it.id||'');
    const cached = S.cart.get(pid);
    const name = (`${it.brand||''} ${it.description||''}`.trim()) || (cached&&cached.desc) || ('#'+pid);
    const img = (cached&&cached.img)||'';
    const qty = +it.qty||1, sp = +it.sp||0;
    return `<div class="co-item">
      ${img?`<img class="co-item-img" src="${esc(img)}">`:'<div class="co-item-img"></div>'}
      <div class="co-item-mid"><div class="co-item-n">${esc(name)}</div><div class="co-item-q">Qty ${qty}</div></div>
      <div class="co-item-p">${sp?inr(sp*qty):''}</div></div>`;
  }).join('');
  return `<div class="co-sec-h">Items (${items.length})</div><div class="co-items">${rows}</div>`;
}

function renderReview(){
  const d = S.checkout; const ps = d.po_summary || {};
  // keep the toggles in lock-step with the server's current selection
  S.useWallet   = (ps.wallet_details||{}).state==='on';
  S.useNeucoins = (ps.neucoins_details||{}).state==='on';
  const a = S._activeAddr || {};
  const addrName = (`${a.first_name||''} ${a.last_name||''}`.trim()) || a.nick || 'Delivery address';
  const addrLine = [a.address1, a.area, a.city_name, a.pin].filter(Boolean).join(', ');
  const bl = computeBill(ps);
  openSheet('Review & pay', b=>{
    b.innerHTML = `
      <div class="co-addr">
        <span class="co-addr-ico">📍</span>
        <div class="co-addr-mid"><div class="co-addr-name">${esc(addrName)}</div><div class="co-addr-sub">${esc(addrLine||'Choose a delivery address')}</div></div>
        <button class="co-addr-chg" id="coChg">Change</button>
      </div>
      <div id="coAddrList" data-open="0"></div>
      ${reviewItemsHtml(ps)}
      <div class="bill mt8" id="coBill"></div>
      <div class="co-sec-h">Voucher &amp; offers</div>
      <div id="coVoucher"></div>
      <button class="co-offers-btn" id="coOffers"><span>🏷️ View offers &amp; enter code</span><span class="co-chev">›</span></button>
      ${(bl.wEnable||bl.nEnable)?`<div class="co-sec-h">Pay using</div>`:''}
      ${bl.wEnable?creditRow('w','👛','bbWallet',bl.wBal,S.useWallet):''}
      ${bl.nEnable?creditRow('n','🪙','NeuCoins',bl.nBal,S.useNeucoins):''}
      <button class="btn-primary co-pay" id="coPay">${S.orderType==='Scheduled'?'Choose delivery slot':'Continue to pay'} · ${inr(bl.toPay)}</button>`;
    paintReviewBill($('#coBill',b), bl);
    paintVoucherChip($('#coVoucher',b));
    $('#coChg',b).onclick = ()=>toggleAddrList(b);
    $('#coOffers',b).onclick = ()=>openOffersSheet();
    $('#coPay',b).onclick = ()=>continueToPay();
    const wt=$('#tg_w',b); if(wt) wt.onchange=()=>applyPayOption('bbwallet', wt.checked, S.useNeucoins);
    const nt=$('#tg_n',b); if(nt) nt.onchange=()=>applyPayOption('neucoins', S.useWallet, nt.checked);
  });
}

/* Offers live in their own sub-sheet so the long list never buries the toggles / pay button.
   Apply here → applyVoucher() returns to the review sheet; ‹ back also returns. */
function openOffersSheet(){
  openSheet('Offers & vouchers', b=>{
    b.innerHTML = `
      <div class="vch-input">
        <input id="vchCode" placeholder="ENTER CODE" autocomplete="off">
        <button class="btn-line" id="vchApply">Apply</button>
      </div>
      <div id="vchList" class="mt8"><div class="muted center" style="padding:14px">Loading offers…</div></div>`;
    $('#vchApply',b).onclick = ()=>applyVoucher(($('#vchCode',b).value||'').trim().toUpperCase());
    loadVoucherList(S.checkout);
  }, ()=>renderReview());   // ‹ back → review sheet
}

/* Re-price the PO server-side for the new wallet/neucoins selection (the app's own behaviour),
   then repaint the bill from the authoritative response. */
async function applyPayOption(toggled, useWallet, useNeucoins){
  const r = await apiCall('bb_pay_options', {...S.checkout, toggled, use_wallet:useWallet, use_neucoins:useNeucoins});
  if(!r || !r.decoded.ok){ showToast('Could not update payment options','error'); syncCreditToggles(); return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  S.checkout={...S.checkout, po_summary:r.decoded.po_summary};
  const ps=r.decoded.po_summary||{};
  S.useWallet   = (ps.wallet_details||{}).state==='on';
  S.useNeucoins = (ps.neucoins_details||{}).state==='on';
  updateReviewTotals();
  syncCreditToggles();
}

function syncCreditToggles(){
  const wt=$('#tg_w'); if(wt) wt.checked=S.useWallet;
  const nt=$('#tg_n'); if(nt) nt.checked=S.useNeucoins;
}

/* repaint bill + pay button from the current (server) po_summary */
function updateReviewTotals(){
  const bl=computeBill(S.checkout.po_summary||{});
  paintReviewBill($('#coBill'), bl);
  const pay=$('#coPay'); if(pay) pay.textContent=`${S.orderType==='Scheduled'?'Choose delivery slot':'Continue to pay'} · ${inr(bl.toPay)}`;
}

function paintReviewBill(node, bl){
  if(!node) return;
  node.innerHTML = `
    <div class="bill-row"><span>Item total</span><span class="v">${inr(bl.sub)}</span></div>
    <div class="bill-row"><span>Handling / delivery</span><span class="v">${bl.handling?inr(bl.handling):'FREE'}</span></div>
    ${bl.voucher?(bl.voucherIsCashback?`<div class="bill-row"><span>🎁 bbWallet cashback</span><span class="muted" style="font-weight:600">${inr(bl.voucher)} after delivery</span></div>`:`<div class="bill-row save"><span>Voucher</span><span class="v">− ${inr(bl.voucher)}</span></div>`):''}
    ${bl.wApplied?`<div class="bill-row save"><span>👛 bbWallet</span><span class="v">− ${inr(bl.wApplied)}</span></div>`:''}
    ${bl.nApplied?`<div class="bill-row save"><span>🪙 NeuCoins</span><span class="v">− ${inr(bl.nApplied)}</span></div>`:''}
    <div class="bill-row total"><span>To pay</span><span class="v">${inr(bl.toPay)}</span></div>
    ${bl.voucherIsCashback?`<div class="muted" style="font-size:11.5px;padding:6px 2px 0;line-height:1.35">💡 You pay the full amount now. <b>${inr(bl.voucher)}</b> is credited to your bbWallet after delivery (not deducted from this bill).</div>`:''}`;
}

function paintVoucherChip(node){
  if(!node) return;
  const av = S.appliedVoucher;
  if(av){
    const _bl=computeBill((S.checkout&&S.checkout.po_summary)||{});
    node.innerHTML = `<div class="vch-applied"><span class="va-tick">✓</span>
      <span class="va-mid"><b>${esc(av.code)}</b> applied${av.discount?(_bl.voucherIsCashback?` · 🎁 ${inr(av.discount)} cashback`:` · −${inr(av.discount)}`):''}</span>
      <button class="va-rm" id="vchRemove">Remove</button></div>`;
    const rm=$('#vchRemove',node); if(rm) rm.onclick=()=>removeVoucher();
  } else node.innerHTML = '';
}

/* inline address picker (no tab redirect) */
async function toggleAddrList(b){
  const box=$('#coAddrList',b); if(!box) return;
  if(box.dataset.open==='1'){ box.innerHTML=''; box.dataset.open='0'; return; }
  box.dataset.open='1'; box.innerHTML='<div class="muted center" style="padding:8px">Loading addresses…</div>';
  const addrs=await ensureAddresses();
  if(!addrs.length){
    box.innerHTML=`<button class="btn-ghost" id="coAddNew">+ Add address</button>`;
    $('#coAddNew',box).onclick=()=>{ closeSheet(); openAddAddress(); }; return;
  }
  box.innerHTML = addrs.map(a=>{
    const nm=(`${a.first_name||''} ${a.last_name||''}`.trim())||a.nick||'Home';
    const ln=[a.address1,a.area,a.city_name,a.pin].filter(Boolean).join(', ');
    const sel=String(a.id)===String(S.selectedAddressId);
    return `<div class="co-addr-opt ${sel?'sel':''}" data-id="${esc(a.id)}">
      <div class="co-addr-mid"><div class="co-addr-name">${esc(nm)}</div><div class="co-addr-sub">${esc(ln)}</div></div>
      ${sel?'<span class="co-addr-cur">✓</span>':''}</div>`;
  }).join('') + `<button class="btn-ghost" id="coAddNew2">+ Add new address</button>`;
  $$('.co-addr-opt',box).forEach(opt=>opt.onclick=async()=>{
    const a=addrs.find(x=>String(x.id)===opt.dataset.id); if(!a) return;
    if(String(a.id)===String(S.selectedAddressId)){ box.innerHTML=''; box.dataset.open='0'; return; }
    const old=S._activeAddr;
    setActiveAddress(a);
    // crossing areas → migrate the cart + set delivery address before re-checkout (app behaviour)
    if(old && String(old.pin||'')!==String(a.pin||'')){
      const r=await apiCall('bb_switch_address', {
        encData:S.encData, address_id:a.id, lat_long:S.latLng,
        old:{lat:old.lat,lng:old.lng,area:old.area,id:old.id,pin:old.pin},
        new:{lat:a.lat,lng:a.lng,area:a.area,id:a.id,pin:a.pin},
        entry_context_id:ECID(), entry_context:S.modeCtx
      });
      if(r){ if(r.decoded.encData) S.encData=r.decoded.encData; if(r.decoded.migrate_msg) showToast(r.decoded.migrate_msg,'error'); }
    }
    // migration may change which items are available → invalidate the cart so the Cart tab
    // re-resolves it for the new area (no extra PO here; runCheckout already re-prices the review).
    S.cart.clear(); S._cartLoadedFor=null;
    runCheckout();   // re-checkout for the new address, re-render review
  });
  const an=$('#coAddNew2',box); if(an) an.onclick=()=>{ closeSheet(); openAddAddress(); };
}

async function loadVoucherList(d){
  const r = await apiCall('bb_voucher_list', {
    encData:S.encData, poId:d.poId, entry_context_id:d.entry_context_id||ECID(), entry_context:d.entry_context||S.modeCtx
  });
  const box=$('#vchList'); if(!box) return;
  if(!r || !r.decoded.ok){ box.innerHTML='<div class="muted center" style="padding:14px">No offers available right now.</div>'; return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  const vchs = r.decoded.vouchers||[]; const base = r.decoded.base_url||''; const sug=r.decoded.suggested;
  if(!vchs.length){ box.innerHTML='<div class="muted center" style="padding:14px">No offers available — enter a code above if you have one.</div>'; return; }
  const applied = S.appliedVoucher && S.appliedVoucher.code;
  box.innerHTML = vchs.map(v=>{
    const best = sug && sug.code===v.code;
    const isApplied = applied && applied===v.code;
    return `<div class="vch-card ${best?'best':''} ${isApplied?'applied':''}" data-code="${esc(v.code)}">
      ${v.logo?`<img class="vch-logo" src="${esc(base+v.logo)}">`:'<div class="vch-logo"></div>'}
      <div class="vch-meta">
        <div class="vch-code">${esc(v.code)}${best?'<span class="vch-tag">Best</span>':''}</div>
        <div class="vch-sub">${esc(v.header||v.desc||'')}</div>
      </div>
      ${isApplied?'<span class="vch-applied-tag">Applied ✓</span>':'<button class="vch-apply">Apply</button>'}</div>`;
  }).join('');
  $$('.vch-card',box).forEach(card=>{ const btn=card.querySelector('.vch-apply'); if(btn) btn.onclick=()=>applyVoucher(card.dataset.code); });
}

async function applyVoucher(code){
  if(!code){ showToast('Enter a voucher code','error'); return; }
  const r = await apiCall('bb_add_voucher', {...S.checkout, voucher:code, voucher_op:'apply', use_wallet:S.useWallet, use_neucoins:S.useNeucoins});
  if(!r) return;
  if(r.decoded.encData) S.encData=r.decoded.encData;
  const d=r.decoded;
  if(!d.ok){
    // stay in the offers sheet so the user can try another code; just flag it
    showToast((d.voucher_result&&d.voucher_result.message) || d.message || 'Voucher not applicable','error');
    if(d.po_summary) S.checkout={...S.checkout, po_summary:d.po_summary};
    return;
  }
  S.checkout={...S.checkout, ...d};
  const vr=d.voucher_result||{};
  S.appliedVoucher={ code:vr.code||code, discount:Math.abs(+vr.discount||0), display:vr.display||'' };
  S._reviewNext=d.next_op||S._reviewNext;
  renderReview();   // success → back to the review sheet with the applied chip + updated bill
}

async function removeVoucher(){
  const av=S.appliedVoucher; if(!av) return;
  const r = await apiCall('bb_add_voucher', {...S.checkout, voucher:av.code, voucher_op:'remove', use_wallet:S.useWallet, use_neucoins:S.useNeucoins});
  if(!r) return;
  if(r.decoded.encData) S.encData=r.decoded.encData;
  const d=r.decoded;
  if(!d.ok){ showToast(d.message||'Could not remove voucher','error'); return; }
  S.checkout={...S.checkout, ...d};
  S.appliedVoucher=null;
  S._reviewNext=d.next_op||S._reviewNext;
  renderReview();
}

async function continueToPay(){
  S.checkout={...S.checkout, use_wallet:S.useWallet, use_neucoins:S.useNeucoins};
  // lock in the voucher choice (or skip) once, to obtain the real next step
  if(!S._reviewNext){
    const r = await apiCall('bb_add_voucher', {...S.checkout, voucher: (S.appliedVoucher&&S.appliedVoucher.code)||null, voucher_op:'apply'});
    if(!r) return;
    if(r.decoded.encData) S.encData=r.decoded.encData;
    S.checkout={...S.checkout, ...r.decoded, use_wallet:S.useWallet, use_neucoins:S.useNeucoins};
    S._reviewNext = r.decoded.next_op || 'bb_place_order';
  }
  const d={...S.checkout, next_op:S._reviewNext, use_wallet:S.useWallet, use_neucoins:S.useNeucoins};
  S.checkout=d;
  handleCheckout(d);
}

/* slots (Scheduled only) */
async function autoGetSlots(d){
  S.checkout={...S.checkout, ...d};
  const r = await apiCall('bb_get_slots', S.checkout);
  if(!r || !r.decoded.ok){ showToast('Could not load slots','error'); return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  renderSlotPicker(r.decoded);
}

function parseSlots(slots){
  const out=[]; // flat slot cards with attached ids
  (slots?.shipment_groups||[]).forEach(group=>{
    (group.shipments||[]).forEach(shp=>{
      const sid = shp.shipment_id || shp.id;
      (shp.slots||[]).forEach(dayGrp=>{
        (dayGrp.slots||[]).forEach(s=>{
          out.push({
            ...s,
            shipment_group_id: group.id,
            shipment_id: sid,
            _unavailable: !s.available || s.blocked || s.slot_blocked,
          });
        });
      });
    });
  });
  return out;
}

function renderSlotPicker(d){
  S.checkout={...S.checkout, ...d};
  const flat=parseSlots(d.slots);
  // group by display date
  const byDate={};
  flat.forEach(s=>{ const k=s.display_slot_date||s.slot_date||s.day; (byDate[k]=byDate[k]||[]).push(s); });
  const dates=Object.keys(byDate);
  let activeDate=dates[0], sel=null;
  openSheet('Pick a delivery slot', b=>{
    b.innerHTML=`<div class="slot-tabs" id="slotTabs"></div><div class="slot-list" id="slotList"></div>
      <button class="btn-primary mt16" id="slotConfirm" disabled>Confirm slot</button>`;
    const tabs=$('#slotTabs',b);
    dates.forEach(dt=>{ const t=el('button','slot-tab'+(dt===activeDate?' active':''),esc(dt)); t.onclick=()=>{activeDate=dt;paintTabs();paintCells();}; tabs.appendChild(t); });
    function paintTabs(){ $$('.slot-tab',tabs).forEach((t,i)=>t.classList.toggle('active',dates[i]===activeDate)); }
    function paintCells(){
      const list=$('#slotList',b); list.innerHTML='';
      (byDate[activeDate]||[]).forEach(s=>{
        const cell=el('div','slot-cell'+(s._unavailable?' dis':'')+(sel===s?' sel':''));
        cell.innerHTML=`<div class="slot-time">${esc(s.slot||'')}</div><div class="slot-tod">${esc(s.time_of_the_day||s.short_eta||'')}</div>`;
        if(!s._unavailable) cell.onclick=()=>{ sel=s; paintCells(); $('#slotConfirm',b).disabled=false; };
        list.appendChild(cell);
      });
    }
    paintCells();
    $('#slotConfirm',b).onclick=async()=>{
      if(!sel) return;
      const payload={...S.checkout};
      delete payload.slots;
      Object.assign(payload,{
        slot_date: sel.slot_date, slot_definition_id: sel.slot_definition_id,
        template_slot_id: sel.template_slot_id, shipment_group_id: sel.shipment_group_id, shipment_id: sel.shipment_id
      });
      const r=await apiCall('bb_set_slots', payload);
      if(!r||!r.decoded.ok){ showToast('Slot not set','error'); return; }
      if(r.decoded.encData) S.encData=r.decoded.encData;
      S.checkout={...payload, ...r.decoded};
      handleCheckout(r.decoded); // -> bb_place_order
    };
  });
}

/* payment choice */
async function renderPaymentChoice(d){
  S.checkout={...S.checkout, ...d};
  // BB tells us per-order whether COD is allowed via order_details.cod_enabled (often false on
  // voucher / prepaid-only orders). Only offer COD when allowed — else UPI-only, so the user
  // isn't given a method that will be rejected.
  const od = (S.checkout.po_summary||{}).order_details || {};
  // show_cod_option is the authoritative per-order gate — cod_enabled stays true on voucher/prepaid
  // orders even when COD must be hidden. Use show_cod_option when present; fall back to cod_enabled.
  const codOk = (od.show_cod_option !== undefined ? od.show_cod_option : od.cod_enabled) !== false;
  // HARD balance gate: the access fee (per_order_limit) is charged only on VOUCHER orders. If a voucher
  // is applied and the access balance can't cover the fee, block placing — the button stays disabled and
  // the backend rejects it too, so it can't be bypassed.
  const willCharge = !!(S.appliedVoucher && S.appliedVoucher.code);
  // Re-sync balance from the server before this HARD gate. S.access.balance is only a login-time
  // snapshot (updated locally on Shop buys / coupon gen, never on orders / refunds / top-ups), so a
  // mid-session top-up, a cancelled-order refund credit, or a global-wallet change in another project
  // would otherwise make this gate FALSE-decline. Fail-open: keep the snapshot if the refresh fails.
  if(willCharge){ try{ const rb=await apiCall('access_refresh',{}); if(rb&&rb.decoded&&rb.decoded.ok&&S.access){ if(rb.decoded.balance!=null) S.access.balance=rb.decoded.balance; if(rb.decoded.per_order_limit!=null) S.access.per_order_limit=rb.decoded.per_order_limit; } }catch(e){} }
  const bal = +(S.access && S.access.per_order_limit!=null ? S.access.balance : 0) || 0;
  const fee = +((S.access && S.access.per_order_limit) || 0) || 0;
  const lowBal = willCharge && bal < fee;
  openSheet('Payment', b=>{
    if(lowBal){
      b.innerHTML=`<div class="warn-box">Insufficient access balance for this voucher order. Need ₹${fee}, you have ₹${bal}. Top up to place the order.</div>
        <button class="btn-ghost" onclick="closeSheet()">Close</button>`;
      return;
    }
    b.innerHTML=`
      ${codOk?`<div class="pay-opt" id="payCod"><span class="p-ico">💵</span><div><div>Cash on Delivery</div><div class="p-sub">Pay when it arrives</div></div></div>`:''}
      <div class="pay-opt" id="payUpi"><span class="p-ico">📲</span><div><div>UPI</div><div class="p-sub">GPay / PhonePe / any UPI app</div></div></div>
      ${codOk?'':`<div class="muted center" style="padding:10px 4px;font-size:12px">Cash on Delivery is not available for this order — please pay via UPI.</div>`}`;
    const cod=$('#payCod',b); if(cod) cod.onclick=()=>placeOrder('cod');
    $('#payUpi',b).onclick=()=>placeOrder('upi');
  });
}

/* A payment/placement step failed — don't offer a dead-end Retry (it just fails again and irritates).
   Surface a brief note and drop the user straight back to their cart. */
function payFailToCart(msg){
  try{ clearTimeout(_pollTimer); _pollTimer=null; }catch(e){}
  showToast(msg || 'Payment could not be started', 'error');
  closeSheet();
  route('cart');
}

async function placeOrder(method){
  const payload={...S.checkout, payment_method:method};
  // Always send the applied voucher explicitly. S.checkout.voucher can be absent/stale depending on the
  // review path, leaving the backend with no voucher to record (or deduct). S.appliedVoucher is the UI
  // source of truth for what's actually applied.
  payload.voucher = (S.appliedVoucher && S.appliedVoucher.code) ? S.appliedVoucher.code : null;
  if(method==='upi'){
    // Validate the FRESH UPI signature BEFORE placing — never place an order we can't collect payment for.
    let jd; try{ jd=extractJuspay(S.checkout); }
    catch(e){ payFailToCart('Couldn\'t prepare UPI payment — re-open your cart and checkout again'); return; }
    payload.juspay_details=jd;
  }
  openSheet('Placing order', x=>{ x.innerHTML='<div class="center muted mt16">Placing your order…</div><div class="spin"></div>'; });
  const r=await apiCall('bb_place_order', payload);
  if(!r){ return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  if(!r.decoded.ok){ payFailToCart(r.decoded.message||'Could not place order'); return; }
  // The order is now placed on BB — the cart/PO is consumed and no longer exists. Clear the local cart
  // immediately so a stale cart can't be re-opened or re-checked-out (which errors: cart/PO not found).
  // Applies to both COD and (pending) UPI: even if the user closes the QR without paying, the items are
  // in the placed order, not the cart.
  S.cart.clear(); S._cartLoadedFor=null; refreshCartUI();
  S.checkout={...payload, ...r.decoded};
  handleCheckout(r.decoded);
}

/* UPI */
async function handleUpiPayment(d){
  S.checkout={...S.checkout, ...d};
  let jd; try{ jd=extractJuspay(S.checkout); }
  catch(e){ payFailToCart('Couldn\'t start UPI payment — re-open your cart and checkout again'); return; }
  openSheet('UPI payment', b=>{ b.innerHTML='<div class="center muted mt16">Generating payment…</div><div class="spin"></div>'; });
  const r=await apiCall('bb_juspay_txn', {
    bb_txn_id: d.bb_txn_id || S.checkout.bb_txn_id,
    order_details: jd.order_details||jd.qc_order_details,
    signature: jd.signature||jd.qc_signature,
    customer_id: jd.customer_id,
    merchant_key_id: jd.merchant_key_id||'6729'
  });
  if(!r || !r.decoded.ok){ payFailToCart('Couldn\'t start UPI payment — opening your cart'); return; }
  const data=r.decoded;
  const upi = data.upi_url || data.intent_url || '';
  const amount = data.amount || S.checkout?.order_result?.total_payable || '';
  renderUpiQr(upi, amount, d);
}

/* Popular-UPI-app deep links from a upi:// (or intent://) pay string — SAME payment params, per-app
   scheme. Tapping opens that app's payment sheet on the phone. Empty/invalid upi → []. */
function upiAppLinks(upi){
  const params=(String(upi||'').split('?')[1]||'').split('#')[0];
  if(!params) return [];
  return [ {name:'Google Pay',url:'tez://upi/pay?'+params}, {name:'PhonePe',url:'phonepe://pay?'+params},
           {name:'Paytm',url:'paytmmp://pay?'+params}, {name:'BHIM',url:'bhim://upi/pay?'+params},
           {name:'Other UPI app',url:'upi://pay?'+params} ];
}
function upiAppButtonsHtml(links){
  if(!links || !links.length) return '';
  return `<div class="upi-apps"><div class="upi-apps-lbl muted">or open an app directly · QR above still works</div>`
    +`<div class="upi-apps-grid">${links.map((a,i)=>`<button class="upi-app" data-i="${i}">${esc(a.name)}</button>`).join('')}</div></div>`;
}
/* Telegram's Mini-App WebView BLOCKS navigating to a upi:// scheme. So hand the link to
   Telegram.WebApp.openLink() pointed at an HTTPS bounce page (upi_open.php) that fires the scheme from
   the EXTERNAL browser — which CAN launch the app. Falls back to window.open / direct nav outside Telegram. */
function upiOpen(deepLink){
  let bounce=''; try{ bounce = new URL('upi_open.php?url='+encodeURIComponent(deepLink), location.href).href; }catch(e){}
  try{ if(window.Telegram && Telegram.WebApp && typeof Telegram.WebApp.openLink==='function' && bounce){ Telegram.WebApp.openLink(bounce); return; } }catch(e){}
  try{ if(bounce){ window.open(bounce, '_blank'); return; } }catch(e){}
  try{ window.location.href = deepLink; }catch(e){}
}
function wireUpiApps(root, links){
  $$('.upi-app', root).forEach(btn=>btn.onclick=()=>{ const l=links[+btn.dataset.i]; if(l&&l.url) upiOpen(l.url); });
}
function renderUpiQr(upi, amount, d){
  const qrSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data='+encodeURIComponent(upi);
  const links = upiAppLinks(upi);
  openSheet('Scan to pay', b=>{
    b.innerHTML=`
      <div class="qr-wrap">
        <div class="qr-amt">${amount?inr(amount):''}</div>
        <div class="qr-box">${upi?`<img src="${esc(qrSrc)}" alt="UPI QR">`:'<span class="muted">QR unavailable</span>'}</div>
        <div class="qr-hint muted">Scan with any UPI app to pay</div>
        ${upiAppButtonsHtml(links)}
        <div class="qr-poll" id="qrPoll">Waiting for payment…</div>
        <button class="btn-ghost" id="qrCancel">Cancel</button>
      </div>`;
    wireUpiApps(b, links);
    $('#qrCancel',b).onclick=()=>pollCancel(d);
    startPaymentPoll(d);
  });
}

let _pollTimer=null, _pollCount=0;
function startPaymentPoll(d){
  _pollCount=0; clearTimeout(_pollTimer);
  const tick=async()=>{
    _pollCount++;
    const r=await apiCall('bb_payment_poll', {encData:S.encData, order_ids:d.order_ids, txn_id:d.bb_txn_id||S.checkout.bb_txn_id, timeout:null});
    if(r && r.decoded){
      if(r.decoded.encData) S.encData=r.decoded.encData;
      const st=(r.decoded.payment_status||'').toLowerCase();
      const pn=$('#qrPoll'); if(pn) pn.textContent='Status: '+(st||'pending')+' ('+_pollCount+')';
      // Robust success match — BB/juspay return 'success' / 'successful' / 'SUCCESS' / 'charged' / etc.
      if(st.includes('success') || ['charged','complete','completed','captured','paid'].includes(st)){ clearTimeout(_pollTimer); renderOrderResult({...S.checkout, paid:true}); return; }
      if(['failed','authorization_failed','auth_failed','declined','cancelled','canceled','expired'].includes(st)){ clearTimeout(_pollTimer); renderUpiFail(d); return; }
    }
    if(_pollCount>=30){ clearTimeout(_pollTimer); finalPoll(d); return; }
    _pollTimer=setTimeout(tick, 5000);
  };
  _pollTimer=setTimeout(tick, 5000);
}
async function finalPoll(d){
  await apiCall('bb_payment_poll', {encData:S.encData, order_ids:d.order_ids, txn_id:d.bb_txn_id||S.checkout.bb_txn_id, timeout:true});
  openSheet('Payment pending', b=>{ b.innerHTML=`<div class="warn-box">Payment is still pending. Check Orders for status.</div><button class="btn-line" onclick="closeSheet();route('orders')">Go to Orders</button>`; });
}
async function pollCancel(d){ clearTimeout(_pollTimer); await finalPoll(d); }
function renderUpiFail(d){
  openSheet('Payment failed', b=>{ b.innerHTML=`<div class="warn-box">Your UPI payment failed.</div><button class="btn-primary" id="retryUpi">Retry payment</button><button class="btn-ghost" onclick="closeSheet();route('orders')">View orders</button>`; $('#retryUpi',b).onclick=()=>handleUpiPayment(d); });
}

function renderOrderResult(d){
  const o = d.order_result || {};
  S.cart.clear(); refreshCartUI(); S.selectedAddressId=null;
  openSheet('Order placed', b=>{
    b.innerHTML=`
      <div class="result">
        <div class="r-ico">✅</div>
        <h3>Order confirmed</h3>
        <div class="r-num">${o.order_number?('#'+esc(o.order_number)):''}</div>
        <div class="result-card">
          <div class="bill-row"><span>Items</span><span class="v">${esc(o.items_count||cartCount()||'')}</span></div>
          <div class="bill-row"><span>Payment</span><span class="v">${esc((o.payment_method||d.payment_method||'').toUpperCase())}</span></div>
          ${o.total_payable!=null?`<div class="bill-row total"><span>Paid / payable</span><span class="v">${inr(o.total_payable)}</span></div>`:''}
        </div>
        <button class="btn-primary mt16" onclick="closeSheet();route('orders')">Track order</button>
        <button class="btn-ghost" onclick="closeSheet();route('search')">Continue shopping</button>
      </div>`;
  });
  showToast('Order placed','success');
}

/* ═══════════════════════════════════════════════════════════════
   ADDRESS TAB
   ═══════════════════════════════════════════════════════════════ */
async function renderAddressTab(c){
  if(!S.encData){ ensureActiveAccount(c,'manage addresses'); return; }
  c.innerHTML=`<div class="tab-h">Delivery address</div><div id="addrBody"><div class="skel" style="height:90px"></div></div>
    <button class="add-acct mt12" id="addAddrBtn">+ Add new address</button>`;
  $('#addAddrBtn',c).onclick=openAddAddress;
  const r=await apiCall('bb_address_list', {encData:S.encData, mobileno:S.activePhone});
  if(!r){ return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  S.addrDecoded=r.decoded;
  seedDefaultAddress(r.decoded);
  paintAddresses(r.decoded);
}

function paintAddresses(d){
  const body=$('#addrBody'); if(!body) return;
  const addrs=d.addresses||[]; const masters=d.master_addresses||[];
  let html='';
  // Master addresses — shared across all accounts under this code (max 2). Reuse / edit / delete.
  if(masters.length){
    html+=`<div class="master-hd">Master addresses · shared across accounts</div>
      <div class="master-list">${masters.map((m,i)=>`
        <div class="master-card">
          <div class="master-card-main" data-mi="${i}" title="Tap to reuse on this account">
            <div class="master-card-t">📍 ${esc(m.master_label||m.nick||'Saved address')}</div>
            <div class="master-card-s">${esc([m.house_no,m.area,m.pincode].filter(Boolean).join(', '))||'tap to reuse'}</div>
          </div>
          <div class="master-card-acts">
            <button class="mc-btn mc-edit" data-mi="${i}" title="Edit">✎</button>
            <button class="mc-btn mc-del" data-mi="${i}" title="Delete">🗑</button>
          </div>
        </div>`).join('')}</div>`;
  }
  if(!addrs.length){ html+=`<div class="empty"><div class="e-emoji">📍</div>No saved addresses yet.</div>`; }
  else html+=addrs.map(a=>addrCardHtml(a, masters)).join('');
  body.innerHTML=html;
  $$('.addr-card',body).forEach(card=>{
    const id=card.dataset.id;
    const a=addrs.find(x=>String(x.id)===id);
    const selBtn=$('.addr-select',card); if(selBtn) selBtn.onclick=()=>selectAddress(a, card);
    const delBtn=$('.addr-del',card); if(delBtn) delBtn.onclick=()=>deleteAddress(a, card);
    const edBtn=$('.addr-edit',card); if(edBtn) edBtn.onclick=()=>editSavedAddress(a);
    const mBtn=$('.pill-master',card); if(mBtn) mBtn.onclick=()=>toggleMaster(a, mBtn.dataset.mid);
  });
  $$('.master-card-main',body).forEach(el=>el.onclick=()=>{ const m=masters[+el.dataset.mi]; if(m) openAddAddress(m); });
  $$('.mc-edit',body).forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); editMasterAddress(masters[+b.dataset.mi]); });
  $$('.mc-del',body).forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); deleteMasterAddress(masters[+b.dataset.mi]); });
}

/* Edit a saved master address with the FULL add-address flow — map pin, BB Places search,
   lat/long capture — then persist via update_master_address (keeps the master_id, re-stores
   the whole address_json incl. the new coordinates). */
function editMasterAddress(m){
  if(!m) return;
  openAddAddress(m, {
    editMaster: true,
    title: 'Edit master address',
    saveLabel: 'Save changes',
    labelField: (m.master_label || m.nick || ''),
    onSave: async (read, mlabel)=>{
      const obj = {...read.obj, master_saved:true};
      const label = mlabel || obj.apartment_name || obj.area || obj.nick || 'Saved address';
      const r=await apiCall('update_master_address', {encData:S.encData, master_id:+m.master_id, label, address:btoa(JSON.stringify(obj))});
      if(!r || !r.decoded.ok){ showToast((r&&r.decoded.message)||'Update failed','error'); return; }
      if(r.decoded.encData) S.encData=r.decoded.encData;
      showToast('Master address updated','success'); closeSheet();
      renderAddressTab($('#tab-address'));
    }
  });
}
async function deleteMasterAddress(m){
  if(!m || !confirm('Delete this master address? It will be removed for all accounts under your code.')) return;
  const r=await apiCall('delete_master_address', {encData:S.encData, master_id:+m.master_id});
  if(r && r.decoded.encData) S.encData=r.decoded.encData;
  showToast('Master address deleted','success');
  renderAddressTab($('#tab-address'));
}

/* Map a BB account address → the master address_json shape (so it can be stored/prefilled). */
function accountToMasterObj(a){
  return {
    nick: a.nick || a.address_nick || 'Home',
    first_name: a.first_name||'', last_name: a.last_name||'',
    house_no: String(a.house_no || a.address1 || ''),
    apartment_name: String(a.apartment_name || a.address2 || ''),
    landmark: String(a.landmark || ''),
    area: String(a.area || ''),
    pincode: String(a.pin || a.pincode || ''),
    lat: a.lat!=null?Number(a.lat):null, lng: a.lng!=null?Number(a.lng):null,
    addressMo: String(a.contact_no || a.addressMo || '').replace(/\D/g,'')
  };
}
function masterMatch(a, masters){
  const o=accountToMasterObj(a);
  return (masters||[]).find(m => String(m.pincode||'')===o.pincode && String(m.house_no||'')===o.house_no);
}

function addrCardHtml(a, masters){
  const nick=(a.nick||a.address_nick||'Home');
  const ico = /work|office/i.test(nick)?'💼': /other/i.test(nick)?'📌':'🏠';
  const name=`${a.first_name||''} ${a.last_name||''}`.trim();
  let phone=a.contact_no || a?.member?.mobile_no || '';
  // never surface a shop (scripthub) account's OWN number as an address contact — it would leak the sold number
  if(phone && (activeAccount()||{}).source==='scripthub' && String(phone)===String(S.activePhone)) phone='';
  const line=[a.address1,a.address2,a.area,a.city_name,a.pin].filter(Boolean).join(', ');
  const canDel = !a.is_default && !a.is_current_delivery;
  const sel = String(a.id)===String(S.selectedAddressId);
  const mm = masterMatch(a, masters); const isMaster = !!mm;
  return `<div class="addr-card ${sel?'sel':''}" data-id="${esc(a.id)}">
    <div class="addr-head"><span class="addr-ico">${ico}</span><span class="addr-nick">${esc(name||nick)}</span></div>
    <div class="addr-lines">${esc(line)}${phone?'<br>📞 '+esc(phone):''}</div>
    <div class="addr-pills">
      ${a.is_default?'<span class="pill pill-active">Default</span>':''}
      ${a.is_current_delivery?'<span class="pill pill-switch">Active</span>':''}
      <span class="pill pill-master ${isMaster?'on':''}" data-id="${esc(a.id)}" data-mid="${isMaster?esc(mm.master_id):''}" title="Share this address across all accounts under your code">${isMaster?'★ Master':'☆ Make master'}</span>
    </div>
    <div class="addr-foot">
      <button class="btn-primary addr-select">${sel?'Selected ✓':'Use this'}</button>
      <button class="btn-line addr-edit">Edit</button>
      ${canDel?'<button class="btn-danger addr-del">Delete</button>':''}
    </div></div>`;
}

/* Toggle an account address as a shared master (cap 2). */
async function toggleMaster(a, masterId){
  if(masterId){   // currently master → remove
    const r=await apiCall('delete_master_address', {encData:S.encData, master_id:+masterId});
    if(r && r.decoded.encData) S.encData=r.decoded.encData;
  } else {        // make master
    const r=await apiCall('set_master_address', {encData:S.encData, address: btoa(JSON.stringify(accountToMasterObj(a)))});
    if(!r) return;
    if(r.decoded.encData) S.encData=r.decoded.encData;
    if(!r.decoded.ok){ showToast(r.decoded.message||'Could not set master','error'); return; }
  }
  renderAddressTab($('#tab-address'));   // re-list → refreshes master chips + toggles
}

/* Edit a saved address: open the address form pre-filled, save via bb_address_update (PUT). */
function editSavedAddress(a){
  if(!S.encData){ showToast('No active account','error'); return; }
  const prefill = {
    nick: a.nick||'Home', first_name: a.first_name||'', last_name: a.last_name||'',
    house_no: a.address1||a.house_no||'', apartment_name: a.address2||a.apartment||a.apartment_name||'',
    landmark: a.landmark||'', area: a.area||'', pincode: String(a.pin||a.pincode||''),
    addressMo: String(a.contact_no||a.contact_number||''), lat: a.lat, lng: a.lng,
  };
  openAddAddress(prefill, { title:'Edit address', saveLabel:'Update address',
    onSave:(read)=>saveEditedAddress(a.id, read) });
}
async function saveEditedAddress(id, read){
  const o=read.obj;
  const r=await apiCall('bb_address_update', { encData:S.encData, mobileno:S.activePhone, address_id:String(id), address:b64u(JSON.stringify(o)), contact_number:o.addressMo });
  if(!r || !r.decoded.ok){ showToast((r&&r.decoded.message)||'Update failed','error'); return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  showToast('Address updated','success'); closeSheet();
  S.addrDecoded=null; renderAddressTab($('#tab-address'));
}
async function selectAddress(a, card){
  if(!a) return;
  const old = S._activeAddr;
  const our = `${a.first_name||''} ${a.last_name||''} ${a.address1||''}, ${a.area||''} ${a.city_name||''} ${a.pin||''}`.trim();
  const crossArea = old && String(old.pin||'')!==String(a.pin||'');
  // Crossing areas migrates the cart (items can change/drop); same-area is a plain select.
  const r = crossArea
    ? await apiCall('bb_switch_address', {
        encData:S.encData, address_id:a.id, lat_long: btoa(`${a.lat}|${a.lng}`),
        old:{lat:old.lat,lng:old.lng,area:old.area,id:old.id,pin:old.pin},
        new:{lat:a.lat,lng:a.lng,area:a.area,id:a.id,pin:a.pin},
        entry_context_id:ECID(), entry_context:S.modeCtx })
    : await apiCall('bb_address_select', {
        ...S.addrDecoded, encData:S.encData,
        address_id:a.id, lat_long: btoa(`${a.lat}|${a.lng}`),
        our_address: our, all_addresses:(S.addrDecoded?.addresses||[]),
        entry_context:S.modeCtx, entry_context_id:ECID() });
  if(!r || !r.decoded.ok){ showToast('Could not select address','error'); return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  S.latLng = r.decoded.lat_long || btoa(`${a.lat}|${a.lng}`);
  S.selectedAddressId=a.id; S.ourAddress=our; S._activeAddr=a;
  if(r.decoded.migrate_msg) showToast(r.decoded.migrate_msg,'error');
  paintAddresses(S.addrDecoded);
  // the new area may have a different (migrated) cart → invalidate so the Cart tab re-resolves it
  S.cart.clear(); S._cartLoadedFor=null;
}

async function deleteAddress(a, card){
  if(!a) return;
  const r=await apiCall('bb_address_delete', {encData:S.encData, address_id:String(a.id)});
  if(!r) return;
  if(r.decoded.encData) S.encData=r.decoded.encData;
  if(r.decoded.ok){ card.remove(); showToast('Address deleted','success'); }
  else showToast(r.decoded.message||'Delete failed','error');
}

/* Add-address sheet (map optional via Leaflet) */
let _addrMap=null, _addrMarker=null, _addrLat=null, _addrLng=null;
let _addrFromMaster=false;
function openAddAddress(prefill, opts){
  opts = opts || {};
  const editMaster = !!opts.editMaster;
  // editing a master uses opts.onSave; only the "reuse on this account" tap path sets _addrFromMaster
  _addrFromMaster = !editMaster && !!(prefill && prefill.master_id);
  openSheet(opts.title || (_addrFromMaster?'Use saved address':'Add address'), b=>{
    const labelFld = (opts.labelField!=null)
      ? `<div class="field"><label>Master label</label><input id="af_mlabel" placeholder="e.g. Home, Office" value="${esc(opts.labelField||'')}"></div>`
      : '';
    b.innerHTML=`
      <div class="addr-search">
        <input id="af_search" placeholder="🔍 Search address / area / landmark" autocomplete="off">
        <ul id="af_suggest" class="addr-suggest"></ul>
      </div>
      <div id="addrMap"><div class="map-fallback">Loading map… (you can also search above or type coordinates below)</div></div>
      ${labelFld}
      <div class="nick-seg seg" id="nickSeg">
        <button class="seg-opt active" data-n="Home">🏠 Home</button>
        <button class="seg-opt" data-n="Work">💼 Work</button>
        <button class="seg-opt" data-n="Other">📌 Other</button>
      </div>
      <div class="field-row">
        <div class="field"><label>First name</label><input id="af_first"></div>
        <div class="field"><label>Last name</label><input id="af_last"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>House / Flat no.</label><input id="af_house"></div>
        <div class="field"><label>Apartment / Building</label><input id="af_apt"></div>
      </div>
      <div class="field"><label>Landmark</label><input id="af_land"></div>
      <div class="field-row">
        <div class="field"><label>Area / Locality</label><input id="af_area"></div>
        <div class="field"><label>Pincode</label><input id="af_pin" inputmode="numeric" maxlength="6"></div>
      </div>
      <div class="field"><label>Contact mobile (required)</label><input id="af_mo" inputmode="numeric" maxlength="10" placeholder="10-digit mobile"></div>
      <div class="field-row">
        <div class="field"><label>Latitude</label><input id="af_lat" inputmode="decimal"></div>
        <div class="field"><label>Longitude</label><input id="af_lng" inputmode="decimal"></div>
      </div>
      <button class="btn-primary mt12" id="af_save">${esc(opts.saveLabel||'Save address')}</button>`;
    let nick=(prefill && prefill.nick) || 'Home';
    $$('#nickSeg .seg-opt',b).forEach(x=>{ x.classList.toggle('active', x.dataset.n===nick); x.onclick=()=>{ $$('#nickSeg .seg-opt',b).forEach(y=>y.classList.remove('active')); x.classList.add('active'); nick=x.dataset.n; }; });
    if(prefill){   // prefill the form from a master / saved address
      const set=(id,v)=>{ const el=$('#'+id,b); if(el && v!=null && v!=='') el.value=v; };
      set('af_first',prefill.first_name); set('af_last',prefill.last_name);
      set('af_house',prefill.house_no); set('af_apt',prefill.apartment_name);
      set('af_land',prefill.landmark); set('af_area',prefill.area);
      set('af_pin',prefill.pincode); set('af_mo',prefill.addressMo);
      set('af_lat',prefill.lat); set('af_lng',prefill.lng);
      _addrLat = prefill.lat!=null?Number(prefill.lat):null;
      _addrLng = prefill.lng!=null?Number(prefill.lng):null;
    }
    $('#af_save',b).onclick=()=>{
      if(opts.onSave){
        const read=readAddrForm(b, nick); if(!read) return;
        const mlabel = $('#af_mlabel',b) ? $('#af_mlabel',b).value.trim() : '';
        opts.onSave(read, mlabel);
      } else saveAddress(b, ()=>nick);
    };
    wireAddrSuggest(b);
    setTimeout(()=>initAddrMap(b), 50);
  });
}

/* Live address autosuggest via BB's Places API (matches v1): type → predictions dropdown →
   pick one → resolve placeId to lat/lng + area + pincode + fly the map there. */
function wireAddrSuggest(b){
  const sb=$('#af_search',b), sg=$('#af_suggest',b); if(!sb||!sg) return;
  let dt;
  sb.addEventListener('input', ()=>{
    const q=sb.value.trim(); clearTimeout(dt);
    if(q.length<3){ sg.innerHTML=''; sg.style.display='none'; return; }
    dt=setTimeout(async ()=>{
      try{
        const d=await (await fetch(`./bigbasket/address_lookup.php?inputText=${encodeURIComponent(q)}`)).json();
        sg.innerHTML='';
        if(d.predictions && d.predictions.length){
          sg.style.display='block';
          d.predictions.forEach(pr=>{
            const li=document.createElement('li'); li.textContent=pr.description;
            li.onclick=async ()=>{
              sg.style.display='none'; sb.value=pr.description;
              try{
                const det=await (await fetch(`./bigbasket/address_lookup.php?placeId=${encodeURIComponent(pr.placeId)}`)).json();
                const ar=$('#af_area',b), pn=$('#af_pin',b), la=$('#af_lat',b), lo=$('#af_lng',b);
                if(ar) ar.value = det.area || det.locality || '';
                if(pn) pn.value = det.pincode || '';
                if(det.lat && det.lng){
                  const lat=parseFloat(det.lat), lng=parseFloat(det.lng);
                  if(la) la.value=lat; if(lo) lo.value=lng;
                  _addrLat=lat; _addrLng=lng;
                  if(_addrMarker) _addrMarker.setLatLng([lat,lng]);
                  if(_addrMap) _addrMap.setView([lat,lng], 16);
                }
              }catch(e){ showToast('Could not load that place','error'); }
            };
            sg.appendChild(li);
          });
        } else sg.style.display='none';
      }catch(e){ sg.style.display='none'; }
    }, 300);
  });
  sb.addEventListener('blur', ()=>setTimeout(()=>{ sg.style.display='none'; }, 200));
}
/* Reverse-geocode lat/lng → fill area + pincode (used by map click/drag). */
function addrReverse(lat,lng){
  _addrLat=lat; _addrLng=lng;
  const la=$('#af_lat'), lo=$('#af_lng'); if(la) la.value=lat.toFixed(6); if(lo) lo.value=lng.toFixed(6);
  fetch(`https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`)
    .then(r=>r.json()).then(j=>{ const a=j.address||{};
      const ar=$('#af_area'), pn=$('#af_pin');
      if(ar && !ar.value) ar.value=a.suburb||a.neighbourhood||a.village||a.town||a.city_district||a.road||'';
      if(pn && !pn.value) pn.value=a.postcode||'';
    }).catch(()=>{});
}

let _leafletState=0; // 0=unloaded, 1=loading, 2=ready, 3=failed
function loadLeaflet(cb){
  if(typeof L!=='undefined'){ _leafletState=2; cb&&cb(); return; }
  if(_leafletState===1) return;
  if(_leafletState===3){ cb&&cb(); return; }
  _leafletState=1;
  const css=document.createElement('link'); css.rel='stylesheet'; css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
  const s=document.createElement('script'); s.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  s.onload=()=>{ _leafletState=2; cb&&cb(); };
  s.onerror=()=>{ _leafletState=3; cb&&cb(); };
  document.head.appendChild(s);
}
function initAddrMap(b){
  const mapEl=$('#addrMap',b);
  if(!mapEl) return;
  if(typeof L==='undefined'){
    if(_leafletState===3){ const fb=mapEl.querySelector('.map-fallback'); if(fb) fb.textContent='Map offline — enter area & coordinates manually.'; return; }
    loadLeaflet(()=>initAddrMap(b)); return;
  }
  try{
    mapEl.innerHTML='';
    // center on the prefill / already-pinned location if we have one, else a country-level default
    const cLat=_addrLat||20.5937, cLng=_addrLng||78.9629;
    _addrMap=L.map(mapEl,{zoomControl:true}).setView([cLat,cLng], _addrLat?16:5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OSM'}).addTo(_addrMap);
    _addrMarker=L.marker([cLat,cLng],{draggable:true}).addTo(_addrMap);
    _addrMarker.on('dragend', e=>{ const p=e.target.getLatLng(); addrReverse(p.lat,p.lng); });
    _addrMap.on('click', e=>{ _addrMarker.setLatLng(e.latlng); addrReverse(e.latlng.lat,e.latlng.lng); });
    setTimeout(()=>_addrMap.invalidateSize(),200);
  }catch(e){ mapEl.querySelector('.map-fallback') && (mapEl.querySelector('.map-fallback').textContent='Map error — enter coordinates manually.'); }
}

/* Read + validate the shared add/edit address form → {obj, lat, lng} or null (toasts on missing pin). */
/* Address uniqueness — make a saved address subtly unique (anti duplicate-address + anti embedded-number
   detection): append random letters to the TEXT fields and drop a '.' into any long digit-run (e.g. a phone
   number someone typed into a name/house field). NEVER touches pincode, contact number (addressMo), lat/lng.
   Used by BOTH the Bulk Orders engine (its own checkbox) and manual saves (Bot Settings toggle). */
function randomizeAddress(obj){
  if(!obj) return obj;
  const rl=n=>Array.from({length:n},()=>String.fromCharCode(97+Math.floor(Math.random()*26))).join('');
  const dotNum=s=>String(s==null?'':s).replace(/\d{5,}/g,m=>{ const p=1+Math.floor(Math.random()*(m.length-1)); return m.slice(0,p)+'.'+m.slice(p); });
  [['first_name',2],['last_name',2],['house_no',1],['apartment_name',1],['landmark',1],['area',1]].forEach(([k,n])=>{
    const v=obj[k]; if(v==null||v==='') return;
    obj[k]=dotNum(v)+rl(n);
  });
  return obj;
}
function readAddrForm(b, nick){
  const lat = parseFloat($('#af_lat',b).value)|| _addrLat;
  const lng = parseFloat($('#af_lng',b).value)|| _addrLng;
  if(!lat || !lng){ showToast('Pin a location / enter coordinates','error'); return null; }
  const addressMo = $('#af_mo',b).value.replace(/\D/g,'');
  if(addressMo.length!==10){ showToast('Enter a valid 10-digit contact mobile','error'); return null; }
  const obj = {
    nick,
    house_no: $('#af_house',b).value.trim(),
    apartment_name: $('#af_apt',b).value.trim(),
    landmark: $('#af_land',b).value.trim(),
    first_name: $('#af_first',b).value.trim(),
    last_name: $('#af_last',b).value.trim(),
    area: $('#af_area',b).value.trim(),
    pincode: $('#af_pin',b).value.trim(),
    lat:Number(lat), lng:Number(lng),
    addressMo
  };
  return {obj, lat, lng};
}

async function saveAddress(b, getNick){
  const read = readAddrForm(b, getNick());
  if(!read) return;
  let {obj, lat, lng} = read;
  // A default (master) address reused on an account is saved with a 10–20 m random jitter on its
  // coordinates, so multiple accounts never store byte-identical lat/lng (a duplicate-address fraud
  // signal). Only for master reuse — a manually pinned/entered address keeps its exact coordinates.
  // Address uniqueness (Bot Settings toggle, default ON) — randomise the text fields + break any embedded
  // number, AND jitter the GPS ~30 m, so no two saved addresses are byte-identical.
  if(S.addressUnique !== false){
    randomizeAddress(obj);
    const j=jitterLatLng(obj.lat, obj.lng, 10, 30); obj.lat=j.lat; obj.lng=j.lng; lat=j.lat; lng=j.lng;
  } else if(_addrFromMaster){
    const j=jitterLatLng(obj.lat, obj.lng, 10, 20); obj.lat=j.lat; obj.lng=j.lng; lat=j.lat; lng=j.lng;
  }
  // strip stale address/lat_long from spread blob
  const blob={...(S.addrDecoded||{})}; delete blob.address; delete blob.lat_long;
  const r=await apiCall('bb_address_save', {
    ...blob, encData:S.encData, mobileno:S.activePhone,
    address: btoa(JSON.stringify(obj)), lat_long: btoa(`${lat}|${lng}`),
    from_master: _addrFromMaster   // came from a master → backend won't re-store it
  });
  _addrFromMaster=false;
  if(!r || !r.decoded.ok){ showToast((r&&r.decoded.message)||'Save failed','error'); return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  // Make the JUST-saved address the active one for checkout — otherwise a stale previous selection would
  // deliver to the OLD address. Trust the backend-resolved id + the coords we saved.
  if(r.decoded.address_id){ S.selectedAddressId=r.decoded.address_id; S.latLng=btoa(`${obj.lat}|${obj.lng}`); S.ourAddress=r.decoded.our_address||S.ourAddress; }
  showToast('Address saved','success');
  closeSheet();
  // next_op bb_address_list -> re-list
  renderAddressTab($('#tab-address'));
}

/* ═══════════════════════════════════════════════════════════════
   ACCOUNTS TAB
   ═══════════════════════════════════════════════════════════════ */
const ACCT_PAGE_SIZE=20;
const ORD_PAGE_SIZE=100;
async function renderAccountsTab(c){
  if(S.acctTab==null) S.acctTab='unused';
  c.innerHTML=`
    <div class="acct-hd">
      <div class="tab-h" style="margin:0">Accounts</div>
      <button class="acct-add-top" id="addAcctBtn">+ Add account</button>
    </div>
    <input id="acctSearch" class="acct-search" placeholder="🔍 Search by number or ID" inputmode="numeric" autocomplete="off" value="${esc(S.acctSearch||'')}">
    <div class="seg acct-tabs" id="acctTabs">
      <button class="seg-opt ${S.acctTab!=='used'?'active':''}" data-t="unused">Unused</button>
      <button class="seg-opt ${S.acctTab==='used'?'active':''}" data-t="used">Used</button>
    </div>
    <div id="acctBody"><div class="skel" style="height:70px"></div></div>
    <div id="acctPager"></div>`;
  $('#addAcctBtn',c).onclick=()=>openLogin(true);
  $('#acctSearch',c).addEventListener('input', e=>{ S.acctSearch=e.target.value.replace(/\D/g,''); S.acctPage=0; paintAccounts(); });
  $$('#acctTabs .seg-opt',c).forEach(b=>b.addEventListener('click',()=>{
    S.acctTab=b.dataset.t; S.acctPage=0;
    $$('#acctTabs .seg-opt',c).forEach(x=>x.classList.toggle('active', x.dataset.t===S.acctTab));
    paintAccounts();
  }));
  const r=await apiCall('list_accounts_by_code', {});
  if(!r) return;
  S.accounts=r.decoded.accounts||[]; S.activePhone=r.decoded.active_phone||S.activePhone;
  if(S.acctPage==null) S.acctPage=0;
  paintAccounts();
  paintTopbar();
}

/* paginate the roster (20/page), newest first, with continuous serial numbers */
function paintAccounts(){
  const body=$('#acctBody'); if(!body) return;
  const roster=S.accounts||[];
  // tab counts (over the whole roster, ignoring search)
  const usedN=roster.filter(a=>a.is_used).length, unusedN=roster.length-usedN;
  const tu=document.querySelector('#acctTabs .seg-opt[data-t="unused"]'); if(tu) tu.textContent='Unused ('+unusedN+')';
  const td=document.querySelector('#acctTabs .seg-opt[data-t="used"]'); if(td) td.textContent='Used ('+usedN+')';
  // filter by active tab + number search
  const wantUsed=S.acctTab==='used', q=(S.acctSearch||'');
  const all=roster.filter(a=> (!!a.is_used===wantUsed) && (!q || String(a.mobile_no).includes(q) || (a.source==='scripthub' && decodeMid(a.m_id).includes(q))) );
  if(!all.length){ body.innerHTML=`<div class="empty"><div class="e-emoji">👤</div>${q?('No '+(wantUsed?'used':'unused')+' account matches “'+esc(q)+'”.'):('No '+(wantUsed?'used':'unused')+' accounts yet.')}</div>`; const pg=$('#acctPager'); if(pg) pg.innerHTML=''; return; }
  const pages=Math.ceil(all.length/ACCT_PAGE_SIZE);
  if(S.acctPage>=pages) S.acctPage=pages-1; if(S.acctPage<0) S.acctPage=0;
  const start=S.acctPage*ACCT_PAGE_SIZE;
  body.innerHTML='';
  all.slice(start, start+ACCT_PAGE_SIZE).forEach((a,i)=>body.appendChild(acctRow(a, start+i+1)));
  const pg=$('#acctPager');
  if(pg){
    pg.innerHTML = pages>1 ? `<div class="acct-pager">
      <button class="btn-line" id="acctPrev" ${S.acctPage===0?'disabled':''}>‹ Prev</button>
      <span class="acct-pg">Page ${S.acctPage+1} / ${pages} · ${all.length} accounts</span>
      <button class="btn-line" id="acctNext" ${S.acctPage>=pages-1?'disabled':''}>Next ›</button>
    </div>` : `<div class="acct-pg" style="text-align:center;padding:8px">${all.length} account${all.length>1?'s':''}</div>`;
    const pv=$('#acctPrev',pg); if(pv) pv.onclick=()=>{ S.acctPage--; paintAccounts(); };
    const nx=$('#acctNext',pg); if(nx) nx.onclick=()=>{ S.acctPage++; paintAccounts(); };
  }
}

function acctRow(a, serial){
  const row=el('div','acct');
  const isActive = a.mobile_no===S.activePhone && S.loggedIn;
  let ctrl;
  if(isActive) ctrl=`<span class="pill pill-active">Active</span>`;
  else if(a._revoked) ctrl=`<button class="pill acct-revoked" style="color:#e5484d;border:1px solid #e5484d66;background:#e5484d18">⚠ Revoked</button>`;
  else if(a.has_token) ctrl=`<button class="pill pill-switch acct-switch">Switch</button>`;
  else ctrl=`<span class="pill pill-nolink">Open once</span>`;
  const tag = a.source==='json' ? `<span class="acct-tag">JSON</span>` : '';
  row.innerHTML=`
    <div class="acct-sn">${serial}</div>
    <div class="acct-av">${initials(a.name)}</div>
    <div class="acct-mid">
      <div class="acct-name">${esc(a.name||'BigBasket user')}${tag}</div>
      <div class="acct-ph">${esc(acctLabel(a))}</div>
    </div>
    <button class="acct-del" title="Delete from bot" aria-label="Delete from bot">🗑</button>
    <div class="acct-actions">
      ${ctrl}
      <button class="pill pill-mark acct-mark">${a.is_used?'↩ Unused':'✓ Used'}</button>
    </div>`;
  const sw=$('.acct-switch',row);
  if(sw) sw.onclick=()=>switchAccount(a.mobile_no);
  const rv=$('.acct-revoked',row); if(rv) rv.onclick=()=>showRevokedPrompt(a.mobile_no);
  else if(!isActive && !a.has_token) row.onclick=(e)=>{ if(!e.target.closest('.acct-mark')) showToast('Open this number once via + Add account to log in'); };
  const mk=$('.acct-mark',row); if(mk) mk.onclick=(e)=>{ e.stopPropagation(); toggleAccountUsed(a); };
  const dl=$('.acct-del',row); if(dl) dl.onclick=(e)=>{ e.stopPropagation(); deleteAccountSoft(a); };
  return row;
}

/* Soft-delete an account (like Swiggy): hidden from the app + orders, but kept in the DB. It only comes
   back after a real OTP re-login (+ Add account with that number). One-line confirm on purpose. */
async function deleteAccountSoft(a){
  if(!confirm('Are you sure you want to delete this account from the bot?')) return;
  const r=await apiCall('bb_account_delete', {mobile_no:a.mobile_no});
  if(!r || !r.decoded.ok){ showToast('Could not delete','error'); return; }
  S.accounts=(S.accounts||[]).filter(x=>x.mobile_no!==a.mobile_no);
  if(a.mobile_no===S.activePhone){ S.activePhone=null; S.encData=null; try{ paintTopbar(); }catch(e){} }
  showToast('Account deleted','success');
  paintAccounts();
}
async function toggleAccountUsed(a){
  const newUsed=!a.is_used;
  const r=await apiCall('set_account_used', {mobile_no:a.mobile_no, used:newUsed});
  if(!r || !r.decoded.ok){ showToast('Could not update','error'); return; }
  a.is_used=newUsed;
  const idx=(S.accounts||[]).findIndex(x=>x.mobile_no===a.mobile_no); if(idx>=0) S.accounts[idx].is_used=newUsed;
  showToast(newUsed?'Marked used':'Marked unused','success');
  paintAccounts();   // it'll drop out of the current tab into the other
}

/* switch_account → bb_app_data (re-seed) → Search */
async function switchAccount(mobile){
  showToast('Switching…');
  const r=await apiCall('switch_account', {mobile_no:mobile, mode:S.modeCtx});
  if(!r){ return; }
  if(!r.decoded.ok){ if(r.decoded.revoked){ showRevokedPrompt(mobile, r.decoded.message); } else { showToast(r.decoded.message||'Switch failed','error'); } return; }
  S.encData=r.decoded.encData;
  S.activePhone=r.decoded.mobileno||mobile;
  S.loggedIn=true;
  // bb_app_data re-seeds cookies/bucket (next_op bb_address_list — we stop here)
  const r2=await apiCall('bb_app_data', {encData:S.encData});
  if(r2 && r2.decoded.encData) S.encData=r2.decoded.encData;
  S.cart.clear(); S._cartLoadedFor=null; refreshCartUI();
  // Switching accounts must drop the PREVIOUS account's address cache — otherwise ensureAddresses()
  // returns the old addresses and checkout sends a wrong address_id + stale latLng to the new account
  // (→ bb_checkout fails / session error). Re-seed this account's default so checkout AND search have a
  // valid address immediately (switch_account already set the server-side delivery address).
  S.selectedAddressId=null; S.addrDecoded=null; S._activeAddr=null; S.latLng=null; S.ourAddress=null;
  try{
    const seedAddrs=await ensureAddresses();
    if(seedAddrs.length){
      const da=seedAddrs.find(x=>x.is_current_delivery)||seedAddrs.find(x=>x.is_default)||seedAddrs[0];
      if(da) setActiveAddress(da);
    }
  }catch(e){}
  paintTopbar();
  await preloadCart(true);   // load THIS account's existing cart (don't clear it on the server)
  showToast('Switched to '+mobile,'success');
  route('search');
}

/* Dead/revoked account (BB 401s every call) — block entry and tell the user clearly, instead of
   opening a broken session. Marks the row so it shows a "Revoked" badge, and offers a re-login. */
function showRevokedPrompt(mobile, msg){
  const idx=(S.accounts||[]).findIndex(x=>String(x.mobile_no)===String(mobile));
  if(idx>=0){ S.accounts[idx]._revoked=true; }
  const acct = idx>=0 ? S.accounts[idx] : null;
  const isShop = acct && acct.source==='scripthub';                       // shop account → hide its number
  const label = acct ? acctLabel(acct) : ('+91 '+mobile);
  openSheet('Account unavailable', b=>{
    b.innerHTML=`<div style="text-align:center;padding:6px 4px">
      <div style="font-size:46px;line-height:1;margin-bottom:10px">🚫</div>
      <div style="font-weight:700;font-size:17px;margin-bottom:6px">Access revoked by BigBasket</div>
      <div class="muted" style="margin-bottom:18px;line-height:1.4">${esc(label)}<br>${esc(msg||"BigBasket has revoked this account's session. It can't be opened until it's logged in again with a fresh OTP.")}</div>
      ${isShop?'':'<button class="btn-primary" id="revoRelogin">Re-login this number</button>'}
      <button class="btn-line mt12" id="revoClose">Close</button>
    </div>`;
    const rl=$('#revoRelogin',b); if(rl) rl.onclick=()=>{ closeSheet(); openLogin(true); const inp=$('#login_phone'); if(inp){ inp.value=String(mobile); inp.focus(); } };
    const cl=$('#revoClose',b); if(cl) cl.onclick=()=>closeSheet();
    // recovery availability is checked ON-DEMAND, only now that this modal opened (never preloaded to the client)
    apiCall('can_recover', { mobile_no: mobile }).then(r=>{
      if(!(r && r.decoded && r.decoded.ok && r.decoded.can_recover)) return;
      const closeBtn=$('#revoClose',b); if(!closeBtn || !closeBtn.parentNode) return;
      const price=(r.decoded.price!=null)?r.decoded.price:5;
      const rc=document.createElement('button');
      rc.className='btn-primary mt12'; rc.id='revoRecover'; rc.textContent='Recover account · ₹'+price;
      closeBtn.parentNode.insertBefore(rc, closeBtn);
      rc.onclick=()=>revoDoRecover(rc, mobile, idx, label, b);
    }).catch(()=>{});
  });
  try{ paintAccounts(); }catch(e){}
}
/* Recover a revoked account via stored password (₹5, charged only on success). No native confirm()
   (webview-safe) — the button label states the fee and it's a deliberate second tap. */
async function revoDoRecover(btn, mobile, idx, label, b){
  btn.disabled=true; const old=btn.textContent; btn.textContent='Recovering… (few seconds)';
  const r=await apiCall('recover_account', { mobile_no: mobile });
  if(!r || !r.decoded){ btn.disabled=false; btn.textContent=old; return; }
  if(!r.decoded.ok){ btn.disabled=false; btn.textContent=old; showToast(r.decoded.message||'Recovery failed','error'); return; }
  if(r.decoded.new_balance!=null && S.access){ S.access.balance=r.decoded.new_balance; try{ paintTopbar(); }catch(e){} }
  if(idx>=0 && S.accounts[idx]){ S.accounts[idx]._revoked=false; }   // live again
  try{ await loadAccountsRoster(true); }catch(e){}
  b.innerHTML=`<div style="text-align:center;padding:10px 4px">
      <div style="font-size:46px;line-height:1;margin-bottom:10px">✅</div>
      <div style="font-weight:700;font-size:17px;margin-bottom:6px">Account recovered</div>
      <div class="muted" style="margin-bottom:18px;line-height:1.4">${esc(label)}<br>It's live again — you can use it now.</div>
      <button class="btn-primary" id="revoDone">Done</button></div>`;
  const dn=$('#revoDone',b); if(dn) dn.onclick=()=>closeSheet();
}

/* ═══════════════════════════════════════════════════════════════
   ORDERS TAB  (cross-account roster + live track)
   ═══════════════════════════════════════════════════════════════ */
async function renderOrdersTab(c){
  if(S.ordPage==null) S.ordPage=0;
  c.innerHTML=`<div class="tab-h">Orders</div><div id="ordBody"><div class="skel" style="height:80px"></div></div><div id="ordPager"></div>`;
  const r=await apiCall('list_orders_by_code', {limit:ORD_PAGE_SIZE, offset:S.ordPage*ORD_PAGE_SIZE});
  if(!r) return;
  const orders=r.decoded.orders||[];
  const total=(r.decoded.total!=null)?r.decoded.total:orders.length;
  const body=$('#ordBody',c), pg=$('#ordPager',c);
  if(!total){ body.innerHTML=`<div class="empty"><div class="e-emoji">📦</div>No orders yet.</div>`; if(pg) pg.innerHTML=''; return; }
  const pages=Math.ceil(total/ORD_PAGE_SIZE);
  if(S.ordPage>0 && !orders.length){ S.ordPage=pages-1; return renderOrdersTab(c); }
  body.innerHTML='';
  orders.forEach(o=>body.appendChild(orderCard(o)));
  if(pg){
    pg.innerHTML = pages>1 ? `<div class="acct-pager">
      <button class="btn-line" id="ordPrev" ${S.ordPage===0?'disabled':''}>‹ Prev</button>
      <span class="acct-pg">Page ${S.ordPage+1} / ${pages} · ${total} orders</span>
      <button class="btn-line" id="ordNext" ${S.ordPage>=pages-1?'disabled':''}>Next ›</button>
    </div>` : `<div class="acct-pg" style="text-align:center;padding:8px">${total} order${total>1?'s':''}</div>`;
    const pv=$('#ordPrev',pg); if(pv) pv.onclick=()=>{ S.ordPage--; renderOrdersTab(c); };
    const nx=$('#ordNext',pg); if(nx) nx.onclick=()=>{ S.ordPage++; renderOrdersTab(c); };
  }
}

function statusClass(st){
  const s=(st||'').toLowerCase();
  if(/deliver|complete/.test(s)) return 'st-delivered';
  if(/cancel|fail/.test(s)) return 'st-cancelled';
  if(/open|pending|process|placed/.test(s)) return 'st-open';
  return 'st-default';
}
/* Clean shared order card: #num + amount, status-dot line, muted meta, compact actions. */
function orderCardEl(opts){
  const card=el('div','order-card');
  const sc=statusClass(opts.status);
  const statusTxt=(opts.status||'—').replace(/_/g,' ');
  card.innerHTML=`
    <div class="oc-head"><span class="oc-num">#${esc(opts.num)}</span><span class="oc-amt">${inr(opts.amt)}</span></div>
    <div class="oc-line"><span class="oc-dot ${sc}"></span><span class="oc-status">${esc(statusTxt)}</span>${opts.meta1?`<span class="oc-sep">·</span><span>${esc(opts.meta1)}</span>`:''}</div>
    ${opts.meta2?`<div class="oc-line oc-mut">${esc(opts.meta2)}</div>`:''}
    <div class="oc-foot"><button class="btn-line ord-detail">Details</button><button class="btn-primary ord-track">Live Track</button></div>`;
  $('.ord-detail',card).onclick=opts.onDetail;
  $('.ord-track',card).onclick=opts.onTrack;
  return card;
}
function orderCard(o){
  return orderCardEl({
    num:o.order_number||o.id, amt:o.total, status:o.status,
    meta1:[o.account_name, o.is_shop ? ('ID '+decodeMid(o.m_id)) : o.mobile_no].filter(Boolean).join(' · '),
    meta2:[(o.payment_method||'').toUpperCase(), istTime(o.created_at)].filter(Boolean).join('   ·   '),
    onDetail:()=>orderDetail(o), onTrack:()=>liveTrack(o)
  });
}

/* Claim a refund for a CANCELLED order — backend live-verifies cancellation with BB, refunds the
   access charge ONCE, and returns the new balance. Result shown in a sheet (success toasts are muted). */
async function claimOrderRefund(o, back){
  const mobile=o.mobile_no||S.activePhone;
  const orderId=String(o.id||o.order_id||o.order_number||'');
  const r=await apiCall('refund_order', {mobile_no:mobile, order_id:orderId});
  if(!r) return;
  const d=r.decoded;
  if(d.ok && S.access && d.new_balance!=null) S.access.balance=d.new_balance;
  openSheet(d.ok?'Refund complete':'Refund', b=>{
    b.innerHTML=`<div style="text-align:center;padding:8px 4px">
      <div style="font-size:44px;line-height:1;margin-bottom:10px">${d.ok?'✅':(d.already?'ℹ️':'⚠️')}</div>
      <div style="font-weight:600;font-size:15px;margin-bottom:12px;line-height:1.4">${esc(d.message||(d.ok?'Refunded':'Refund not available'))}</div>
      ${d.ok&&d.new_balance!=null?`<div class="muted" style="margin-bottom:14px">New access balance: ₹${esc(String(d.new_balance))}</div>`:''}
      <button class="btn-primary" id="rfOk">OK</button>
    </div>`;
    const ok=$('#rfOk',b); if(ok) ok.onclick=()=>{ closeSheet(); if(d.ok||d.already) orderDetail(o, back); };
  });
}

/* multi-account: switch_account(mobile) → bb_app_data → bb_order_track */
async function ensureAccountSession(mobile){
  if(mobile===S.activePhone && S.encData) return true;
  const r=await apiCall('switch_account', {mobile_no:mobile, mode:S.modeCtx});
  if(!r || !r.decoded.ok){ if(r&&r.decoded.revoked){ showRevokedPrompt(mobile, r.decoded.message); } else { showToast((r&&r.decoded.message)||'Cannot open this account','error'); } return false; }
  S.encData=r.decoded.encData; S.activePhone=mobile; S.loggedIn=true;
  // Switching the active account (e.g. to cancel another account's order) must also drop the previous
  // account's cached address state, else a later checkout would reuse the wrong address_id + latLng.
  S._cartLoadedFor=null; S.selectedAddressId=null; S.addrDecoded=null; S._activeAddr=null; S.latLng=null; S.ourAddress=null;
  const r2=await apiCall('bb_app_data', {encData:S.encData});
  if(r2 && r2.decoded.encData) S.encData=r2.decoded.encData;
  paintTopbar();
  return true;
}

async function liveTrack(o, back){
  openSheet('Live tracking', b=>{ b.innerHTML='<div class="center muted mt16">Loading tracking…</div><div class="spin"></div>'; }, back);
  // transient: fetch via the ORDER'S account token — does NOT change the active account
  const r=await apiCall('bb_order_view', {mobile_no:o.mobile_no||S.activePhone, order_id:String(o.id||o.order_id||o.order_number), what:'track'});
  if(!r || !r.decoded.ok){ openSheet('Tracking', b=>{ b.innerHTML=`<div class="warn-box">${esc((r&&r.decoded.message)||'Tracking unavailable')}</div>`; }, back); return; }
  renderTrack(r.decoded.track_data||{}, o, back);
}

function renderTrack(td, o, back){
  const ord=td.order||{}; const eta=td.eta||{}; const cee=td.cee||td.delivery_executive;
  const statesArr=(Array.isArray(ord.states)&&ord.states.length)?ord.states:null;
  const steps=['Placed','Packed','Out for delivery','Delivered'];
  const activeIdx=statusStep(ord.status||o.status);  // real status, not a percentage
  const etaBig=eta.estimated_arrival||eta.order_eta||ord.display_status||'In progress';
  const etaSub=eta.tag_2||eta.order_delivery_message||eta.message||eta.order_status_message||ord.display_status||'';
  openSheet('Tracking #'+(ord.order_number||o.order_number||''), b=>{
    b.innerHTML=`
      <div class="eta-card">
        <div class="eta-big">${esc(etaBig)}</div>
        <div class="eta-sub">${esc(etaSub)}</div>
      </div>
      <div class="timeline">${
        statesArr
        ? statesArr.map(s=>`<div class="tl-step ${s.is_active?'done':'muted'}"><div class="tl-name">${esc(s.name)}</div></div>`).join('')
        : steps.map((s,i)=>{ const cls=i<activeIdx?'done':i===activeIdx?'active':'muted'; return `<div class="tl-step ${cls}"><div class="tl-name">${esc(s)}</div></div>`; }).join('')
      }</div>
      ${cee&&cee.name?`<div class="cee-card">
        <div class="cee-av">${initials(cee.name)}</div>
        <div class="acct-mid"><div class="acct-name">${esc(cee.name||'Delivery partner')}</div>
          <div class="acct-ph">${cee.cee_rating?('⭐ '+esc(cee.cee_rating)+'  '):''}${esc(cee.mobile_number||'')}</div></div>
        ${cee.cta_text?`<button class="pill pill-switch" id="ceeCall">${esc(cee.cta_text)}</button>`:''}
      </div>`:''}`;
    const callBtn=$('#ceeCall',b);
    if(callBtn) callBtn.onclick=async()=>{ const r=await apiCall('bb_cee_callback',{encData:S.encData, order_id:String(o.id||o.order_id)}); showToast((r&&r.decoded.message)||'Requested','success'); };
  }, back);
}

async function orderDetail(o, back){
  openSheet('Order details', b=>{ b.innerHTML='<div class="center muted mt16">Loading order…</div><div class="spin"></div>'; }, back);
  // transient: fetch via the ORDER'S account token — does NOT change the active account
  const r=await apiCall('bb_order_view', {mobile_no:o.mobile_no||S.activePhone, order_id:String(o.id||o.order_id||o.order_number), what:'detail'});
  if(!r || !r.decoded.ok){ openSheet('Order', b=>{ b.innerHTML=`<div class="warn-box">${esc((r&&r.decoded.message)||'Details unavailable')}</div>`; }, back); return; }
  const od = r.decoded.order_data?.order || r.decoded.order_data || {};
  const rf = r.decoded.refund || {};   // server-side eligibility: charged for this order + cancelled + not-yet-refunded
  const m=od.member||{}, eta=od.eta||{}, hdr=od.header_details||{}, grp=od.line_items_grp||{};
  const delivered=[...(grp.no_change?.line_items||[]),...(grp.weight_change?.line_items||[])];
  const undelivered=grp.undelivered?.line_items||[];
  const allItems=delivered.length?delivered:getLineItems(od);
  const charges=(od.charges||[]).filter(c=>(+c.charge||0)>0 || c.waive_off_applied);
  const wallet=parseFloat(od.wallet_used||0), neu=parseFloat(od.neucoins_used||0);
  const subTotal=parseFloat(od.sub_total||od.original_total||0);
  const finalTotal=parseFloat(od.total_payable ?? od.final_total ?? od.actual_final_total_with_charges ?? 0);
  const delCharge=parseFloat(od.delivery_charge||0);
  const vcode=od.voucher_code||'', vamt=parseFloat(od.voucher_amount||od.final_voucher_amount||0);
  const odChgSum=charges.reduce((s,c)=>s+(c.waive_off_applied?0:(+c.charge||0)),0)+(delCharge>0?delCharge:0);
  const odVoucherCashback = vamt>0 && ((subTotal+odChgSum-wallet-neu) - finalTotal) < (vamt*0.5);
  openSheet('Order #'+(od.order_number||o.order_number||''), b=>{
    let h=`<div class="od-status"><span class="status-pill ${statusClass(od.status)}">${esc(od.display_status||od.status||'')}</span>${od.slot?.display_slot?`<span class="od-slot">${esc(od.slot.display_slot)}</span>`:''}</div>`;
    if(hdr.title||eta.order_delivery_message||eta.estimated_arrival) h+=`<div class="eta-card"><div class="eta-big">${esc(hdr.title||eta.estimated_arrival||'')}</div><div class="eta-sub">${esc(hdr.msg||eta.order_delivery_message||eta.message||'')}</div></div>`;
    if(Array.isArray(od.states)&&od.states.length) h+=`<div class="od-sec-h">Order progress</div><div class="timeline">${od.states.map(s=>`<div class="tl-step ${s.is_active?'done':'muted'}"><div class="tl-name">${esc(s.name)}</div></div>`).join('')}</div>`;
    if(allItems.length){ h+=`<div class="od-sec-h">Items (${allItems.length})</div><div class="od-items">`;
      allItems.forEach(it=>{ h+=`<div class="od-item"><img class="od-item-img" src="${esc(it.img_url||'')}" onerror="this.style.visibility='hidden'"><div class="od-item-mid"><div class="od-item-name">${esc(((it.brand||'')+' '+(it.desc||it.description||'')).trim())}</div><div class="od-item-meta">${esc(it.weight||it.w||'')}${(it.weight||it.w)?' · ':''}Qty ${esc(it.quantity||it.qty||1)}</div></div><div class="od-item-amt">${inr(it.total||it.sp||0)}</div></div>`; });
      h+=`</div>`; }
    if(undelivered.length){ h+=`<div class="od-sec-h" style="color:var(--rd)">Undelivered (${undelivered.length})</div><div class="od-items">`;
      undelivered.forEach(it=>{ h+=`<div class="od-item" style="opacity:.55"><img class="od-item-img" src="${esc(it.img_url||'')}" onerror="this.style.visibility='hidden'"><div class="od-item-mid"><div class="od-item-name" style="text-decoration:line-through">${esc(((it.brand||'')+' '+(it.desc||'')).trim())}</div><div class="od-item-meta">Qty ${esc(it.quantity||1)}</div></div><div class="od-item-amt"><s>${inr(it.sp||0)}</s></div></div>`; });
      h+=`</div>`; }
    h+=`<div class="od-sec-h">Bill details</div><div class="bill"><div class="bill-row"><span>Item total</span><span>${inr(subTotal)}</span></div>`;
    charges.forEach(c=>{ const nm=c.description?.display_name||c.description?.name||'Charge';
      h+= c.waive_off_applied ? `<div class="bill-row"><span>${esc(nm)}</span><span><s class="muted">${inr(c.calculated_charge)}</s> <span class="free">FREE</span></span></div>` : `<div class="bill-row"><span>${esc(nm)}</span><span>${inr(c.charge)}</span></div>`; });
    if(delCharge>0) h+=`<div class="bill-row"><span>Delivery</span><span>${inr(delCharge)}</span></div>`;
    if(vcode||vamt>0) h+= odVoucherCashback
      ? `<div class="bill-row"><span>🎁 bbWallet cashback ${vcode?`<b class="vch-chip">${esc(vcode)}</b>`:''}</span><span class="muted">${inr(vamt)} after delivery</span></div>`
      : `<div class="bill-row save"><span>Voucher ${vcode?`<b class="vch-chip">${esc(vcode)}</b>`:''}</span><span>− ${inr(vamt)}</span></div>`;
    if(wallet>0) h+=`<div class="bill-row save"><span>👛 bbWallet</span><span>− ${inr(wallet)}</span></div>`;
    if(neu>0) h+=`<div class="bill-row save"><span>🪙 NeuCoins</span><span>− ${inr(neu)}</span></div>`;
    h+=`<div class="bill-row total"><span>Total payable</span><span>${inr(finalTotal)}</span></div>`;
    h+=`<div class="bill-row"><span class="muted">Payment</span><span>${esc(od.display_payment_method||'')}${od.payment_status_message?' · '+esc(od.payment_status_message):''}</span></div></div>`;
    if(od.savings_msg||+od.savings>0) h+=`<div class="od-savings">🎉 ${esc(od.savings_msg||('You saved ₹'+(od.savings||0)))}</div>`;
    if(m.first_name||m.address1) h+=`<div class="addr-card mt12"><div class="addr-head"><span class="addr-ico">📍</span><span class="addr-nick">${esc(((m.first_name||'')+' '+(m.last_name||'')).trim()||'Delivery address')}</span></div><div class="addr-lines">${esc([m.address1,m.address2,m.area,m.city,m.pin].filter(Boolean).join(', '))}</div></div>`;
    h+=`<div class="row-btns mt12"><button class="btn-primary" id="odTrack">Live Track</button>${od.can_cancel?'<button class="btn-danger" id="odCancel">Cancel</button>':''}${rf.eligible?`<button class="btn-line" id="odRefund" style="border-color:#3ba55d;color:#3ba55d">↩ Claim refund ₹${esc(String(rf.amount))}</button>`:(rf.already_refunded?`<button class="btn-line" id="odRefunded" disabled style="opacity:.55">✓ Refund claimed</button>`:'')}</div>`;
    b.innerHTML=h;
    $('#odTrack',b).onclick=()=>liveTrack(o, ()=>orderDetail(o, back));
    const cx=$('#odCancel',b); if(cx) cx.onclick=()=>cancelOrderFlow(o);
    const rfb=$('#odRefund',b); if(rfb) rfb.onclick=()=>claimOrderRefund(o, back);
  }, back);
}

async function cancelOrderFlow(o){
  if(!await ensureAccountSession(o.mobile_no)){ return; }   // cancel mutates → needs that account's live session
  const r=await apiCall('bb_cancel_reasons', {encData:S.encData, order_id:String(o.id||o.order_id)});
  if(!r || !r.decoded.ok){ showToast('Could not load reasons','error'); return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  const reasons=r.decoded.reasons||[];
  openSheet(r.decoded.reason_title||'Cancel order', b=>{
    let sel=null;
    b.innerHTML=`<div id="reasonList">${reasons.map(x=>`<div class="pay-opt reason" data-id="${x.id}">${esc(x.msg)}</div>`).join('')}</div>
      <button class="btn-danger mt12" id="cxGo" disabled style="width:100%;padding:13px">Confirm cancellation</button>`;
    $$('.reason',b).forEach(rn=>rn.onclick=()=>{ $$('.reason',b).forEach(x=>x.style.borderColor='var(--bd)'); rn.style.borderColor='var(--rd)'; sel=rn.dataset.id; $('#cxGo',b).disabled=false; });
    $('#cxGo',b).onclick=async()=>{
      const rr=await apiCall('bb_cancel_order', {encData:S.encData, order_id:String(o.id||o.order_id), reason_id:+(sel||39)});
      if(rr && rr.decoded.ok){ showToast('Order cancelled','success'); closeSheet(); setTimeout(()=>renderOrdersTab($('#tab-orders')),1500); }
      else showToast((rr&&rr.decoded.message)||'Cancel failed','error');
    };
  });
}

/* ════════ optional wallet helper (top bar) ════════ */
async function refreshWallet(){
  if(!S.encData) return;
  const r=await apiCall('bb_wallet_details', {encData:S.encData});
  if(r && r.decoded.ok){ if(r.decoded.encData) S.encData=r.decoded.encData; const bal=r.decoded.wallet?.total_balance; const tb=$('#tb_wallet'); if(bal!=null && tb) tb.textContent=inr(bal); }
}

/* expose for inline onclick handlers */
window.route=route; window.closeSheet=closeSheet;

/* ═══════════════════════════════════════════════════════════════
   PROFILE  +  bbWALLET  +  GAMES & PUZZLES   (append-ready additions)
   Conventions reused verbatim: S, $/$$/el/esc/inr/initials/delay,
   showToast, openSheet/closeSheet, route, apiCall, gameCall (all
   already defined above). gameCall(op,data) posts to GAME_API.
   ═══════════════════════════════════════════════════════════════ */

/* ════════ small helpers shared by the new modules ════════ */
function activeAccount(){ return S.accounts.find(a=>a.mobile_no===S.activePhone) || null; }
function profileName(){ const a=activeAccount(); return (a&&a.name) || (S.loggedIn?'BigBasket user':'Pick an account'); }
function getCookie(name){
  const m=document.cookie.match(new RegExp('(?:^|; )'+name.replace(/[.$?*|{}()\[\]\\\/+^]/g,'\\$&')+'=([^;]*)'));
  return m?decodeURIComponent(m[1]):'';
}
function setCookie(name,val,maxAge){ document.cookie=`${name}=${val};path=/;max-age=${maxAge||86400}`; }
const rand=(min,max)=>Math.floor(Math.random()*(max-min+1))+min;
function shuffle(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }

/* ═══════════════════════════════════════════════════════════════
   1) PROFILE  (rendered by the Accounts tab — see wiring)
   Header (gradient avatar + name/phone + wallet pill) → menu rows →
   existing accounts list (switch / add).
   ═══════════════════════════════════════════════════════════════ */
/* Profile opens as a bottom-sheet from the top bar — for the SELECTED account. */
function openProfileSheet(){
  const name=profileName();
  const acct=(S.accounts||[]).find(a=>a.mobile_no===S.activePhone);   // scripthub → decoded m_id, not the real number
  const phone=acct?acctLabel(acct):(S.activePhone?('+91 '+S.activePhone):'—');
  const hasAcct=!!S.encData;
  openSheet('Profile', b=>{
    b.innerHTML=`
      <div class="prof-head">
        <div class="prof-av">${esc(initials(name))}</div>
        <div class="prof-id">
          <div class="prof-name" id="prof-name">${esc(name)}</div>
          <div class="prof-phone">${esc(phone)}</div>
        </div>
        <div class="prof-wallet" id="profWallet">👛 —</div>
      </div>
      ${hasAcct?'':'<div class="prof-pick">Pick an account to use Wallet & Games →</div>'}
      <div class="prof-menu" id="profMenu">
        ${(S.features && S.features.redeem_gv) ? '<div class="pm-row" data-act="redeem_gv"><span class="pm-ico">🎁</span><span class="pm-lbl">Redeem Gift Voucher</span><span class="pm-chev">›</span></div>' : ''}
        <div class="pm-row" data-act="wallet"><span class="pm-ico">👛</span><span class="pm-lbl">bbWallet</span><span class="pm-sub" id="pmWalletSub"></span><span class="pm-chev">›</span></div>
        ${(S.features && S.features.games) ? '<div class="pm-row" data-act="games"><span class="pm-ico">🎮</span><span class="pm-lbl">Games & Puzzles</span><span class="pm-chev">›</span></div>' : ''}
        <div class="pm-row" data-act="orders"><span class="pm-ico">📦</span><span class="pm-lbl">Your Orders</span><span class="pm-chev">›</span></div>
        <div class="pm-row" data-act="address"><span class="pm-ico">📍</span><span class="pm-lbl">Saved Addresses</span><span class="pm-chev">›</span></div>
        <div class="pm-row" data-act="accounts"><span class="pm-ico">🔁</span><span class="pm-lbl">Switch account</span><span class="pm-chev">›</span></div>
      </div>`;
    $$('#profMenu .pm-row',b).forEach(row=>row.onclick=()=>{
      const act=row.dataset.act;
      if(act==='wallet'){ if(!S.encData){ showToast('Pick an account first'); route('accounts'); closeSheet(); return; } openWalletSheet(); }
      else if(act==='games'){ if(!S.encData){ showToast('Pick an account first'); route('accounts'); closeSheet(); return; } openGamesSheet(); }
      else if(act==='orders'){ if(!S.encData){ showToast('Pick an account first'); route('accounts'); closeSheet(); return; } openOrdersSheet(); }
      else if(act==='address'){ if(!S.encData){ showToast('Pick an account first'); route('accounts'); closeSheet(); return; } closeSheet(); route('address'); }
      else if(act==='redeem_gv'){ if(!S.encData){ showToast('Pick an account first'); route('accounts'); closeSheet(); return; } openRedeemGvSheet(); }
      else if(act==='accounts'){ closeSheet(); route('accounts'); }
    });
    loadProfileWalletBalance();
  });
}

/* Profile → Redeem Gift Voucher: credit a BB gift card (number + PIN) into the account's bbWallet.
   Feature-gated by config features.redeem_gv (row hidden + op refuses when off). No email step. */
async function openRedeemGvSheet(){
  if(!S.encData){ showToast('No active account','error'); return; }
  openSheet('Redeem Gift Voucher', b=>{
    b.innerHTML=`
      <div class="muted" style="font-size:12.5px;line-height:1.4;margin-bottom:12px">Enter a BigBasket gift card / voucher number and its PIN. The amount is credited to this account's bbWallet.</div>
      <div class="field"><label>Gift card number</label><input id="rgvCode" inputmode="numeric" autocomplete="off" placeholder="e.g. 1004300162859411"></div>
      <div class="field"><label>PIN</label><input id="rgvPin" inputmode="numeric" autocomplete="off" placeholder="Gift card PIN"></div>
      <div id="rgvMsg" class="muted" style="min-height:18px;margin:8px 0"></div>
      <button class="btn-primary" id="rgvGo">Redeem to bbWallet</button>`;
    const go=$('#rgvGo',b), msg=$('#rgvMsg',b);
    go.onclick=async()=>{
      const code=($('#rgvCode',b).value||'').replace(/\s+/g,'');
      const pin=($('#rgvPin',b).value||'').replace(/\s+/g,'');
      if(!code||!pin){ msg.style.color='var(--rd,#e5484d)'; msg.textContent='Enter both the number and PIN.'; return; }
      go.disabled=true; const _t=go.textContent; go.textContent='Redeeming...'; msg.style.color=''; msg.textContent='';
      const r=await apiCall('bb_redeem_gv', {encData:S.encData, gift_card_code:code, gift_card_pin:pin});
      go.disabled=false; go.textContent=_t;
      if(!r) return;
      if(r.decoded.encData) S.encData=r.decoded.encData;
      if(r.decoded.ok){
        msg.style.color='var(--gn,#3ba55d)'; msg.textContent=r.decoded.message||'Redeemed to bbWallet';
        $('#rgvCode',b).value=''; $('#rgvPin',b).value='';
        showToast(r.decoded.message||'Redeemed to bbWallet','success');
      } else {
        msg.style.color='var(--rd,#e5484d)'; msg.textContent=r.decoded.message||'Redeem failed';
      }
    };
  }, openProfileSheet);
}


/* Profile → Your Orders: LIVE orders for the SELECTED account (bb_order_list), not the DB cross-account list. */
async function openOrdersSheet(){
  if(!S.encData){ showToast('No active account','error'); return; }
  openSheet('Your Orders', b=>{ b.innerHTML='<div class="center muted mt16">Loading your orders…</div><div class="spin"></div>'; }, openProfileSheet);
  const r=await apiCall('bb_order_list', {encData:S.encData, page:1});
  const body=$('#sheet_body'); if(!body) return;
  if(!r || !r.decoded.ok){ body.innerHTML=`<div class="empty"><div class="e-emoji">😕</div>${esc((r&&r.decoded.message)||'Could not load orders')}</div>`; return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  const groups=r.decoded.orders||[];
  // bb_order_list is PO-grouped: each group has total_order_amount + nested orders[] (sub-orders)
  const cards=[];
  groups.forEach(g=>{ const subs=(g.orders&&g.orders.length)?g.orders:[g]; subs.forEach(s=>cards.push([g,s])); });
  if(!cards.length){ body.innerHTML=`<div class="empty"><div class="e-emoji">📦</div>No orders on this account yet.</div>`; return; }
  body.innerHTML='';
  cards.forEach(([g,s])=>body.appendChild(liveOrderCard(g,s)));
}
function liveOrderCard(g,s){
  g=g||{}; s=s||{};
  const onum  = s.order_number || g.p_order_id || '';
  const oid   = s.id || s.order_id || s.potential_order_id || g.p_order_id || '';
  const status= s.delivery_status_title || s.status || s.order_status || g.status_msg || '';
  const total = g.total_order_amount ?? s.total ?? s.order_total ?? 0;
  const slot  = (s.slot && (s.slot.display_slot || s.slot.slot_display_str)) || '';
  const ship  = s.shipment_name || '';
  const o2={ id:oid, order_id:oid, order_number:onum, mobile_no:S.activePhone, status, total };
  return orderCardEl({
    num:onum, amt:total, status, meta1:ship, meta2:slot,
    onDetail:()=>orderDetail(o2, openOrdersSheet), onTrack:()=>liveTrack(o2, openOrdersSheet)
  });
}

async function loadProfileWalletBalance(){
  if(!S.encData) return;
  const r=await apiCall('bb_wallet_details', {encData:S.encData});
  if(!r || !r.decoded.ok) return;
  if(r.decoded.encData) S.encData=r.decoded.encData;
  const w=r.decoded.wallet||{};
  const bal = w.total_balance ?? w.current_wallet_balance ?? w.balance ?? 0;
  const pill=$('#profWallet'); if(pill) pill.textContent='👛 '+inr(bal);
  const sub=$('#pmWalletSub'); if(sub) sub.textContent=inr(bal);
  const tb=$('#tb_wallet'); if(tb) tb.textContent=inr(bal);
}

/* ═══════════════════════════════════════════════════════════════
   2) bbWALLET SHEET  — balance card + paginated activity logs
   bb_wallet_details {encData} -> {wallet:{total_balance,current_wallet_balance,...}}
   bb_wallet_logs {encData, page} -> {activity_logs:[...], total_page_count, balance}
   ═══════════════════════════════════════════════════════════════ */
const W = { page:1, totalPages:1, loading:false };
function openWalletSheet(){
  if(!S.encData){ showToast('No active account','error'); return; }
  W.page=1; W.totalPages=1; W.loading=false;
  openSheet('bbWallet', b=>{
    b.innerHTML=`
      <div class="wallet-card" id="walletCard">
        <div class="wc-label">bbWallet balance</div>
        <div class="wc-amt" id="wcAmt">—</div>
        <div class="wc-sub" id="wcSub"></div>
      </div>
      <div class="wallet-logs-h">Transaction history</div>
      <div id="walletLogs" class="wallet-logs"><div class="skel" style="height:60px;margin-bottom:8px"></div><div class="skel" style="height:60px"></div></div>
      <button class="btn-line wallet-more" id="walletMore" style="display:none">Load more</button>`;
    $('#walletMore',b).onclick=()=>loadWalletLogs(W.page+1,false);
    loadWalletDetails();
    loadWalletLogs(1,true);
  }, openProfileSheet);
}

async function loadWalletDetails(){
  const r=await apiCall('bb_wallet_details', {encData:S.encData});
  if(!r || !r.decoded.ok) return;
  if(r.decoded.encData) S.encData=r.decoded.encData;
  const w=r.decoded.wallet||{};
  const total = w.total_balance ?? w.current_wallet_balance ?? w.balance ?? 0;
  const cur   = w.current_wallet_balance;
  const fc    = w.total_freecash_amount ?? w.freecash_balance;
  const amt=$('#wcAmt'); if(amt) amt.textContent=inr(total);
  const sub=$('#wcSub');
  if(sub){
    const bits=[];
    if(cur!=null && +cur!==+total) bits.push('Wallet '+inr(cur));
    if(fc!=null && +fc>0) bits.push('FreeCash '+inr(fc));
    sub.textContent=bits.join('  ·  ');
  }
  // keep profile/top-bar pills in sync
  const pill=$('#profWallet'); if(pill) pill.textContent='👛 '+inr(total);
  const tb=$('#tb_wallet'); if(tb) tb.textContent=inr(total);
}

async function loadWalletLogs(page, replace){
  if(W.loading) return; W.loading=true;
  const more=$('#walletMore'); if(more) more.textContent='Loading…';
  try{
    const r=await apiCall('bb_wallet_logs', {encData:S.encData, page});
    const box=$('#walletLogs'); if(!box) return;
    if(!r || !r.decoded.ok){ if(replace) box.innerHTML=`<div class="empty"><div class="e-emoji">😕</div>Could not load activity.</div>`; return; }
    if(r.decoded.encData) S.encData=r.decoded.encData;
    const logs=r.decoded.activity_logs||[];
    W.page=page;
    W.totalPages=r.decoded.total_page_count||1;
    if(replace) box.innerHTML='';
    if(replace && !logs.length){ box.innerHTML=`<div class="empty"><div class="e-emoji">🧾</div>No transactions yet.</div>`; }
    logs.forEach(lg=>box.appendChild(walletLogRow(lg)));
    if(more) more.style.display = (W.page<W.totalPages) ? 'block' : 'none';
    if(more) more.textContent='Load more';
  } finally { W.loading=false; }
}

function walletLogRow(lg){
  // BB activity-logs: activity_type is the authoritative credit/debit flag.
  const credit = String(lg.activity_type ?? lg.type ?? '').toLowerCase() === 'credit';
  const title  = lg.display_reason || lg.reason || lg.title || 'Transaction';
  const desc   = (lg.additional_info && (lg.additional_info.description || lg.additional_info.short_message))
               || (lg.reference_type ? `${lg.reference_type} #${lg.reference_id||''}` : '');
  const amount = Math.abs(+(lg.amount ?? lg.value ?? 0));
  const dt  = lg.created_on || lg.date || '';
  const exp = (lg.show_expiry_upfront && lg.expiry_on) ? lg.expiry_on : '';
  const sign = credit ? '+' : '−';
  const row=el('div','wlog '+(credit?'cr':'dr'));
  row.innerHTML=`
    <div class="wlog-ico">${credit?'⬇️':'⬆️'}</div>
    <div class="wlog-mid">
      <div class="wlog-title">${esc(title)}</div>
      ${desc?`<div class="wlog-desc">${esc(String(desc))}</div>`:''}
      <div class="wlog-meta">${esc(String(dt).slice(0,16))}${exp?` · exp ${esc(String(exp).slice(0,10))}`:''}</div>
    </div>
    <div class="wlog-amt">${sign}${inr(amount)}</div>`;
  return row;
}

/* ═══════════════════════════════════════════════════════════════
   3) GAMES & PUZZLES  — list → cricket auto-play (all via gameCall)
   ═══════════════════════════════════════════════════════════════ */

/* game_list -> render cards */
async function openGamesSheet(){
  openSheet('Games & Puzzles', b=>{
    b.innerHTML=`<div id="gameList"><div class="skel" style="height:78px;margin-bottom:10px"></div><div class="skel" style="height:78px"></div></div>`;
    loadGameList();
  });
}
async function loadGameList(){
  const r=await gameCall('game_list', {encData:S.encData||''});
  const box=$('#gameList'); if(!box) return;
  if(!r || !r.decoded.ok){ box.innerHTML=`<div class="empty"><div class="e-emoji">😕</div>Games unavailable right now.</div>`; return; }
  if(r.decoded.encData) S.encData=r.decoded.encData;
  const games=r.decoded.games||[];
  if(!games.length){ box.innerHTML=`<div class="empty"><div class="e-emoji">🎮</div>No games enabled for your code.</div>`; return; }
  box.innerHTML='';
  games.forEach(g=>{
    const card=el('div','game-card');
    card.innerHTML=`
      <div class="gc-ico">${g.icon?`<img src="${esc(g.icon)}" alt="">`:'🏏'}</div>
      <div class="gc-mid">
        <div class="gc-name">${esc(g.name||'Game')}</div>
        <div class="gc-desc">${esc(g.description||'Tap to play')}</div>
      </div>
      <span class="gc-cta">Play ›</span>`;
    card.onclick=()=>startGameFlow(g);
    box.appendChild(card);
  });
}

/* ── transient game session ── */
const G = {};
function gameBusyView(title, msg){
  openSheet(title, b=>{ b.innerHTML=`<div class="center muted mt16">${esc(msg||'Loading…')}</div><div class="spin"></div>`; });
}

/* orchestration entry — same flow for every game slug */
async function startGameFlow(game){
  G.game=game; G.slug=game.slug; G.name=game.name; G.config=game.config||{};
  gameBusyView(game.name||'Game', 'Connecting to game…');

  // 1) auth code
  const auth=await gameCall('game_auth_code', {encData:S.encData||''});
  if(!auth || !auth.decoded.ok){ gameError(game,'Could not start the game (auth).'); return; }
  if(auth.decoded.encData) S.encData=auth.decoded.encData;
  G.authEnc = auth.decoded.encData;
  const authCode = auth.decoded.auth_code;

  // 2) masterKey cookie
  const ck=`${G.slug}-id`;
  let masterKey=getCookie(ck);
  if(!masterKey){ masterKey=String(Date.now()).slice(0,10); }
  setCookie(ck, masterKey, 86400);
  G.masterKey=masterKey;

  const col=await gameCall('game_collect', {
    encData:G.authEnc, auth_code:authCode, master_key:masterKey, game_slug:G.slug
  });
  if(!col || !col.decoded.ok){ gameError(game,'Game login failed.'); return; }
  if(col.decoded.encData) S.encData=col.decoded.encData;
  Object.assign(G,{
    enc:col.decoded.encData,
    userKey:col.decoded.user_key, dataKey:col.decoded.data_key,
    gameToken:col.decoded.game_token, userName:col.decoded.user_name,
    startedPlaying:col.decoded.started_playing, currentWeek:col.decoded.current_week
  });

  // 3) letsGoClicked
  await gameAction('action', {type:'letsGoClicked', userKey:G.userKey});

  // 4) need a username?
  if(!G.userName){ openUsernameSheet(game); return; }

  await afterAuthFlow(game);
}

/* generic signed action via game_action (keeps encData rolling) */
async function gameAction(endpoint, body){
  const r=await gameCall('game_action', {
    encData:G.enc, game_slug:G.slug, endpoint,
    user_key:G.userKey, game_token:G.gameToken, data_key:G.dataKey, master_key:G.masterKey,
    body
  });
  if(r && r.decoded){ if(r.decoded.encData){ S.encData=r.decoded.encData; G.enc=r.decoded.encData; } }
  return r ? r.decoded : null;
}

/* username sheet (only when collect returned no userName) */
function openUsernameSheet(game){
  openSheet('Choose a username', b=>{
    b.innerHTML=`
      <p class="muted" style="margin-bottom:12px">Pick a name to play ${esc(game.name||'this game')}.</p>
      <div class="field"><label>Username</label><input id="gameUser" placeholder="e.g. RunMachine" autocomplete="off"></div>
      <button class="btn-primary mt12" id="gameUserGo">Continue</button>`;
    $('#gameUser',b).focus();
    $('#gameUserGo',b).onclick=async()=>{
      const userName=$('#gameUser',b).value.trim();
      if(!userName){ showToast('Enter a username'); return; }
      $('#gameUserGo',b).disabled=true;
      const d=await gameAction('profile', {userName, city:'Bengaluru', userKey:G.userKey});
      if(!d || !d.ok){ showToast((d&&d.message)||'Could not save username','error'); $('#gameUserGo',b).disabled=false; return; }
      G.userName=userName;
      // re-enter the flow
      gameBusyView(game.name||'Game','Setting up…');
      await afterAuthFlow(game);
    };
  });
}

/* 5) stats → 6) start-playing chain → 7) chance gate → play screen */
async function afterAuthFlow(game){
  const st=await gameCall('game_stats', {
    encData:G.enc, game_slug:G.slug, user_key:G.userKey, game_token:G.gameToken, master_key:G.masterKey
  });
  if(st && st.decoded){ if(st.decoded.encData){ S.encData=st.decoded.encData; G.enc=st.decoded.encData; } }
  const stats=(st && st.decoded && st.decoded.stats) || {};
  G.stats=stats;

  // 6) first-time then per-session start
  if(!G.startedPlaying){
    await gameAction('action', {type:'startPlayingFirstTimeClicked', userKey:G.userKey});
    G.startedPlaying=true;
  }
  const sp=await gameAction('action', {type:'startPlayingClicked', userKey:G.userKey});
  G.gameKey = (sp && (sp.game_key || (sp.data&&sp.data.gameKey))) || null;

  // 7) config + chance gate
  G.maxBalls = (G.config.max_balls)||12;
  G.maxRuns  = (G.config.max_runs_cap)||(G.maxBalls*6);
  const chances = stats.gamePlayChance;
  const freeChance = stats.hasFreeChance;
  if((chances!=null && chances<=0) && !freeChance){
    gameError(game,'No chances left this week. Come back next week!', true);
    return;
  }
  // 8) play screen
  renderPlayScreen(game, stats);
}

/* 8) user picks wantRuns; 9) start-game; 10) auto innings; 11) submit score */
function renderPlayScreen(game, stats){
  openSheet(game.name||'Play', b=>{
    const wr=stats.weeklyRuns!=null?stats.weeklyRuns:0;
    const chances=stats.gamePlayChance!=null?stats.gamePlayChance:(stats.hasFreeChance?'Free':'—');
    b.innerHTML=`
      <div class="game-stats">
        <div class="gs-cell"><div class="gs-v">${esc(wr)}</div><div class="gs-l">Weekly runs</div></div>
        <div class="gs-cell"><div class="gs-v">${esc(chances)}</div><div class="gs-l">Chances</div></div>
        <div class="gs-cell"><div class="gs-v">${G.maxBalls}</div><div class="gs-l">Balls</div></div>
      </div>
      <div class="play-pick">
        <div class="pp-label">How many runs to chase? <span class="muted">(0–${G.maxRuns})</span></div>
        <div class="pp-want" id="ppWant">0</div>
        <input type="range" id="ppSlider" min="0" max="${G.maxRuns}" value="0" class="pp-slider">
        <input type="number" id="ppInput" min="0" max="${G.maxRuns}" value="0" class="pp-input">
      </div>
      <button class="btn-primary mt16" id="playGo">Play innings 🏏</button>`;
    const slider=$('#ppSlider',b), input=$('#ppInput',b), want=$('#ppWant',b);
    const sync=v=>{ v=Math.max(0,Math.min(G.maxRuns, parseInt(v||0,10)||0)); slider.value=v; input.value=v; want.textContent=v; };
    slider.oninput=()=>sync(slider.value);
    input.oninput=()=>sync(input.value);
    $('#playGo',b).onclick=()=>runInnings(game, parseInt(input.value||0,10)||0);
  });
}

/* distribute wantRuns across MAX_BALLS (old algo), shuffle, animate ball-by-ball */
function distributeRuns(wantRuns, balls){
  const out=[]; let rem=wantRuns;
  for(let i=0;i<balls;i++){
    const left=balls-i;
    const maxB=Math.min(6, rem);
    const minB=Math.max(0, rem-(left-1)*6);
    const r=rand(minB, maxB);
    out.push(r); rem-=r;
  }
  return shuffle(out);
}

async function runInnings(game, wantRuns){
  wantRuns=Math.max(0, Math.min(G.maxRuns, wantRuns));
  // 9) start-game
  const sg=await gameAction('start-game', {gameKey:G.gameKey, userKey:String(G.userKey)});
  if(!sg || !sg.ok){ showToast((sg&&sg.message)||'Could not start innings','error'); return; }

  const balls=distributeRuns(wantRuns, G.maxBalls);
  const startT=Date.now();
  let totalRuns=0, totalFours=0, totalSixes=0;
  const t2=[];

  // play screen → live innings UI
  openSheet(game.name||'Innings', b=>{
    b.innerHTML=`
      <div class="innings">
        <div class="inn-score"><span id="innRuns">0</span><span class="inn-balls" id="innBalls">0/${G.maxBalls}</span></div>
        <div class="inn-flash" id="innFlash">Get ready…</div>
        <div class="inn-dots" id="innDots"></div>
      </div>`;
  });

  for(let i=0;i<balls.length;i++){
    const r=balls[i];
    totalRuns+=r;
    if(r===4) totalFours++;
    if(r===6) totalSixes++;
    const now=Date.now();
    t2.push({gt:now-startT, ct:now, r, s:totalRuns});

    const flash=$('#innFlash');
    if(flash){
      flash.className='inn-flash '+(r===6?'six':r===4?'four':r===0?'dot':'run');
      flash.textContent = r===6?'SIX! 🎉' : r===4?'FOUR! 🔥' : r===0?'Dot ball' : `${r} run${r>1?'s':''}`;
    }
    const rn=$('#innRuns'); if(rn) rn.textContent=totalRuns;
    const bc=$('#innBalls'); if(bc) bc.textContent=`${i+1}/${G.maxBalls}`;
    const dots=$('#innDots'); if(dots){ const d=el('span','inn-dot '+(r===6?'six':r===4?'four':r===0?'dot':''),String(r)); dots.appendChild(d); }

    await delay(rand(2800,4200));
  }

  const gotOut = totalRuns===0;
  const t1=startT;

  // 11) submit score
  gameBusyView(game.name||'Game','Saving your innings…');
  const sc=await gameCall('game_score', {
    encData:G.enc, game_slug:G.slug, user_key:G.userKey, game_token:G.gameToken,
    data_key:G.dataKey, master_key:G.masterKey, game_key:G.gameKey,
    score_data:{ timeTaken:Date.now()-startT, totalBalls:G.maxBalls, totalRuns, totalSixes, totalFours, gotOut, t1, t2 }
  });
  if(sc && sc.decoded){ if(sc.decoded.encData){ S.encData=sc.decoded.encData; G.enc=sc.decoded.encData; } }
  const scoreOk = sc && sc.decoded && sc.decoded.ok;

  // 12) refresh stats and offer replay
  const st=await gameCall('game_stats', {
    encData:G.enc, game_slug:G.slug, user_key:G.userKey, game_token:G.gameToken, master_key:G.masterKey
  });
  if(st && st.decoded){ if(st.decoded.encData){ S.encData=st.decoded.encData; G.enc=st.decoded.encData; } }
  const stats=(st && st.decoded && st.decoded.stats) || G.stats || {};
  G.stats=stats;

  renderInningsResult(game, {totalRuns,totalFours,totalSixes,gotOut, message:(sc&&sc.decoded&&sc.decoded.message)||'', scoreOk}, stats);
}

function renderInningsResult(game, res, stats){
  openSheet('Innings complete', b=>{
    b.innerHTML=`
      <div class="result">
        <div class="r-ico">${res.gotOut?'💥':'🏆'}</div>
        <h3>${res.gotOut?'Bowled out!':inr0(res.totalRuns)+' runs'}</h3>
        <div class="r-num">${esc(res.message||(res.scoreOk?'Score submitted':'Score not saved'))}</div>
        <div class="result-card">
          <div class="bill-row"><span>Total runs</span><span class="v">${res.totalRuns}</span></div>
          <div class="bill-row"><span>Fours</span><span class="v">${res.totalFours}</span></div>
          <div class="bill-row"><span>Sixes</span><span class="v">${res.totalSixes}</span></div>
          ${stats.weeklyRuns!=null?`<div class="bill-row total"><span>Weekly runs</span><span class="v">${esc(stats.weeklyRuns)}</span></div>`:''}
        </div>
        <button class="btn-primary mt16" id="playAgain">Play again</button>
        <button class="btn-ghost" id="playClose">Done</button>
      </div>`;
    $('#playAgain',b).onclick=async()=>{
      const chances=stats.gamePlayChance;
      if((chances!=null && chances<=0) && !stats.hasFreeChance){ gameError(game,'No chances left this week.', true); return; }
      gameBusyView(game.name||'Game','Setting up next innings…');
      await afterAuthFlow(game); // re-fires startPlayingClicked → new gameKey → play screen
    };
    $('#playClose',b).onclick=closeSheet;
  });
}
/* whole-number inr for the big score line */
function inr0(n){ return (Math.round(+n||0)).toLocaleString('en-IN'); }
/* DB timestamps are stored UTC → show them in IST (India time). Parses "YYYY-MM-DD HH:MM:SS" as UTC. */
function istTime(s){
  if(!s) return '';
  const d=new Date(String(s).replace(' ','T')+'Z');
  if(isNaN(d)) return String(s).slice(0,16);
  const p={}; new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d).forEach(x=>p[x.type]=x.value);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function gameError(game, msg, soft){
  openSheet(game.name||'Game', b=>{
    b.innerHTML=`<div class="${soft?'warn-box':'warn-box'}">${esc(msg)}</div>
      <button class="btn-line" id="gErrBack">Back to games</button>`;
    $('#gErrBack',b).onclick=openGamesSheet;
  });
}

/* expose for any inline handlers / debugging */
window.openWalletSheet=openWalletSheet;
window.openGamesSheet=openGamesSheet;
