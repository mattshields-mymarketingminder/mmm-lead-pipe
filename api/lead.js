// api/lead.js — My Marketing Minder lead pipeline
// Receives lead data from the instant quote widget and the website forms.
// Fires TWO notification emails: one when contact details are captured,
// one when a quote is actually completed.

const BREVO_API = 'https://api.brevo.com/v3';

const {
  BREVO_API_KEY,
  BREVO_LIST_ID = '7',
  NOTIFY_EMAIL = 'contact@mymarketingminder.com',
  CRM_LEAD_URL,
  ALLOWED_ORIGIN = 'https://mymarketingminder.com'
} = process.env;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Brevo: add or update the contact ----------
async function upsertContact(d) {
  if (!BREVO_API_KEY) return;

  const base = {
    FIRSTNAME: d.firstName || '',
    LASTNAME: d.lastName || '',
    SMS: d.phone || ''
  };

  const extra = {
    ...base,
    BUSINESS: d.business || '',
    WEBSITE: d.website || '',
    QUOTE_STAGE: d.stage || '',
    QUOTE_SERVICES: d.services || '',
    QUOTE_TOTAL: d.quoted_total || ''
  };

  const send = (attributes) => fetch(`${BREVO_API}/contacts`, {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: d.email,
      attributes,
      listIds: [Number(BREVO_LIST_ID)],
      updateEnabled: true
    })
  });

  // Try with the custom attributes; if Brevo rejects them (attribute not
  // created in your account yet), fall back to the standard ones only.
  const r = await send(extra);
  if (!r.ok) await send(base);
}

