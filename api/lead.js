// api/lead.js — receives a lead from any MMM form and sends it to 4 places.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://mymarketingminder.com";
export default async function handler(req, res) {
  // --- allow your website to talk to this function ---
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const data = req.body || {};
  // --- spam trap: if the hidden field is filled, it's a bot. Fake success. ---
  if (data.company_website) return res.status(200).json({ ok: true });
  const email = (data.email || "").trim();
  if (!email) return res.status(400).json({ error: "Email is required" });
  // Accept BOTH camelCase (quote widget) and snake_case (older forms)
  const lead = {
    email,
    firstName: (data.firstName || data.first_name || "").trim(),
    lastName: (data.lastName || data.last_name || "").trim(),
    phone: (data.phone || "").trim(),
    business: (data.business || "").trim(),
    website: (data.website || "").trim(),
    service: (data.service || data.services || "").trim(),
    callTime: (data.call_time || "").trim(),
    message: (data.message || "").trim(),
    source: (data.source || "website").trim(),
    // quote-widget extras:
    quoteBreakdown: (data.quote_breakdown || "").trim(),
    quotedTotal: (data.quoted_total || "").trim(),
    bookingUrl: (data.booking_url || "https://mymarketingminder.com/book-a-consultation/").trim(),
    stage: (data.stage || "").trim(),
    submittedAt: new Date().toISOString(),
  };
  // fire each destination independently — one failing never blocks the others
  const jobs = [
    sendToBrevoContact(lead),
    sendNotificationEmail(lead),
    sendToCrm(lead),
  ];
  // Only email the CUSTOMER their quote when they actually completed one
  if (lead.stage === "quote_completed" && lead.quoteBreakdown) {
    jobs.push(sendQuoteToCustomer(lead));
  }
  const results = await Promise.allSettled(jobs);
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(["brevo", "email", "crm", "customer"][i], "FAILED:", r.reason);
  });
  const anyOk = results.some((r) => r.status === "fulfilled");
  if (!anyOk) return res.status(502).json({ error: "All destinations failed" });
  return res.status(200).json({ ok: true });
}
// 1) add / update the contact in Brevo
async function sendToBrevoContact(lead) {
  const r = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      email: lead.email,
      updateEnabled: true,
      listIds: [Number(process.env.BREVO_LIST_ID)],
      attributes: {
        FIRSTNAME: lead.firstName,
        LASTNAME: lead.lastName,
        PHONE: lead.phone,
        BUSINESS: lead.business,
        WEBSITE: lead.website,
        SERVICE: lead.service,
        CALLTIME: lead.callTime,
        MESSAGE: lead.message,
        SOURCE: lead.source,
      },
    }),
  });
  if (!r.ok) throw new Error("Brevo contact " + r.status + " " + (await r.text()));
}
// 2) email YOU the lead (via Brevo transactional email)
async function sendNotificationEmail(lead) {
  const rows = [
    ["Name", lead.firstName + " " + lead.lastName],
    ["Email", lead.email],
    ["Phone", lead.phone],
    ["Business", lead.business],
    ["Website", lead.website],
    ["Service", lead.service],
    ["Quote", lead.quotedTotal ? "£" + lead.quotedTotal + "/mo" : ""],
    ["Best time to call", lead.callTime],
    ["Message", lead.message],
    ["Stage", lead.stage],
    ["Came from", lead.source],
  ].map(([k, v]) =>
    `<tr><td style="padding:6px 12px;font-weight:bold;border-bottom:1px solid #eee;">${k}</td>` +
    `<td style="padding:6px 12px;border-bottom:1px solid #eee;">${escapeHtml(v || "—")}</td></tr>`
  ).join("");
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { name: "MMM Website", email: process.env.NOTIFY_EMAIL },
      to: [{ email: process.env.NOTIFY_EMAIL }],
      replyTo: { email: lead.email, name: lead.firstName + " " + lead.lastName },
      subject: "New lead: " + lead.firstName + " " + lead.lastName + " (" + lead.source + ")",
      htmlContent: `<h2>New lead from your website</h2>
        <table style="border-collapse:collapse;font-family:Arial,sans-serif;">${rows}</table>`,
    }),
  });
  if (!r.ok) throw new Error("Brevo email " + r.status + " " + (await r.text()));
}
// 3) push the lead into your CRM via its built-in webhook: POST /api/ingest/<api_key>
async function sendToCrm(lead) {
  if (!process.env.CRM_LEAD_URL) return; // skip cleanly until the CRM URL is set
  // The CRM's leads table stores name/email/phone/notes/source. Fold the extra
  // fields it has no column for into the notes so nothing is lost.
  const extras = [
    lead.business && "Business: " + lead.business,
    lead.website && "Website: " + lead.website,
    lead.service && "Service: " + lead.service,
    lead.quotedTotal && "Quote: £" + lead.quotedTotal + "/mo",
    lead.quoteBreakdown && "Breakdown:\n" + lead.quoteBreakdown,
    lead.callTime && "Best time to call: " + lead.callTime,
    lead.source && "Form: " + lead.source,
  ].filter(Boolean).join("\n");
  const notes = [lead.message, extras].filter(Boolean).join("\n\n");
  const r = await fetch(process.env.CRM_LEAD_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: (lead.firstName + " " + lead.lastName).trim(),
      email: lead.email,
      phone: lead.phone,
      message: notes,
      source: "Website Form",
    }),
  });
  if (!r.ok) throw new Error("CRM " + r.status + " " + (await r.text()));
}
// 4) email the CUSTOMER their quote, booking link + contact details
async function sendQuoteToCustomer(lead) {
  const rows = lead.quoteBreakdown.split("\n").map((line) => {
    const isTotal = /^TOTAL/i.test(line);
    const parts = line.split(":");
    const label = parts.shift().trim();
    const value = parts.join(":").trim();
    const weight = isTotal ? "font-weight:bold;" : "";
    const bg = isTotal ? "background:#FBF8EF;" : "";
    return `<tr style="${bg}">
      <td style="padding:10px 14px;border-bottom:1px solid #eee;${weight}color:#2C2406;">${escapeHtml(label)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;text-align:right;${weight}color:#2C2406;">${escapeHtml(value)}</td>
    </tr>`;
  }).join("");

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2C2406;">
    <div style="background:#2C2406;padding:24px;text-align:center;">
      <div style="font-size:26px;font-weight:bold;color:#EBC522;">My Marketing Minder</div>
      <div style="color:#d8cfa6;font-size:13px;margin-top:4px;">Your instant quote</div>
    </div>
    <div style="padding:26px 24px;">
      <p style="font-size:15px;">Hi ${escapeHtml(lead.firstName) || "there"},</p>
      <p style="font-size:15px;line-height:1.6;">Thanks for building a quote with us. Here's a summary of what you put together:</p>
      <table style="width:100%;border-collapse:collapse;margin:18px 0;border:1px solid #eee;">${rows}</table>
      <p style="font-size:13px;color:#666;">All prices exclude VAT. Flat monthly fee, no percentage of ad spend, no long-term contracts — cancel anytime.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${escapeHtml(lead.bookingUrl)}" style="background:#EBC522;color:#2C2406;text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:8px;display:inline-block;font-size:15px;">Book your free assessment →</a>
      </div>
      <p style="font-size:14px;line-height:1.6;">Prefer to talk it through? Reply to this email or reach me directly:</p>
      <p style="font-size:14px;line-height:1.7;">
        📧 <a href="mailto:contact@mymarketingminder.com" style="color:#2C2406;">contact@mymarketingminder.com</a><br>
        📞 <a href="tel:+447830519173" style="color:#2C2406;">07830 519173</a>
      </p>
      <p style="font-size:14px;">Speak soon,<br><b>Matt — My Marketing Minder</b></p>
    </div>
    <div style="background:#FBF8EF;padding:16px;text-align:center;font-size:11px;color:#9a8f66;">
      Google &amp; Meta certified · Serving businesses across the UK
    </div>
  </div>`;

  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { name: "My Marketing Minder", email: process.env.NOTIFY_EMAIL },
      to: [{ email: lead.email, name: (lead.firstName + " " + lead.lastName).trim() }],
      replyTo: { email: process.env.NOTIFY_EMAIL, name: "My Marketing Minder" },
      subject: "Your My Marketing Minder quote",
      htmlContent: html,
    }),
  });
  if (!r.ok) throw new Error("Customer quote email " + r.status + " " + (await r.text()));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
