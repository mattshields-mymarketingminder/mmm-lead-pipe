// api/lead.js — receives a lead from any MMM form and sends it to 3 places.

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

  const lead = {

    email,

    firstName: (data.first_name || "").trim(),

    lastName: (data.last_name || "").trim(),

    phone: (data.phone || "").trim(),

    business: (data.business || "").trim(),

    website: (data.website || "").trim(),

    service: (data.service || "").trim(),

    callTime: (data.call_time || "").trim(),

    message: (data.message || "").trim(),

    source: (data.source || "website").trim(),

    submittedAt: new Date().toISOString(),

  };

  // fire all three, independently — one failing never blocks the others

  const results = await Promise.allSettled([

    sendToBrevoContact(lead),

    sendNotificationEmail(lead),

    sendToCrm(lead),

  ]);

  results.forEach((r, i) => {

    if (r.status === "rejected") console.error(["brevo", "email", "crm"][i], "FAILED:", r.reason);

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

    ["Best time to call", lead.callTime],

    ["Message", lead.message],

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

// 3) push the lead into your CRM

async function sendToCrm(lead) {

  if (!process.env.CRM_LEAD_URL) return; // skip cleanly until the CRM endpoint exists

  const r = await fetch(process.env.CRM_LEAD_URL, {

    method: "POST",

    headers: { "content-type": "application/json", "x-api-key": process.env.CRM_LEAD_SECRET || "" },

    body: JSON.stringify(lead),

  });

  if (!r.ok) throw new Error("CRM " + r.status + " " + (await r.text()));

}

function escapeHtml(s) {

  return String(s).replace(/[&<>"']/g, (c) =>

    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

}
