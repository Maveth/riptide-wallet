'use strict';
let token = '';
let network = null;
let uncertainMutation = sessionRead('paperclip.uncertain') === '1';
let lightningEnabled = false;
let setupPending = false;
let setupDefaultsLoaded = false;
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
async function api(path, body, method, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(abort, body === undefined ? 10000 : (String(path).includes('lightning/pay') ? 180000 : 60000));
  try {
  const response = await fetch(path.startsWith('/') ? path : '/api/v1/' + path, {
    signal: controller.signal, method: method || (body === undefined ? 'GET' : 'POST'), cache: 'no-store', redirect: 'error',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Access denied. Check the login instructions and the credential provided by your wallet app.');
    let message = '';
    try { const detail = await response.json(); message = typeof detail.message === 'string' ? detail.message.slice(0, 900) : ''; } catch {}
    if (message.includes('no pending lightning receive')) message = 'No received payment matches this invoice in this wallet. An invoice from another wallet belongs in Pay someone, not Received status.';
    if (message.toLowerCase().includes('dust') || message.includes('funded-HTLC minimum') || message.includes('No constructible Lightning input')) message = path === 'fees/ark/send' ? 'Ark payment or change is too small after recovery reserves. Check your balance and amount, or refresh eligible inputs. No payment was sent.' : 'Available Ark inputs cannot cover this payment with valid recovery reserves and change. Refresh eligible inputs to consolidate funds, or add Ark funds. Check Sent status before retrying.';
    throw new Error(message || 'Wallet request failed (' + response.status + '). Check wallet access and local services.');
  }
  return response.status === 204 ? null : await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The wallet request timed out. Check connections in Settings.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
let updateInFlight = null;
function txOutputSats(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(raw.buffer);
  let at = 0;
  const need = (n) => { if (at + n > raw.length) throw new Error('short'); };
  const compact = () => {
    need(1);
    const n = raw[at++];
    if (n < 0xfd) return n;
    if (n === 0xfd) { need(2); const v = view.getUint16(at, true); at += 2; return v; }
    if (n === 0xfe) { need(4); const v = view.getUint32(at, true); at += 4; return v; }
    need(8);
    const v = Number(view.getBigUint64(at, true));
    at += 8;
    return v;
  };
  try {
    need(4); at += 4;
    if (raw[at] === 0 && raw[at + 1] === 1) at += 2;
    const inputs = compact();
    for (let i = 0; i < inputs; i++) {
      need(36); at += 36;
      const script = compact();
      need(script + 4); at += script + 4;
    }
    const outputs = compact();
    let total = 0;
    for (let i = 0; i < outputs; i++) {
      need(8);
      const value = Number(view.getBigUint64(at, true));
      at += 8;
      if (!Number.isSafeInteger(value)) return null;
      const script = compact();
      need(script); at += script;
      total += value;
    }
    return Number.isSafeInteger(total) ? total : null;
  } catch { return null; }
}
function renderOverviewPending(chain, txs) {
  const box = $('overview-pending');
  if (!box) return;
  box.replaceChildren();
  const pendingIn = (Number.isSafeInteger(chain?.trusted_pending_sat) ? chain.trusted_pending_sat : 0)
    + (Number.isSafeInteger(chain?.untrusted_pending_sat) ? chain.untrusted_pending_sat : 0);
  const rows = Array.isArray(txs) ? txs.filter(tx => tx && tx.confirmation == null) : [];
  const withdrawal = [...rows].reverse().find(tx => tx.is_cpfp) || null;
  const outputSats = withdrawal ? txOutputSats(withdrawal.tx) : null;
  if (pendingIn <= 0 && outputSats == null) { box.hidden = true; return; }
  box.hidden = false;
  const card = document.createElement('article');
  card.className = 'overview-pending-card';
  const heading = document.createElement('h2');
  heading.textContent = withdrawal ? 'Unconfirmed withdrawal' : 'Unconfirmed on-chain';
  const amount = document.createElement('strong');
  const shown = outputSats != null ? outputSats : pendingIn;
  amount.textContent = shown.toLocaleString() + ' sats';
  const detail = document.createElement('p');
  const id = typeof withdrawal?.txid === 'string' ? withdrawal.txid.slice(0, 16) + '\u2026' : '';
  const older = rows.length - (withdrawal ? 1 : 0);
  const parts = ['Still waiting to be mined.'];
  if (id) parts.push('Newest transaction ' + id);
  if (older > 0) parts.push(older + ' older unconfirmed attempts are still in the wallet.');
  detail.textContent = parts.join(' ');
  card.append(heading, amount, detail);
  box.append(card);
}
let nextAutomaticUpdate = 0;
async function update() {
  if (updateInFlight?.session === token) return updateInFlight.promise;
  const sessionToken = token;
  const promise = updateBalances(sessionToken);
  updateInFlight = {session: sessionToken, promise};
  try { return await promise; }
  finally { if (updateInFlight?.promise === promise) updateInFlight = null; }
}
async function updateBalances(sessionToken) {
  const results = await Promise.allSettled(['wallet/balance', 'onchain/balance', 'wallet/vtxos', 'exits/status/all', 'bitcoin/tip', 'onchain/transactions'].map(path => api(path)));
  if (!token || token !== sessionToken) return;
  const [balance, chain, vtxos, exits, tip, chainTxs] = results.map(result => result.status === 'fulfilled' ? result.value : null);
  $('exits').textContent = JSON.stringify(exits, null, 2);
  $('ark-balance').textContent = Number.isSafeInteger(balance?.spendable_sat) ? balance.spendable_sat.toLocaleString() : 'Unavailable';
  const tab = await api('lightning/tab').catch(() => null);
  if ($('tab-balance')) $('tab-balance').textContent = Number.isSafeInteger(tab?.balance_sat) ? tab.balance_sat.toLocaleString() : '—';
  if ($('ln-tab-balance')) $('ln-tab-balance').textContent = Number.isSafeInteger(tab?.balance_sat) ? tab.balance_sat.toLocaleString() : '—';
  if ($('ln-tab-return')) $('ln-tab-return').disabled = !(Number.isSafeInteger(tab?.balance_sat) && tab.balance_sat >= 1000);
  if ($('ln-tab-opt') && tab) $('ln-tab-opt').checked = tab.opted_out === true;
  const named = await api('lightning/address').catch(() => null);
  syncLightningAddress(named?.address || '');
  syncTabCard();
  $('chain-balance').textContent = Number.isSafeInteger(chain?.confirmed_sat) ? chain.confirmed_sat.toLocaleString() : 'Unavailable';
  renderOverviewPending(chain, chainTxs);
  $('vtxos').textContent = JSON.stringify({balance, onchain: chain, vtxos}, null, 2);
  vtxoSnapshot = {balance: balance || {}, rows: Array.isArray(vtxos) ? vtxos : [], tip: Number.isSafeInteger(tip?.tip_height) ? tip.tip_height : null};
  renderVtxos();
  if (!vtxos || !balance) {
    $('vtxo-list').replaceChildren(); $('vtxo-summary').textContent = 'Recovery balances are unavailable. Check connections and try again.';
  }
  const incomplete = results.some(result => result.status === 'rejected');
  nextAutomaticUpdate = Date.now() + (incomplete ? 120000 : 30000);
  $('wallet-readiness').hidden = !incomplete;
  $('wallet-readiness').textContent = incomplete ? 'Some wallet data is unavailable. Your node may be syncing or busy. Check connections in Settings before sending.' : '';
  return !incomplete;
}
async function run(button, operation) {
  button.disabled = true;
  try { await operation(); } catch (error) { status(error.message); }
  finally { button.disabled = false; }
}
function accessToken(value) {
  // Umbrel supplies a random 32-byte app password, never a wallet seed.
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return btoa(String.fromCharCode(0, ...value.match(/../g).map(hex => parseInt(hex, 16))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return value;
}
async function connectWallet() {
    const session = token;
    const info = await api('wallet/identity');
    if (!session || token !== session) return;
    if (!['bitcoin', 'regtest'].includes(info.network) || info.exit_profile !== 2) throw new Error('Unsupported network or ASP recovery profile.');
    network = info.network;
    lightningEnabled = info.lightning_enabled === true;
    $('ln-controls').disabled = !lightningEnabled;
    $('ln-capability').textContent = lightningEnabled ? 'Experimental XBT Lightning enabled. Channel and Ark pool liquidity are required. Recovery reserves are included in your payment cost.' : 'This ASP has not enabled funded Lightning. Payment controls are unavailable.';
    $('network').textContent = network === 'bitcoin' ? 'XBT MAINNET \u00b7 EXPERIMENTAL' : 'XBT REGTEST';
    $('setup').hidden = true; $('login').hidden = true; $('wallet').hidden = false;
    $('ark-balance').textContent = 'Loading\u2026'; $('chain-balance').textContent = 'Loading\u2026';
    $('submission-warning').hidden = !uncertainMutation;
    if ($('remember-session').checked) sessionWrite('paperclip.session', token);
    status('Signed in. Loading balances\u2026');
    void update().then(complete => { if (token === session) status(complete ? 'Wallet updated.' : 'Signed in. Some wallet data is unavailable.'); }).catch(() => { if (token === session) status('Signed in. Check connections in Settings.'); });
}
$('unlock').addEventListener('submit', event => { event.preventDefault(); run(event.submitter, async () => {
  token = accessToken($('token').value.trim()); $('token').value = '';
  try {
    const existing = await api('wallet');
    if (existing.fingerprint !== null && typeof existing.fingerprint !== 'string') throw new Error('Unrecognized wallet status.');
    setupPending = false;
    if (existing.fingerprint === null) {
      $('login').hidden = true; $('setup').hidden = false;
      if (!setupDefaultsLoaded) {
        const defaults = await api('/api/config').catch(() => null);
        if (typeof defaults?.arkServer === 'string') {
          try {
            const url = new URL(defaults.arkServer);
            if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
              $('setup-asp').value = defaults.arkServer;
            }
          } catch {}
        }
        setupDefaultsLoaded = true;
      }
      const installed = await api('wallet/platform-node').catch(() => ({available: false}));
      $('setup-installed').disabled = !installed.available;
      $('setup-backend').value = installed.available ? 'installed' : 'manual';
      setupBackend();
      status('Choose your XBT backend and ASP to create a wallet.');
      return;
    }
    await connectWallet();
  } catch (error) { token = ''; throw error; }
}); });
function endpoint(id, protocols) {
  const value = $(id).value.trim();
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('Use an HTTP(S) endpoint without embedded credentials, query, or fragment.');
  }
  return value;
}
function setupBackend() {
  const manual = $('setup-backend').value === 'manual';
  $('setup-network').disabled = !manual;
  if (!manual) $('setup-network').value = 'mainnet';
  $('show-rpc-password').hidden = !manual;
  for (const id of ['setup-rpc', 'setup-user', 'setup-password']) {
    $(id).disabled = !manual;
    $(id).closest('label').hidden = !manual;
  }
}
$('setup-backend').onchange = setupBackend;
$('create-wallet').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
  if (!token || setupPending) throw new Error('Lock and unlock to check whether the previous setup completed before retrying.');
  const selected = $('setup-network').value;
  if (!['mainnet', 'regtest'].includes(selected) || !$('setup-ack').checked) throw new Error('Choose the network and confirm the backup requirement.');
  const body = {
    network: selected, ark_server: endpoint('setup-asp', ['http:', 'https:']),
    chain_source: $('setup-backend').value === 'installed' ? 'platform' : {bitcoind: {
      bitcoind: endpoint('setup-rpc', ['http:', 'https:']),
      bitcoind_auth: {'user-pass': {user: $('setup-user').value, pass: $('setup-password').value}}
    }}, force: false
  };
  if (body.chain_source !== 'platform' && (!body.chain_source.bitcoind.bitcoind_auth['user-pass'].user || !body.chain_source.bitcoind.bitcoind_auth['user-pass'].pass)) throw new Error('RPC credentials are required.');
  if (!await PaperclipReview.ask('Create a new wallet on XBT ' + selected + '? For an existing wallet, cancel and restore its complete backup instead.')) return;
  setupPending = true;
  $('setup-password').value = '';
  await api('wallet/create', body);
  setupPending = false;
  await connectWallet();
}); };
$('setup-lock').onclick = () => {
  token = ''; $('setup-password').value = ''; $('setup').hidden = true; $('login').hidden = false;
  status('Setup locked. Unlock to check wallet state.');
};
$('lock').onclick = () => { token = ''; network = null; $('network').textContent = 'NETWORK UNVERIFIED'; $('deposit-address').textContent = ''; $('exits').textContent = '';  $('wallet').hidden = true; $('login').hidden = false; $('vtxos').textContent = ''; $('address').textContent = ''; $('destination').value = ''; status('Wallet locked.'); };
$('reload').onclick = event => run(event.target, async () => { await update(); status('Balances updated.'); });
$('receive').onclick = event => run(event.target, async () => { const receiveSession = token; const result = await api('wallet/addresses/next', {}); if (!token || token !== receiveSession || $('wallet').hidden) return; $('address').textContent = result.address; PaperclipReceive.show('address', result.address, 'Receive on Ark'); status('New Ark receive address.'); });
$('send').addEventListener('submit', event => { event.preventDefault(); run(event.submitter, async () => {
  const destination = $('destination').value.trim(), amount = Number($('amount').value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Enter a positive whole number of sats.');
  if (!network) throw new Error('Unlock and verify the wallet network first.');
  if (uncertainMutation) throw new Error('Check the previous submission in Activity before another payment.');
  const sessionToken = token;
  $('ark-estimate').hidden = true;
  status('Estimating the recipient amount and recovery reserve. No payment has been sent.');
  const quote = await api('fees/ark/send', {destination, amount_sat: amount});
  if (token !== sessionToken || !network || $('destination').value.trim() !== destination || Number($('amount').value) !== amount) {
    throw new Error('Wallet or payment details changed. Review the transfer again.');
  }
  const fields = ['recipient_amount_sat', 'recovery_reserve_sat', 'service_fee_sat', 'total_debit_sat', 'remaining_spendable_sat', 'input_count'];
  if (fields.some(key => !Number.isSafeInteger(quote[key]) || quote[key] < 0) || quote.input_count < 1 ||
      quote.recipient_amount_sat !== amount || quote.total_debit_sat !== amount + quote.recovery_reserve_sat + quote.service_fee_sat) {
    throw new Error('Invalid cost estimate. No payment was sent.');
  }
  const review = 'Recipient receives: ' + amount.toLocaleString() + ' sats\n' +
    'Recovery reserve: ' + quote.recovery_reserve_sat.toLocaleString() + ' sats\n' +
    'Service fee: ' + quote.service_fee_sat.toLocaleString() + ' sats\n' +
    'Total balance reduction: ' + quote.total_debit_sat.toLocaleString() + ' sats\n' +
    'Estimated remaining balance: ' + quote.remaining_spendable_sat.toLocaleString() + ' sats';
  $('ark-estimate-values').textContent = review;
  $('ark-estimate').hidden = false;
  if (!await PaperclipReview.ask(review + '\n\nRecovery allocations are not separately refundable. They are not miner fees unless recovery transactions confirm. Refresh does not refund prior allocations.\n\nSend to:\n' + destination + '?')) {
    status('Estimate ready. No payment was sent.'); return;
  }
  if (token !== sessionToken || !network || $('destination').value.trim() !== destination || Number($('amount').value) !== amount) throw new Error('Payment details changed. Review again.');
  status('Submitting once. If the connection fails, check history before trying again.');
  await mutate('wallet/send', {destination, amount_sat: amount, max_total_sat: quote.total_debit_sat});
  $('destination').value = ''; $('amount').value = ''; $('ark-estimate').hidden = true;
  transactionResult('success', 'Transaction succeeded', 'Your Ark transfer completed.');
  void update().catch(() => {});
}); });
for (const id of ['destination', 'amount']) $(id).addEventListener('input', () => { $('ark-estimate').hidden = true; });
$('refresh').onclick = event => run(event.target, async () => {
  if (!await PaperclipReview.ask('Refresh every spendable coin now?\n\nThis is not a check of which ones are due. Every spendable coin joins the next round and gets a new expiry. Fees apply. Locked or exiting coins are left out.')) return;
  await mutate('wallet/refresh/all', {}); await update(); status('Refresh requested. Wait for confirmation and update to check completion.');
});

// Do not automatically retry an operation after an ambiguous transport failure.
async function mutate(path, body) {
  if (!token || !network) throw new Error('Unlock and verify the wallet network first.');
  if (uncertainMutation) throw new Error('A prior submission needs checking. Review Activity and payment status, then acknowledge the result before retrying.');
  uncertainMutation = true; sessionWrite('paperclip.uncertain', '1');
  $('submission-warning').hidden = false;
  const session = token;
  let result;
  try { result = await api(path, body); }
  catch (error) {
    if (token === session && token) transactionResult('unknown', 'Result not confirmed', 'The wallet could not confirm the result. Check Activity and payment status before trying again.');
    throw error;
  }
  if (token !== session || !token) throw new Error('Wallet locked while submitting. Check Activity after signing in again.');
  uncertainMutation = false; sessionWrite('paperclip.uncertain', null);
  $('submission-warning').hidden = true;
  return result;
}

function transactionResult(kind, title, detail, reference = '') {
  if (!token || $('wallet').hidden) return;
  $('transaction-result').dataset.kind = kind;
  $('transaction-result-title').textContent = title;
  $('transaction-result-detail').textContent = detail;
  $('transaction-result-reference').textContent = reference;
  $('transaction-result-reference').hidden = !reference;
  $('transaction-result').showModal();
  $('transaction-result-done').focus();
}
$('transaction-result-done').onclick = () => $('transaction-result').close();
$('transaction-result-activity').onclick = () => {
  $('transaction-result').close(); showView('activity'); $('history-load').click();
};

function sats(id, optional = false) {
  const value = $(id).value.trim();
  if (optional && value === '') return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error('Enter a positive whole number of sats.');
  }
  return Number(value);
}
$('chain-send').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
  const destination = $('chain-destination').value.trim(), amount = sats('chain-amount');
  if (!destination) throw new Error('Enter an XBT address.');
  if (!await PaperclipReview.ask('Send ' + amount.toLocaleString() + ' sats on ' + network + ' to:\n' + destination + '\n\nMiner fees are additional.')) return;
  const result = await mutate('onchain/send', {destination, amount_sat: amount});
  $('chain-result').textContent = result.txid;
  $('chain-destination').value = ''; $('chain-amount').value = '';
  transactionResult('pending', 'Transaction submitted', 'Waiting for confirmation on the XBT network. Do not send it again.', result.txid);
  status('Transaction submitted. Wait for confirmation; do not send again.');
}); };

