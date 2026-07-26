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
    toCrm(d)
  ]);

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(['brevo-contact', 'brevo-email', 'crm'][i], 'failed:', r.reason);
    }
  });

  console.log('lead ok', d.stage || 'unknown', d.email);
  return res.status(200).json({ ok: true, stage: d.stage || null });
}
