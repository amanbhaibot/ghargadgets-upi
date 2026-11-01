// GharGadgets UPI bridge: Shopify manual-payment orders -> PayZapi (FamPay UPI) -> mark order paid.
import express from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

const {
  PORT = 3000,
  SHOP = 'ghargadgets-in.myshopify.com',
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_ADMIN_TOKEN,           // optional: static Admin API token instead of client credentials
  PAYZAPI_API_KEY,
  PAYZAPI_WEBHOOK_SECRET,
  PAYZAPI_PROVIDER = 'fampay',
  PUBLIC_URL,                    // e.g. https://ghargadgets-upi.onrender.com
  EXPIRY_MINUTES = '20',
  GMAIL_USER,                    // sender for pay-link emails
  GMAIL_APP_PASSWORD,
  POLL_SECONDS = '60',
} = process.env;

const API_VERSION = '2025-10';
const PZ = 'https://payzapi.in/api/v1';
const app = express();

// ---------- Shopify Admin API ----------
let cachedToken = null, tokenExpiry = 0;
async function shopifyToken() {
  if (SHOPIFY_ADMIN_TOKEN) return SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error('Shopify token error: ' + JSON.stringify(j));
  cachedToken = j.access_token;
  tokenExpiry = Date.now() + ((j.expires_in || 3600) - 300) * 1000;
  return cachedToken;
}

async function gql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await shopifyToken() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error('Shopify GraphQL: ' + JSON.stringify(j.errors));
  return j.data;
}

async function getOrder(id) {
  const d = await gql(`query($id: ID!) { order(id: $id) {
      id name email displayFinancialStatus cancelledAt statusPageUrl tags
      totalOutstandingSet { shopMoney { amount currencyCode } }
      } }`, { id: `gid://shopify/Order/${id}` });
  return d.order;
}