// ---------- Brevo: send the notification email to you ----------
async function notify(d) {
  if (!BREVO_API_KEY) return;

  const completed = d.stage === 'quote_completed';
  const name = [d.firstName, d.lastName].filter(Boolean).join(' ') || 'Unknown';

  const subject = completed
    ? `QUOTE REQUESTED: ${name}${d.quoted_total ? ` — £${d.quoted_total}/mo` : ''}`
    : `New lead (details only): ${name}`;

  const contactRows = `
    <tr><td><b>Name</b></td><td>${esc(name)}</td></tr>
    <tr><td><b>Email</b></td><td><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></td></tr>
    <tr><td><b>Phone</b></td><td>${esc(d.phone) || '—'}</td></tr>
    <tr><td><b>Business</b></td><td>${esc(d.business) || '—'}</td></tr>
    <tr><td><b>Website</b></td><td>${esc(d.website) || '—'}</td></tr>
    <tr><td><b>Source</b></td><td>${esc(d.source) || '—'}</td></tr>`;

  const quoteRows = completed ? `
    <tr><td colspan="2" style="padding-top:14px"><b>THEIR QUOTE</b></td></tr>
    <tr><td><b>Services</b></td><td>${esc(d.services) || '—'}</td></tr>
    <tr><td><b>Subtotal</b></td><td>£${esc(d.subtotal) || '—'}/mo</td></tr>
    <tr><td><b>Discount</b></td><td>${esc(d.discount_pct) || '0'}%</td></tr>
    <tr><td><b>Total quoted</b></td><td style="font-size:18px"><b>£${esc(d.quoted_total) || '—'}/mo</b></td></tr>
    <tr><td valign="top"><b>Breakdown</b></td><td><pre style="margin:0;font:inherit;white-space:pre-wrap">${esc(d.quote_breakdown)}</pre></td></tr>` : `
    <tr><td colspan="2" style="padding-top:14px;color:#777">
      They entered their details but have not completed a quote yet.
    </td></tr>`;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#2C2406">
      <h2 style="margin:0 0 4px">${completed ? 'Quote requested' : 'New lead'}</h2>
      <p style="margin:0 0 16px;color:#777">via ${esc(d.source) || 'website'}</p>
      <table cellpadding="6" style="border-collapse:collapse;font-size:14px">
        ${contactRows}${quoteRows}
      </table>
    </div>`;

  await fetch(`${BREVO_API}/smtp/email`, {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'MMM Lead Pipeline', email: NOTIFY_EMAIL },
      to: [{ email: NOTIFY_EMAIL }],
      replyTo: d.email ? { email: d.email } : undefined,
      subject,
      htmlContent: html
    })
  });
}

// ---------- Brevo: send the quote to the customer ----------
async function sendQuoteToCustomer(d) {
  if (!BREVO_API_KEY || d.stage !== 'quote_completed' || !d.email) return;

  const first = d.firstName || 'there';
  const rows = String(d.quote_breakdown || '')
    .split('\n')
    .filter(Boolean)
    .map(l => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(l)}</td></tr>`)
    .join('');

  const html = `
  <div style="background:#FBF9F3;padding:28px 0;font-family:Arial,sans-serif;color:#2C2406">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
      <h1 style="margin:0 0 6px;font-size:24px">Your quote, ${esc(first)}</h1>
      <p style="margin:0 0 24px;color:#666;font-size:15px">
        Here's the pricing you built. No obligation, and nothing starts until you say so.
      </p>

      <table width="100%" style="font-size:15px;border-collapse:collapse">${rows}</table>

      <div style="background:#2C2406;border-radius:10px;padding:20px;margin:24px 0;text-align:center">
        <div style="color:rgba(255,255,255,.6);font-size:13px;letter-spacing:1px">YOUR MONTHLY TOTAL</div>
        <div style="color:#EBC522;font-size:34px;font-weight:800;margin-top:4px">£${esc(d.quoted_total)}</div>
        <div style="color:rgba(255,255,255,.6);font-size:13px">ex VAT${d.discount_pct && d.discount_pct !== '0' ? ` &middot; includes ${esc(d.discount_pct)}% bundle discount` : ''}</div>
      </div>

      <div style="text-align:center;margin:26px 0">
        <a href="https://mymarketingminder.com/free-marketing-consultation/"
           style="background:#EBC522;color:#2C2406;font-weight:bold;font-size:16px;padding:14px 30px;border-radius:8px;text-decoration:none;display:inline-block">
          Book a free consultation &rarr;
        </a>
      </div>

      <p style="font-size:14px;color:#666;line-height:1.6;margin:0 0 20px">
        Prefer to talk it through? Reply to this email, call
        <a href="tel:+447557471572" style="color:#2C2406">07557 471572</a>, or
        <a href="https://wa.me/447557471572" style="color:#2C2406">message on WhatsApp</a>.
      </p>

      <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px;margin:0">
        Prices ex VAT. No long-term contracts, cancel anytime.<br>
        My Marketing Minder &middot; Edinburgh
      </p>
    </div>
  </div>`;

  await fetch(`${BREVO_API}/smtp/email`, {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'My Marketing Minder', email: NOTIFY_EMAIL },
      to: [{ email: d.email, name: [d.firstName, d.lastName].filter(Boolean).join(' ') || undefined }],
      replyTo: { email: NOTIFY_EMAIL },
      subject: `Your quote from My Marketing Minder${d.quoted_total ? ` — £${d.quoted_total}/mo` : ''}`,
      htmlContent: html
    })
  });
}

// ---------- Forward to the CRM ----------
async function toCrm(d) {
  if (!CRM_LEAD_URL) return;
  await fetch(CRM_LEAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(d)
  });
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const d = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  if (!d.email) return res.status(400).json({ error: 'Email required' });

  // Run all three in parallel. Never let one failure block the others or the
  // response, or the widget's UX stalls.
  const results = await Promise.allSettled([
    upsertContact(d),
    notify(d),
    sendQuoteToCustomer(d),
    toCrm(d)
  ]);

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(['brevo-contact', 'notify-me', 'quote-to-customer', 'crm'][i], 'failed:', r.reason);
    }
  });

  console.log('lead ok', d.stage || 'unknown', d.email);
  return res.status(200).json({ ok: true, stage: d.stage || null });
}
