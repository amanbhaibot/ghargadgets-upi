// GharGadgets UPI bridge: Shopify manual-payment orders -> PayZapi (FamPay UPI) -> mark order paid.
import express from 'express';
import crypto from 'node:crypto';

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
      customer { firstName lastName } } }`, { id: `gid://shopify/Order/${id}` });
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
  if (!j.order_id || !j.payment_url) throw new Error('PayZapi create: ' + JSON.stringify(j));
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
      customer_name: [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || 'Customer',
      customer_email: order.email || undefined,
      description: `GharGadgets order ${order.name}`,
      redirect_url: `${PUBLIC_URL}/return/${id}/__PZ__`,
      expiry_minutes: Number(EXPIRY_MINUTES),
    });
    // keep the mapping on the Shopify order so the webhook can find it
    await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: order.id, tags: [`pz-${pz.order_id}`] });
    res.redirect(pz.payment_url);
  } catch (e) {
    console.error('[pay]', e.message);
    res.status(500).send(page('Payment link error', 'Something went wrong. Please try again in a minute or contact us on Instagram @ghargadgets_in.'));
  }
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

app.get('/', (_, res) => res.send('GharGadgets UPI bridge OK'));
app.get('/health', async (_, res) => {
  const out = { shop: SHOP, payzapiKey: !!PAYZAPI_API_KEY, webhookSecret: !!PAYZAPI_WEBHOOK_SECRET, publicUrl: PUBLIC_URL };
  try { await gql('{ shop { name } }'); out.shopify = 'ok'; } catch (e) { out.shopify = e.message.slice(0, 200); }
  res.json(out);
});

app.listen(PORT, () => console.log('listening on', PORT));