async function markPaid(orderId, pz) {
  const order = await getOrder(orderId);
  if (!order) throw new Error('order not found');
  if (['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.displayFinancialStatus)) return { already: true };
  const due = Number(order.totalOutstandingSet.shopMoney.amount);
  if (Number(pz.amount) + 0.001 < due) throw new Error(`amount mismatch: paid ${pz.amount}, due ${due}`);
  const r = await gql(`mutation($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) {
      order { id displayFinancialStatus } userErrors { field message } } }`, { input: { id: order.id } });
  const errs = r.orderMarkAsPaid.userErrors;
  if (errs.length) throw new Error('markAsPaid: ' + JSON.stringify(errs));
  await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
    { id: order.id, tags: ['PayZapi-Paid', `UTR-${pz.utr || 'na'}`] }).catch(() => {});
  console.log(`[paid] ${order.name} via PayZapi ${pz.order_id} UTR ${pz.utr}`);
  return { ok: true };
}

// ---------- PayZapi ----------
const isPaid = (st) => !!st && st.ok !== false && (
  ['paid', 'completed', 'success'].includes(String(st.status || st.data?.status).toLowerCase()) ||
  ['VERIFIED', 'SUCCESS', 'PAID'].includes(String(st.verification_status || '').toUpperCase()));
async function pzCreate(body) {
  const res = await fetch(`${PZ}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': PAYZAPI_API_KEY },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.order_id || !(j.payment_url || j.qr_image_url)) throw new Error('PayZapi create: ' + JSON.stringify(j));
  return j;
}
async function pzCheck(pzOrderId) {
  const res = await fetch(`${PZ}/check?order_id=${encodeURIComponent(pzOrderId)}`, { headers: { 'X-API-Key': PAYZAPI_API_KEY } });
  return res.json();
}

const page = (title, msg) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font-family:system-ui;max-width:480px;margin:40px auto;padding:0 16px;text-align:center">
<h2>${title}</h2><p>${msg}</p></body>`;

// Customer pay link (from order confirmation email): /pay/<orderId>?n=<order_number>
app.get('/pay/:orderId', async (req, res) => {
  try {
    const order = await getOrder(req.params.orderId);
    if (!order || (req.query.n && !order.name.replace('#', '').endsWith(String(req.query.n))))
      return res.status(404).send(page('Order not found', 'Please check the link in your email.'));
    if (order.cancelledAt) return res.send(page('Order cancelled', 'This order was cancelled.'));
    if (order.displayFinancialStatus === 'PAID') return res.redirect(order.statusPageUrl);
    const amount = Number(order.totalOutstandingSet.shopMoney.amount);
    const id = req.params.orderId;
    const pz = await pzCreate({
      amount,
      payment_provider: PAYZAPI_PROVIDER,
      client_order_id: `SHOP-${id}-${Date.now()}`,
      customer_name: 'GharGadgets customer',
      customer_email: order.email || undefined,
      description: `GharGadgets order ${order.name}`,
      redirect_url: `${PUBLIC_URL}/return/${id}/__PZ__`,
      expiry_minutes: Number(EXPIRY_MINUTES),
    });
    // keep the mapping on the Shopify order so the webhook can find it
    await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: order.id, tags: [`pz-${pz.order_id}`] });
    // always use our own unbranded page
    let upi = pz.upi_link || '';
    if (!upi) try { upi = new URL(pz.qr_image_url).searchParams.get('text') || ''; } catch {}
    if (!upi) upi = `upi://pay?pa=${encodeURIComponent(pz.receiving_upi)}&pn=GharGadgets&am=${Number(pz.payable_amount || amount).toFixed(2)}&cu=INR&tn=${pz.order_id}&tr=${pz.utr || ''}`;
    upi = upi.replace(/pn=Merchant/, 'pn=GharGadgets');
    const qr = `https://quickchart.io/qr?size=300&text=${encodeURIComponent(upi)}`;
    res.send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Pay ₹${pz.payable_amount || amount}</title>
<body style="font-family:system-ui;max-width:420px;margin:30px auto;padding:0 16px;text-align:center">
<h2>Pay ₹${pz.payable_amount || amount}</h2><p>GharGadgets order ${order.name}</p>
<a href="${upi}" style="display:block;background:#1a73e8;color:#fff;padding:16px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:18px">Pay with UPI app</a>
<p style="color:#555">GPay, PhonePe, Paytm. Pay the exact amount shown.</p><p>or scan this QR from another phone</p><img src="${qr}" width=240 height=240 alt="UPI QR">
<p id=s style="color:#777">Waiting for payment…</p>
<script>setInterval(async()=>{try{const r=await fetch('/status/${pz.order_id}');const j=await r.json();if(j.paid){document.getElementById('s').textContent='Paid! Confirming your order…';location.href='/return/${id}/${pz.order_id}'}}catch(e){}},5000)</script></body>`);
  } catch (e) {
    console.error('[pay]', e.message);
    res.status(500).send(page('Payment link error', 'Something went wrong. Please try again in a minute or contact us on Instagram @ghargadgets_in.'));
  }
});

app.get('/status/:pzId', async (req, res) => {
  try { res.json({ paid: isPaid(await pzCheck(req.params.pzId)) }); } catch { res.json({ paid: false }); }
});

// After paying, PayZapi redirects here; double-check and send customer to their Shopify order page.
app.get('/return/:orderId/:pzId', async (req, res) => {
  const { orderId } = req.params;
  try {
    const order = await getOrder(orderId);
    let pzId = req.params.pzId;
    if (pzId === '__PZ__') pzId = (order.tags || []).filter(t => t.startsWith('pz-')).pop()?.slice(3);
    if (pzId) {
      const st = await pzCheck(pzId);
      if (isPaid(st)) await markPaid(orderId, st);
    }
    res.redirect(order.statusPageUrl);
  } catch (e) {
    console.error('[return]', e.message);
    res.send(page('Thanks!', 'We are confirming your payment. You will get an email once it is verified.'));
  }
});

async function findOrderByPz(pzId) {
  const d = await gql(`query($q: String!) { orders(first: 1, query: $q) { nodes { id } } }`, { q: `tag:'pz-${pzId}'` });
  return d.orders.nodes[0]?.id?.split('/').pop();
}

// PayZapi webhook (HMAC-SHA256 of raw body)
app.post('/webhooks/payzapi', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = req.get('X-PayZapi-Signature') || req.get('X-FamGateway-Signature') || req.get('X-FamPay-Signature') || '';
  const expected = crypto.createHmac('sha256', PAYZAPI_WEBHOOK_SECRET || '').update(req.body).digest('hex');
  const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!PAYZAPI_WEBHOOK_SECRET || !ok) return res.status(401).send('bad signature');
  let p; try { p = JSON.parse(req.body.toString()); } catch { return res.status(400).send('bad json'); }
  res.status(200).send('OK');
  const pzId = p.order_id || p.data?.order_id;
  const ev = String(p.event || ''), status = String(p.status || p.data?.status || '').toLowerCase();
  if (!pzId || !(['order.paid', 'payment.completed'].includes(ev) || ['paid', 'completed'].includes(status))) return;
  try {
    const st = await pzCheck(pzId);            // never trust the webhook alone
    if (!isPaid(st)) return console.warn('[webhook] not paid on check', pzId, st.status);
    st.order_id = st.order_id || pzId;
    const orderId = await findOrderByPz(pzId);
    if (!orderId) return console.warn('[webhook] no Shopify order for', pzId);
    await markPaid(orderId, st);
  } catch (e) { console.error('[webhook]', e.message); }
});


// ---------- Find order by number (for the thank-you page instructions) ----------
const form = (err = '') => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Pay for your order</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h2>Pay for your GharGadgets order</h2>${err ? `<p style="color:#c00">${err}</p>` : ''}
<form method=post action="/pay"><p>Order number<br><input name=n required placeholder="1001" style="width:100%;padding:10px;font-size:16px"></p>
<p>Email used at checkout<br><input name=e type=email required style="width:100%;padding:10px;font-size:16px"></p>
<button style="width:100%;padding:14px;background:#1a73e8;color:#fff;border:0;border-radius:6px;font-size:16px">Pay now via UPI</button></form></body>`;
app.get('/pay', (_, res) => res.send(form()));
app.post('/pay', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const n = String(req.body.n || '').replace(/[^0-9A-Za-z-]/g, ''), e = String(req.body.e || '').trim().toLowerCase();
    const d = await gql(`query($q: String!) { orders(first: 5, query: $q) { nodes { id name email } } }`, { q: `name:${n}` });
    const o = d.orders.nodes.find(x => x.name.replace('#', '') === n && (x.email || '').toLowerCase() === e);
    if (!o) return res.send(form('No order found with that number and email.'));
    res.redirect(`/pay/${o.id.split('/').pop()}?n=${n}`);
  } catch (err) { console.error('[pay-form]', err.message); res.send(form('Something went wrong, please try again.')); }
});

// ---------- Poller: email pay links for new UPI orders + confirm payments (webhook fallback) ----------
const mailer = GMAIL_USER && GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } }) : null;