function resetReviewChoices() {
  const topup = $('review-topup'), tab = $('review-tab'), confirm = $('review-confirm');
  if (topup) topup.hidden = true;
  if (tab) tab.hidden = true;
  if (confirm) { confirm.hidden = false; confirm.textContent = 'Confirm'; confirm.value = 'confirm'; }
}
async function reviewConfirm(title, body) {
  const dialog = $('review-dialog');
  resetReviewChoices();
  if (!dialog || typeof dialog.showModal !== 'function') return window.confirm(title + '\n\n' + body);
  $('review-title').textContent = title;
  $('review-body').textContent = body;
  dialog.returnValue = '';
  dialog.showModal();
  return await new Promise(resolve => {
    const onClose = () => { dialog.removeEventListener('close', onClose); resetReviewChoices(); resolve(dialog.returnValue === 'confirm'); };
    dialog.addEventListener('close', onClose);
  });
}
async function reviewPay(title, body, choices) {
  const dialog = $('review-dialog');
  resetReviewChoices();
  if (!dialog || typeof dialog.showModal !== 'function') {
    if (choices.tab && !choices.coin) return window.confirm(title + '\n\n' + body) ? 'tab' : null;
    if (choices.coin && window.confirm(title + '\n\n' + body + '\n\nOK pays from your Ark coin. Cancel to stop.')) return 'coin';
    return null;
  }
  $('review-title').textContent = title;
  $('review-body').textContent = body;
  const only = choices.tab && !choices.coin ? 'tab' : (choices.coin && !choices.tab ? 'coin' : null);
  $('review-confirm').hidden = only === null && !choices.coin;
  $('review-confirm').textContent = only ? 'Pay' : 'Pay from my coin';
  $('review-confirm').value = only || 'coin';
  $('review-tab').hidden = only !== null || !choices.tab;
  $('review-topup').hidden = !choices.topup;
  dialog.returnValue = '';
  dialog.showModal();
  return await new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resetReviewChoices();
      const value = dialog.returnValue;
      resolve(value === 'coin' || value === 'tab' || value === 'topup' ? value : null);
    };
    dialog.addEventListener('close', onClose);
  });
}
async function topUpOnce() {
  const result = await mutate('lightning/tab/fund', {});
  if ($('ln-tab-balance') && Number.isSafeInteger(result.balance_sat)) $('ln-tab-balance').textContent = result.balance_sat.toLocaleString();
  await update();
  status('Topped up 1,000 sats once. No invoice was paid. Balance: ' + (Number.isSafeInteger(result.balance_sat) ? result.balance_sat.toLocaleString() : 'updated') + ' sats.');
}
$('ln-pay').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
  if (!lightningEnabled) throw new Error('Lightning is not enabled in this wallet recovery profile.');
  const destination = $('ln-destination').value.trim(), amount = sats('ln-amount', true);
  const paymentSession = token;
  if (!destination) throw new Error('Enter an XBT Lightning request.');
  let fromTab = false;
  let quote = null;
  let costs = 'Paste an invoice to price the route. If no route cost is found, the schedule fee applies. A payment that cannot be routed is not sent.';
  const params = new URLSearchParams();
  if (amount !== null) params.set('amount_sat', String(amount));
  if (destination) params.set('invoice', destination);
  if ([...params.keys()].length) {
    quote = await api('fees/lightning/pay?' + params.toString());
    if (![quote.gross_amount_sat, quote.fee_sat, quote.net_amount_sat].every(Number.isSafeInteger) || quote.fee_sat < 0 || quote.gross_amount_sat !== quote.net_amount_sat + quote.fee_sat) throw new Error('Invalid Lightning estimate. No payment was sent.');
    if (amount !== null && quote.net_amount_sat !== amount) throw new Error('Invalid Lightning estimate. No payment was sent.');
    if (quote.tab_required === true || quote.from_tab === true) {
      fromTab = true;
      costs = quote.route_priced === false
        ? 'The route fee is not known yet. The tab will hold ' + quote.fee_sat.toLocaleString() + ' sats, on top of the ' + quote.net_amount_sat.toLocaleString() + ' sat invoice.\nAfter the payment, the tab keeps the route cost plus 1 sat and puts the rest back.\nA unilateral exit forfeits whatever is still on the tab.'
        : 'This invoice is under 1,000 sats, so it is paid from the tab.\nInvoice ' + quote.net_amount_sat.toLocaleString() + ' sats plus ' + quote.fee_sat.toLocaleString() + ' sats from the tab.\nArk pays it. No new coin is created. A unilateral exit forfeits the leftover tab.';
    } else {
      costs = 'Estimated total from your coin: ' + quote.gross_amount_sat.toLocaleString() + ' sats\nIncludes ' + quote.fee_sat.toLocaleString() + ' sats.\nA found route is charged as that route plus 1 sat. Otherwise this is the schedule fee. The payment is not sent when it cannot be routed.';
    }
  }
  if (!token || token !== paymentSession || $('wallet').hidden || destination !== $('ln-destination').value.trim() || amount !== sats('ln-amount', true)) throw new Error('Payment details changed. Review them again. No payment was sent.');
  const tabNow = await api('lightning/tab').catch(() => null);
  const tabBalance = Number.isSafeInteger(tabNow?.balance_sat) ? tabNow.balance_sat : 0;
  let tabAffordable = false;
  if (!fromTab) {
    try {
      const tabParams = new URLSearchParams(params);
      tabParams.set('source', 'tab');
      const tabQuote = await api('fees/lightning/pay?' + tabParams.toString());
      tabAffordable = tabQuote.from_tab === true && tabBalance >= tabQuote.gross_amount_sat && tabQuote.gross_amount_sat === tabQuote.net_amount_sat + tabQuote.fee_sat;
      if (tabAffordable) costs += '\n\nThe tab can also pay this: ' + tabQuote.gross_amount_sat.toLocaleString() + ' sats, with no new coin.';
    } catch { tabAffordable = false; }
  } else {
    tabAffordable = tabBalance >= quote.gross_amount_sat;
    if (!tabAffordable) costs += '\n\nThe tab has ' + tabBalance.toLocaleString() + ' sats. Top up 1,000 once, then review this payment again.';
  }
  const picked = await reviewPay('Lightning payment', 'Pay ' + (amount === null ? 'the invoice amount' : amount.toLocaleString() + ' sats') + ' on ' + network + '?\n' + destination + '\n\n' + costs, {
    coin: !fromTab, tab: tabAffordable, topup: false
  });
  if (picked !== 'coin' && picked !== 'tab') return;
  fromTab = picked === 'tab';
  status('Sending the payment.');
  const result = await mutate('lightning/pay', {destination, amount_sat: amount, comment: null, source: picked});
  $('ln-result').textContent = JSON.stringify(result, null, 2);
  paymentSummary('Submitted', 'Payment submitted once. Check Sent status before trying again.');
  if (result.payment_hash) { $('ln-identifier').value = result.payment_hash; $('ln-direction').value = 'sends'; }
  $('ln-destination').value = ''; $('ln-amount').value = '';
  status(fromTab ? 'Tab payment submitted through Ark. Check its status before another payment.' : 'Payment submitted. Check its status before making another payment.');
  await update();
}); };
$('ln-tab-return').onclick = event => run(event.target, async () => {
  if (!lightningEnabled) throw new Error('Lightning is not enabled in this wallet recovery profile.');
  if (!await reviewConfirm('Withdraw all to coin', 'Ask the server to pay the whole tab back into coins?\n\nIt is all or nothing, and there is no fee. Under 1,000 sats, top up once, then withdraw all. You can top up 1,000 again afterwards.')) return;
  const result = await mutate('lightning/tab/return', {});
  if ($('ln-tab-balance') && Number.isSafeInteger(result.balance_sat)) $('ln-tab-balance').textContent = result.balance_sat.toLocaleString();
  await update();
  status('Moved ' + (Number.isSafeInteger(result.amount_sat) ? result.amount_sat.toLocaleString() : 'the tab') + ' sats from the tab into a coin.');
});
$('ln-tab-fund').onclick = event => run(event.target, async () => {
  if (!lightningEnabled) throw new Error('Lightning is not enabled in this wallet recovery profile.');
  if (!await reviewConfirm('Top up 1,000 once', 'Send 1,000 sats from an existing Ark coin into the tab?\n\nThis happens once. It does not repeat, and it does not pay an invoice.\nYour change stays your coin. A unilateral exit forfeits whatever is left.')) return;
  await topUpOnce();
});
function syncLightningAddress(address) {
  const card = $('ln-address-card');
  const pick = $('ln-address-pick');
  const shown = $('ln-address');
  if (!card) return;
  const has = !!address;
  card.classList.toggle('has-name', has);
  if (pick) pick.hidden = has;
  if (shown) { shown.hidden = !has; shown.textContent = has ? address : ''; }
}
function syncTabCard() {
  const card = $('ln-tab-card');
  if (!card || !$('ln-tab-opt')) return;
  card.classList.toggle('opted-out', $('ln-tab-opt').checked === true);
}
if ($('ln-address-claim')) $('ln-address-claim').onclick = () => { run($('ln-address-claim'), async () => {
  const name = ($('ln-address-name').value || '').trim().toLowerCase();
  if (!name) throw new Error('Type a name first.');
  if (!await reviewConfirm('Claim Lightning address', 'Claim ' + name + '@ark-riptide.maveth.ca?\n\nThe first person to claim a name keeps it. Payments under 1,000 sats credit the tab even if this wallet is closed. 1,000 sats or more become a coin, so this wallet has to be open.')) return;
  const result = await mutate('lightning/address', { name });
  syncLightningAddress(result.address || (name + '@ark-riptide.maveth.ca'));
  status('Lightning address: ' + (result.address || name));
}); };
$('ln-tab-opt').onchange = event => run(event.target, async () => {
  const optedOut = event.target.checked === true;
  syncTabCard();
  if (optedOut && !await reviewConfirm('Opt out of small payments', 'Turn off payments under 1,000 sats?\n\nYou will not be able to send or receive them. A balance already on the tab stays there until you turn this back on or exit.')) {
    event.target.checked = false;
    syncTabCard();
    return;
  }
  const result = await mutate('lightning/tab/opt', { opted_out: optedOut });
  event.target.checked = result.opted_out === true;
  syncTabCard();
  status(result.opted_out ? 'Small payments are off.' : 'Small payments use the tab.');
});
$('ln-receive').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
  if (!lightningEnabled) throw new Error('Lightning is not enabled in this wallet recovery profile.');
  const receiveSession = token;
  const amount = sats('ln-receive-amount');
  if ($('ln-tab-opt') && $('ln-tab-opt').checked && amount < 1000) {
    throw new Error('Small payments are off. Turn the tab back on to receive under 1,000 sats.');
  }
  const result = await mutate('lightning/receives/invoice', {
    amount_sat: amount, description: $('ln-description').value.trim() || null, token: null
  });
  if (!token || token !== receiveSession || $('wallet').hidden) return;
  $('ln-invoice').textContent = result.invoice; $('ln-copy').hidden = true;
  PaperclipReceive.show('ln-invoice', result.invoice, amount < 1000 ? 'Receive into the tab' : 'Receive Lightning into Ark');
  paymentSummary('Awaiting payment', amount < 1000
    ? 'This amount is under 1,000 sats, so a payment credits the tab in full. No Ark coin is created.'
    : 'Share this invoice. Keep the wallet online until settlement completes.');
  $('ln-identifier').value = result.invoice; $('ln-direction').value = 'receives';
  status(amount < 1000
    ? 'Invoice created. A payment credits the tab. No coin is created.'
    : 'Invoice created. A payment is not settled until the wallet reports completion.');
  await update();
}); };
$('ln-check').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
  const identifier = $('ln-identifier').value.trim(), direction = $('ln-direction').value;
  if (!identifier || !['sends', 'receives'].includes(direction)) throw new Error('Choose a payment and direction.');
  const checkedSession = token;
  const result = await api('lightning/' + direction + '/' + encodeURIComponent(identifier));
  if (!token || token !== checkedSession || $('wallet').hidden || identifier !== $('ln-identifier').value.trim() || direction !== $('ln-direction').value) return;
  $('ln-result').textContent = JSON.stringify(result, null, 2);
  const state = typeof result.state === 'string' ? result.state : 'See details';
  const descriptions = {paid: 'Payment completed.', settled: 'Payment received.', 'start': 'Preparing payment.', 'htlc-received': 'Preparing the Lightning payment.', 'payment-initiated': 'Payment is in progress. Do not send it again.', 'revocable-htlcs': 'Payment did not complete. Recovering the reserved funds.', 'revocation-stuck': 'Payment recovery needs attention. Check recovery status before retrying.', 'awaiting-reimbursement': 'Waiting for the payment refund.', 'awaiting-payment': 'Waiting for someone to pay this invoice.', 'htlcs-ready': 'Receiving payment.', 'preimage-revealed': 'Finishing payment settlement.', delivering: 'Delivering the received funds.', pending: 'Payment is still in progress. Do not send it again.', succeeded: 'Your wallet reports this payment completed.', completed: 'Your wallet reports this payment completed.', failed: 'Payment failed. Check any refund or recovery status before retrying.', expired: 'The invoice expired. Check activity for a payment or refund before creating another.', unknown: 'The payment outcome is not confirmed. Check activity and the recipient before retrying.'};
  paymentSummary(state, descriptions[state] || 'Status from your wallet. Check the technical details before retrying; an unfamiliar status does not mean payment failed.');
  if (['paid', 'settled', 'succeeded', 'completed'].includes(state)) transactionResult('success', 'Transaction succeeded', 'Your wallet confirms this Lightning payment completed.', result.payment_hash || '');
  else if (state === 'failed') transactionResult('failed', 'Transaction failed', 'Your wallet reports a failed payment. Check refund or recovery status before trying again.', result.payment_hash || '');
  else transactionResult(state === 'unknown' ? 'unknown' : 'pending', state === 'unknown' ? 'Result not confirmed' : 'Payment not complete', descriptions[state] || 'Check payment status again before trying another payment.');
  status('Payment status updated.');
}); };
$('history-load').onclick = event => run(event.target, async () => {
  const session = token;
  const results = await Promise.allSettled([
    api('history'), api('onchain/transactions'), api('lightning/receives'), api('lightning/tab/activity')
  ]);
  if (!token || token !== session || $('wallet').hidden) return;
  const [ark, onchain, receives, tab] = results.map(result => result.status === 'fulfilled' ? result.value : null);
  $('history').textContent = JSON.stringify({ark, onchain, lightning_receives: receives, lightning_tab: tab}, null, 2);
  if (ark || tab) renderActivity(ark, tab);
  else { $('activity-list').replaceChildren(); $('activity-summary').textContent = 'Activity is unavailable. Check connections and try again.'; }
  status(results.some(result => result.status === 'rejected') ? 'Some activity is unavailable. This does not mean a payment failed.' : 'Activity updated.');
});
const lockSession = $('lock').onclick;
$('lock').onclick = () => {
  lockSession();
  $('transaction-result').close();
  $('transaction-result-reference').textContent = ''; $('transaction-result-detail').textContent = '';
  $('wallet-readiness').hidden = true;
  $('ark-estimate').hidden = true; $('ark-estimate-values').textContent = '';
  lightningEnabled = false; $('ln-controls').disabled = true;
  for (const id of ['ln-offer-output', 'ln-invoice', 'ln-result', 'chain-result', 'history', 'ark-balance', 'chain-balance']) $(id).textContent = '';
  if ($('overview-pending')) { $('overview-pending').hidden = true; $('overview-pending').replaceChildren(); }
  for (const id of ['offer-amount', 'ln-destination', 'ln-amount', 'ln-receive-amount', 'ln-description', 'ln-identifier', 'chain-destination', 'chain-amount']) $(id).value = '';
  if ($('offer-description')) $('offer-description').value = 'Ark Riptide Wallet';
};
$('deposit').onclick = event => run(event.target, async () => {
  const receiveSession = token;
  const result = await api('onchain/addresses/next', {});
  if (!token || token !== receiveSession || $('wallet').hidden) return;
  $('deposit-address').textContent = result.address;
  PaperclipReceive.show('deposit-address', result.address, 'Receive on-chain XBT');
  status('Deposit address for ' + (network === 'bitcoin' ? 'XBT mainnet' : 'regtest') + '.');
});
$('board').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
  const amount = Number($('board-amount').value);
  if (!Number.isSafeInteger(amount) || amount < 20000) throw new Error('Enter at least 20,000 whole sats.');
  if (!await PaperclipReview.ask('Board ' + amount.toLocaleString() + ' sats on ' + network + '? Recovery reserves and miner fees apply.')) return;
  await mutate('boards/board-amount', {amount_sat: amount}); await update();
  status('Board submitted. Wait for confirmations; do not submit again.');
}); };
$('withdraw').onclick = event => run(event.target, async () => {
  if (!await PaperclipReview.ask('Withdraw all Ark funds to your on-chain wallet? Fees apply.')) return;
  await mutate('wallet/offboard/all', {}); await update(); status('Withdrawal submitted.');
});
$('exit-start').onclick = event => run(event.target, async () => {
  if (!await PaperclipReview.ask('Start emergency recovery of all Ark funds? This requires on-chain fees and a timelock. Continue only after backing up your complete wallet.')) return;
  await mutate('exits/start/all', {}); await update(); status('Exit started. Progress recovery until funds are claimable.');
});
$('exit-progress').onclick = event => run(event.target, async () => {
  await mutate('exits/progress', {wait: false}); await update(); status('Recovery progress updated.');
});
$('exit-claim').onclick = event => run(event.target, async () => {
  if (!await PaperclipReview.ask('Claim all matured exits to your on-chain wallet? Miner fees apply.')) return;
  const address = await api('onchain/addresses/next', {});
  await mutate('exits/claim/all', {destination: address.address}); await update(); status('Claim submitted. Wait for confirmation.');
});

