// A memory-only bridge to the existing SnowOS staff login. Tokens never appear
// in URLs, DOM, console output, localStorage or sessionStorage.
(function () {
  const ORIGIN = 'https://helm-snowos.vercel.app';
  let accessToken = '', expiresAt = 0, expiryTimer = null, epoch = 0;
  const listeners = new Set();
  function banner(message) {
    let node = document.getElementById('staff-session-status');
    if (!node) {
      node = document.createElement('div'); node.id = 'staff-session-status';
      node.setAttribute('role', 'status');
      Object.assign(node.style, { background:'#fff7ed', border:'1px solid #fed7aa', borderRadius:'8px', padding:'12px', margin:'16px', fontFamily:'system-ui', fontSize:'14px' });
      document.body.prepend(node);
    }
    node.replaceChildren(document.createTextNode(`${message} `));
    const link = document.createElement('a'); link.href = `${ORIGIN}/rentals`; link.target = '_top'; link.textContent = 'Open SnowOS staff sign-in'; node.appendChild(link);
    node.hidden = false;
  }
  function clear(message = 'Sign in to SnowOS to view customer details.') {
    epoch++; accessToken = ''; expiresAt = 0; clearTimeout(expiryTimer);
    for(const waiter of listeners){clearTimeout(waiter.timeout);waiter.reject(new Error('The staff session ended. Start this action again after signing in.'));}listeners.clear();
    banner(message);
    window.dispatchEvent(new Event('staff-session-ended'));
  }
  function requestSession() {
    if (window.parent !== window) window.parent.postMessage({ type:'snowos-rentals-ready' }, ORIGIN);
  }
  window.addEventListener('message', event => {
    if (event.origin !== ORIGIN || event.source !== window.parent || window.parent === window) return;
    const data = event.data;
    if (data?.type === 'snowos-rentals-host-ready') { requestSession(); return; }
    if (data?.type === 'snowos-rentals-session-ended') { clear('Your staff session ended. Sign in again.'); return; }
    if (data?.type !== 'snowos-rentals-session') return;
    if (typeof data.accessToken !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.accessToken) || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() + 1000) { clear(); return; }
    if(accessToken && accessToken !== data.accessToken)clear('Staff session changed.');
    accessToken = data.accessToken; expiresAt = data.expiresAt;
    clearTimeout(expiryTimer); expiryTimer = setTimeout(() => { clear('Your staff session expired. Sign in again.'); requestSession(); }, Math.max(0, expiresAt - Date.now()));
    const node = document.getElementById('staff-session-status'); if (node) node.hidden = true;
    for (const waiter of listeners){clearTimeout(waiter.timeout);waiter.resolve();}listeners.clear();
    window.dispatchEvent(new Event('staff-session-ready'));
  });
  function ready() {
    if (accessToken && expiresAt > Date.now()) return Promise.resolve();
    if (window.parent === window) { banner('Customer details require your existing staff sign-in.'); return Promise.reject(new Error('Open Rentals from SnowOS to continue.')); }
    requestSession();
    return new Promise((resolve, reject) => {
      const waiter={resolve,reject,timeout:null};
      waiter.timeout=setTimeout(()=>{listeners.delete(waiter);banner('Waiting for your SnowOS staff session. Try refreshing the staff page.');reject(new Error('Staff sign-in is required.'));},12000);
      listeners.add(waiter);
    });
  }

  async function staffFetch(input, options = {}) {
    const started=epoch; await ready();
    if(started!==epoch)throw new Error('The staff session changed. Start this action again.');
    const url = new URL(input, window.location.href);
    if (url.origin !== window.location.origin) throw new Error('Staff requests must stay inside the rental app.');
    const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${accessToken}`);
    const response = await fetch(url.toString(), { ...options, headers, cache:'no-store', credentials:'same-origin', referrerPolicy:'no-referrer' });
    if(started!==epoch)throw new Error('The staff session changed. Discarding this response.');
    for(const method of ['json','text','blob','arrayBuffer','formData']){
      if(typeof response[method] !== 'function')continue;
      const read=response[method].bind(response);
      response[method]=async(...args)=>{const value=await read(...args);if(started!==epoch)throw new Error('The staff session changed. Discarding this response.');return value;};
    }
    if (response.status === 401 || response.status === 403) { clear('Your SnowOS staff session needs to be refreshed.'); requestSession(); }
    return response;
  }
  window.StaffSession = Object.freeze({ ready, fetch:staffFetch, isReady:() => Boolean(accessToken && expiresAt > Date.now()) });
  window.addEventListener('pagehide', () => clear('Staff session paused.'));
  window.addEventListener('pageshow', requestSession);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', requestSession); else requestSession();
})();