async function sendPayEmail(o) {
  const id = o.id.split('/').pop(), n = o.name.replace('#', '');
  const link = `${PUBLIC_URL}/pay/${id}?n=${n}`;
  const amt = o.totalOutstandingSet.shopMoney.amount;
  await mailer.sendMail({
    from: `"GharGadgets" <${GMAIL_USER}>`, to: o.email,
    subject: `Pay ₹${amt} for your GharGadgets order ${o.name}`,
    html: `<div style="font-family:system-ui;max-width:480px;margin:auto;text-align:center">
<h2>Thanks for your order ${o.name}!</h2><p>Complete your UPI payment of <b>₹${amt}</b> to confirm it. Paid orders ship early, with priority.</p>
<p><a href="${link}" style="background:#1a73e8;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Pay now via UPI</a></p>
<p style="color:#777;font-size:13px">GPay, PhonePe or Paytm. Your order confirms automatically.</p></div>`,
  });
}

async function poll() {
  try {
    const since = new Date(Date.now() - 3 * 864e5).toISOString();
    const d = await gql(`query($q: String!) { orders(first: 25, sortKey: CREATED_AT, reverse: true, query: $q) {
      nodes { id name email tags paymentGatewayNames totalOutstandingSet { shopMoney { amount } } } } }`,
      { q: `financial_status:pending created_at:>'${since}'` });
    for (const o of d.orders.nodes) {
      const id = o.id.split('/').pop();
      const isUpi = (o.paymentGatewayNames || []).some(g => /upi/i.test(g));
      if (!isUpi) continue;
      // 1) confirm any payment started through PayZapi
      for (const t of o.tags.filter(t => t.startsWith('pz-'))) {
        const st = await pzCheck(t.slice(3)).catch(() => null);
        if (isPaid(st)) { st.order_id = st.order_id || t.slice(3); await markPaid(id, st).catch(e => console.error('[poll pay]', e.message)); break; }
      }
      // 2) email the pay link once
      if (mailer && o.email && !o.tags.includes('upi-link-sent')) {
        try { await sendPayEmail(o); } catch (e) { console.error('[email]', e.message); continue; }
        await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: o.id, tags: ['upi-link-sent'] });
        console.log('[email] pay link sent for', o.name);
      }
    }
  } catch (e) { console.error('[poll]', e.message); }
}
setInterval(poll, Number(POLL_SECONDS) * 1000); setTimeout(poll, 5000);

app.get('/', (_, res) => res.send('GharGadgets UPI bridge OK'));
app.get('/health', async (_, res) => {
  const out = { mailer: !!mailer, shop: SHOP, payzapiKey: !!PAYZAPI_API_KEY, webhookSecret: !!PAYZAPI_WEBHOOK_SECRET, publicUrl: PUBLIC_URL };
  try { await gql('{ shop { name } }'); out.shopify = 'ok'; } catch (e) { out.shopify = e.message.slice(0, 200); }
  res.json(out);
});

app.listen(PORT, () => console.log('listening on', PORT));