function paymentSummary(title, detail) {
  const box = $('payment-summary'); box.hidden = false;
  box.textContent = title.replaceAll('_', ' ') + ' \u2014 ' + detail;
}
$('ln-copy').onclick = event => run(event.target, async () => {
  await navigator.clipboard.writeText($('ln-invoice').textContent); status('Invoice copied.');
});
function renderActivity(records, tabRows) {
  const list = $('activity-list'); list.replaceChildren();
  const movements = Array.isArray(records) ? records : [];
  const seen = new Set();
  for (const row of movements) {
    const hash = row.metadata && row.metadata.payment_hash;
    if (typeof hash === 'string') seen.add(hash);
  }
  const tab = (Array.isArray(tabRows) ? tabRows : []).filter(entry => {
    if (!entry || seen.has(entry.payment_hash)) return false;
    return entry.direction === 'received' || entry.direction === 'sent';
  }).map(entry => ({
    subsystem: {name: 'bark.lightning_tab', kind: entry.direction},
    effective_balance_sat: entry.amount_sat,
    offchain_fee_sat: entry.fee_sat,
    status: 'successful',
    time: {created_at: entry.at},
    input_vtxos: [],
    metadata: {payment_hash: entry.payment_hash},
  }));
  const rows = movements.concat(tab).sort((a, b) => {
    const left = Date.parse(b.time && b.time.created_at);
    const right = Date.parse(a.time && a.time.created_at);
    return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
  });
  const pending = rows.filter(r => r.status === 'pending').length;
  $('activity-summary').textContent = rows.length + ' movements \u00b7 ' + pending + ' pending';
  if (!rows.length) { list.textContent = 'No Ark activity yet. Deposits and payments will appear here.'; return; }
  for (const row of rows) {
    const card = document.createElement('article'); card.className = 'activity-row';
    const amount = Number.isSafeInteger(row.effective_balance_sat) ? row.effective_balance_sat : null;
    const tabSend = row.subsystem?.name === 'bark.lightning_send' && !(row.input_vtxos || []).length;
    const heading = document.createElement('strong');
    const label = row.subsystem?.name === 'bark.lightning_tab'
      ? 'Lightning tab \u00b7 ' + (row.subsystem.kind === 'sent' ? 'sent' : 'received')
      : tabSend
        ? 'Lightning tab \u00b7 sent'
        : (({'bark.arkoor':'Ark transfer','bark.lightning_send':'Lightning','bark.lightning_receive':'Lightning','bark.board':'Board','bark.round':'Round'}[row.subsystem?.name] || row.subsystem?.name || 'Ark') + ' \u00b7 ' + (row.subsystem?.kind || 'Movement'));
    heading.textContent = label;
    const value = document.createElement('span'); value.className = amount > 0 ? 'positive' : 'amount';
    value.textContent = amount === null ? 'Amount unavailable' : (amount > 0 ? '+' : '') + amount.toLocaleString() + ' sats';
    const detail = document.createElement('p');
    const date = new Date(row.time?.created_at);
    detail.textContent = (row.status || 'Unknown') + ' \u00b7 ' + (Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Time unavailable') + ' \u00b7 Fee: ' + (Number.isSafeInteger(row.offchain_fee_sat) ? row.offchain_fee_sat.toLocaleString() + ' sats' : 'unavailable');
    const badge = document.createElement('span'); badge.className = 'activity-state';
    badge.textContent = ({successful: 'Completed', pending: 'Pending', failed: 'Failed'}[row.status] || row.status || 'Status unavailable');
    const more = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'Payment details';
    const explanation = document.createElement('p');
    explanation.textContent = row.status === 'pending' ? 'Still in progress. Check the result before attempting another payment.' : row.status === 'failed' ? 'This operation failed. Check any related refund or recovery before retrying.' : 'Balance change includes the effect recorded by your wallet. Fee information is shown above.';
    const record = document.createElement('pre'); record.textContent = JSON.stringify(row, null, 2);
    const resultButton = document.createElement('button'); resultButton.className = 'secondary'; resultButton.textContent = 'View result';
    resultButton.onclick = () => transactionResult(row.status === 'successful' ? 'success' : row.status === 'failed' ? 'failed' : 'pending', row.status === 'successful' ? 'Transaction succeeded' : row.status === 'failed' ? 'Transaction failed' : 'Transaction pending', explanation.textContent);
    more.append(summary, explanation, record); card.append(resultButton);
    card.append(heading, value, badge, detail, more); list.append(card);
  }
}
const reviewLock = $('lock').onclick;
$('lock').onclick = () => { reviewLock(); PaperclipReceive.clear(); $('activity-list').replaceChildren(); $('activity-summary').textContent = ''; $('payment-summary').textContent = ''; $('payment-summary').hidden = true; $('ln-copy').hidden = true; };

// A session belongs to one browser tab. Never save keys or RPC credentials here.
function sessionRead(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function sessionWrite(key, value) { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch {} }
function passwordToggle(buttonId, inputId) {
  $(buttonId).onclick = () => { const shown = $(inputId).type === 'password'; $(inputId).type = shown ? 'text' : 'password'; $(buttonId).setAttribute('aria-pressed', String(shown)); $(buttonId).textContent = buttonId === 'show-token' ? (shown ? 'Hide' : 'Show') : (shown ? 'Hide password' : 'Show password'); };
}
passwordToggle('show-token', 'token'); passwordToggle('show-rpc-password', 'setup-password');
$('remember-session').onchange = () => { if (!$('remember-session').checked) sessionWrite('paperclip.session', null); };
const sessionLock = $('lock').onclick;
$('lock').onclick = () => { sessionWrite('paperclip.session', null); sessionLock(); $('token').type = 'password'; $('show-token').textContent = 'Show'; $('show-token').setAttribute('aria-pressed', 'false'); };
const sessionSetupLock = $('setup-lock').onclick;
$('setup-lock').onclick = () => { sessionWrite('paperclip.session', null); sessionSetupLock(); };
$('submission-reviewed').onclick = async () => {
  if (!await PaperclipReview.ask('Have you checked Activity and the payment status? Continue only after resolving the previous submission. A pending payment must not be sent again.')) return;
  uncertainMutation = false; sessionWrite('paperclip.uncertain', null); $('submission-warning').hidden = true;
  status('Previous result acknowledged. No payment has been resubmitted.');
};
let refreshing = false;
setInterval(async () => {
  if (!token || !network || $('wallet').hidden || document.hidden || refreshing || Date.now() < nextAutomaticUpdate) return;
  refreshing = true;
  try { const complete = await update(); if (token && !$('wallet').hidden) $('refresh-state').textContent = complete ? 'Updated ' + new Date().toLocaleTimeString() : 'Some data unavailable'; }
  catch { $('refresh-state').textContent = 'Update unavailable \u00b7 retry with Update'; }
  finally { refreshing = false; }
}, 30000);
(async () => {
  const saved = sessionRead('paperclip.session'); if (!saved) return;
  token = saved; $('remember-session').checked = true;
  status('Restoring this tab\u2019s wallet session\u2026');
  try { await connectWallet(); }
  catch { token = ''; network = null; sessionWrite('paperclip.session', null); status('Unlock again to reconnect. Your wallet data is unchanged.'); }
})();

let vtxoSnapshot = {balance: {}, rows: [], tip: null};
let vtxoRenderKey = '';
function vtxoNode(tag, text, className) {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
}
function renderVtxos() {
  const {balance, rows, tip} = vtxoSnapshot;
  const nextKey = JSON.stringify([vtxoSnapshot, $('vtxo-filter').value]);
  if (nextKey === vtxoRenderKey) return;
  vtxoRenderKey = nextKey;
  const openIds = new Set(Array.from($('vtxo-list').querySelectorAll?.('details[open]') || [], d => d.dataset.vtxoId));
  const summary = $('vtxo-summary'); summary.replaceChildren();
  const count = rows.length;
  const locked = rows.filter(r => r.state?.type === 'locked').reduce((sum,r) => sum + (Number.isSafeInteger(r.amount_sat) ? r.amount_sat : 0),0);
  for (const [label,value] of [['Spendable',balance.spendable_sat],['Needs refresh',balance.needs_refresh_sat],['Locked',locked]]) {
    const card = vtxoNode('article','');
    card.append(vtxoNode('span',label),vtxoNode('strong',Number.isSafeInteger(value) ? value.toLocaleString()+' sats' : 'Unavailable')); summary.append(card);
  }
  $('vtxo-tip').textContent = tip === null ? 'Chain height unavailable. Expiry blocks are shown without a countdown.' : 'Chain height '+tip.toLocaleString()+' \u00b7 '+count+' current VTXOs. Expiry is measured in blocks, not a guaranteed time.';
  const list = $('vtxo-list'); list.replaceChildren();
  const filter = $('vtxo-filter').value || 'all';
  const shown = rows.filter(r => filter === 'all' || r.state?.type === filter).sort((a,b) => (a.expiry_height ?? Infinity)-(b.expiry_height ?? Infinity));
  if (!shown.length) { list.append(vtxoNode('p',count ? 'No VTXOs match this filter.' : 'No current VTXOs. Board funds or receive an Ark payment to get started.','empty-state')); return; }
  for (const row of shown) {
    const remaining = tip !== null && Number.isSafeInteger(row.expiry_height) ? row.expiry_height-tip : null;
    const card = vtxoNode('article','','vtxo-card'+(remaining !== null && remaining <=144 ? ' attention' : ''));
    const top = vtxoNode('div','','vtxo-card-top');
    top.append(vtxoNode('strong',Number.isSafeInteger(row.amount_sat) ? row.amount_sat.toLocaleString()+' sats' : 'Amount unavailable'),vtxoNode('span',row.state?.type || 'Unknown','state-pill'));
    const expiry = remaining === null ? 'Countdown unavailable' : remaining <=0 ? 'Expiry reached: review recovery immediately' : remaining.toLocaleString()+' blocks until expiry';
    card.append(top,vtxoNode('p',expiry,'expiry-label'),vtxoNode('p','Expires at block '+(Number.isSafeInteger(row.expiry_height)?row.expiry_height.toLocaleString():'unknown'),'hint'));
    if (remaining !== null && remaining >0 && remaining <=144) card.append(vtxoNode('p','Expiry is approaching. Check refresh and recovery status.','hint'));
    const details = vtxoNode('details',''); details.dataset.vtxoId = String(row.id); details.open = openIds.has(String(row.id)); details.append(vtxoNode('summary','VTXO details'),vtxoNode('pre',JSON.stringify({id:row.id,policy:row.policy_type,exit_delay_blocks:row.exit_delta,exit_depth:row.exit_depth,chain_anchor:row.chain_anchor,state:row.state},null,2)));
    card.append(details);list.append(card);
  }
}
$('vtxo-filter').onchange = renderVtxos;
$('vtxo-update').onclick = event => run(event.target,async()=>{await update();status('VTXOs updated.');});
const vtxoLock = $('lock').onclick;
$('lock').onclick = () => { vtxoLock();vtxoRenderKey='';vtxoSnapshot={balance:{},rows:[],tip:null};$('vtxo-list').replaceChildren();$('vtxo-summary').replaceChildren();$('vtxo-tip').textContent=''; };

function showOffer(offer) {
  $('offer-state').textContent = offer?.active ? 'Enabled while wallet service is online' : 'Disabled';
  $('offer-disable').hidden = !offer?.active;
  $('ln-offer-output').textContent = offer?.offer || 'No reusable offer yet.';
  if (offer?.active) PaperclipReceive.show('ln-offer-output', offer.offer, 'Reusable XBT Lightning offer');
}

let messageProof = null;
function clearMessageProof() {
  messageProof = null; $('message-proof').hidden = true;
  $('message-signature').textContent = ''; $('message-verification').textContent = '';
}
function messageInput() {
  return {address: $('message-address').value.trim(), message: $('message-text').value};
}
$('message-address').oninput = clearMessageProof;
$('message-text').oninput = clearMessageProof;
$('message-verify-signature').oninput = () => { $('message-verification').textContent = ''; };
$('onchain-message').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
  clearMessageProof();
  const input = messageInput(), session = token;
  if (!await PaperclipReview.ask('Sign this exact message for ' + input.address + '?\n\n' + input.message + '\n\nThis proves address ownership. No funds will move.')) return;
  const proof = await api('onchain/message/sign', input);
  if (!token || token !== session || JSON.stringify(input) !== JSON.stringify(messageInput())) return;
  if (proof.scheme !== 'bip322-simple' || proof.message !== input.message || proof.address?.toLowerCase() !== input.address.toLowerCase() || typeof proof.signature !== 'string' || !proof.signature.startsWith('smp')) throw new Error('Unexpected message proof response.');
  messageProof = proof;
  $('message-signature').textContent = proof.signature; $('message-proof').hidden = false;
  status('Message signed. Share the exact message, address, and signature with the verifier.');
}); };
$('message-copy').onclick = event => run(event.target, async () => {
  if (!messageProof || !token) throw new Error('Sign a message first.');
  await PaperclipReceive.copy(messageProof.signature);
  status('Signature copied.');
});
$('message-verify').onclick = event => run(event.target, async () => {
  const input = {...messageInput(), signature: $('message-verify-signature').value.trim()}, session = token;
  $('message-verification').textContent = '';
  const result = await api('onchain/message/verify', input);
  if (!token || token !== session || input.address !== messageInput().address || input.message !== messageInput().message || input.signature !== $('message-verify-signature').value.trim()) return;
  $('message-verification').textContent = result.valid ? 'Valid: this signature proves control of the address for the exact message.' : 'Invalid: the address, message, and signature do not match.';
});
const messageLock = $('lock').onclick;
$('lock').onclick = () => {
  messageLock(); clearMessageProof();
  $('message-address').value = ''; $('message-text').value = ''; $('message-verify-signature').value = '';
};
$('ln-offer').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
  if (!lightningEnabled) throw new Error('Lightning is not enabled in this wallet recovery profile.');
  const session = token;
  const offer = await mutate('lightning/offers', {description: $('offer-description').value.trim(), amount_sat: sats('offer-amount', true)});
  if (!token || token !== session || $('wallet').hidden) return;
  showOffer(offer); status('Reusable offer saved. Keep the wallet service online to receive.');
}); };
$('offer-load').onclick = event => run(event.target, async () => {
  const session = token, offer = await api('lightning/offers');
  if (!token || token !== session || $('wallet').hidden) return;
  showOffer(offer);
});
$('offer-disable').onclick = event => run(event.target, async () => {
  if (!await PaperclipReview.ask('Disable this offer for new requests? Payments already in progress will remain tracked.')) return;
  const session = token;
  await api('lightning/offers', undefined, 'DELETE');
  if (!token || token !== session || $('wallet').hidden) return;
  PaperclipReceive.clear(); showOffer(null); status('Offer disabled. Existing payments remain tracked.');
});
