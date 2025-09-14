require("dotenv").config({path:"./key.env"});
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 5000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const APP_SCHEME = process.env.APP_SCHEME || "joki";
const BASE_URL = process.env.BASE_URL;
const SUBSCRIPTION_DAYS = parseInt(process.env.SUBSCRIPTION_DAYS || "30");
const SUBSCRIPTION_AMOUNT = parseInt((process.env.SUBSCRIPTION_AMOUNT || "5000").trim(), 10);
console.log("Amount sent to paystack", SUBSCRIPTION_AMOUNT * 100);

// --- SQLite Database Setup ---
const DB_PATH = path.join(__dirname, "database.sqlite");
const db = new Database(DB_PATH);



    db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT,
        deviceId TEXT,
        appId TEXT,
        active INTEGER DEFAULT 0,
        expiresAt TEXT,
        lastRef TEXT,
        PRIMARY KEY (email, deviceId, appId)
      )
    `).run();


    
// Health Check
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Check subscription status
app.get("/status", (req, res) => {
  const { email, deviceId, appId } = req.query;
  if (!email || !deviceId || !appId) return res.status(400).json({ error: "email, deviceId, appId required" });

  const key = [email.toLowerCase(), deviceId, appId];
  const row = db.prepare("SELECT * FROM users WHERE email = ? AND deviceId=? AND appId=?").get(key);

    if (row && row.active && new Date(row.expiresAt) > new Date()) {
      return res.json({ active: true, expiresAt: row.expiresAt });
    }
    return res.json({ active: false });
  });


// Start payment
app.post("/pay", async (req, res) => {
  const { email, deviceId, appId } = req.body;
  if (!email || !deviceId || !appId) return res.status(400).json({ error: "email, deviceId, appId is required" });
  if (!PAYSTACK_SECRET) return res.status(500).json({ error: "PAYSTACK_SECRET Missing" });
  if (!BASE_URL) return res.status(500).json({ error: "BASE_URL Missing" });

  const key = [email.toLowerCase(), deviceId, appId];
  const row = db.prepare("SELECT * FROM users WHERE email = ? AND deviceId=? AND appId=?").get(key);

    if (row && row.active && new Date(row.expiresAt) > new Date()) {
      return res.status(409).json({ error: "already_active", expiresAt: row.expiresAt });
    }

    try {
      const callbackUrl = `${BASE_URL}/paystack/callback`;
      const init = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        
        {
          email,
          amount: SUBSCRIPTION_AMOUNT * 100,
          metadata: { email, deviceId, appId, app: "joki" },
          callback_url: callbackUrl,
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = init.data?.data;
      if (!data?.authorization_url || !data?.reference) {
        return res.status(500).json({ ok: false, error: "Initialization failed", details: init.data });
      }

      // Save pending transaction with NULL expiry
      db.prepare(
        "INSERT OR REPLACE INTO users (email, deviceId, appId, active, expiresAt, lastRef) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(email.toLowerCase(), deviceId, appId, 0, null, data.reference);
      

      return res.json({
        ok: true,
        authorizationUrl: data.authorization_url,
        reference: data.reference,
      });
    } catch (e) {
      const details = e.response?.data || { message: e.message };
      return res.status(500).json({ ok: false, error: "paystack_init_failed", details });
    }
  });


// Callback from Paystack → redirect to app deep link
app.get("/paystack/callback", async (req, res) => {
  const reference = String(req.query.reference || "");
  if (!reference) return res.status(400).send("Missing reference");

  try {
    const verifyRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const data = verifyRes.data?.data;
    if (!data) throw new Error("Invalid response from Paystack");

    let status = "failed";
    if (data.status === "success") {
      const email = data.metadata?.email?.toLowerCase();
      const deviceId = data.metadata?.deviceId;
      const appId = data.metadata?.appId;

      if (email && deviceId && appId) {
        const expires = new Date();
        expires.setDate(expires.getDate() + SUBSCRIPTION_DAYS);
        const expiresAt = expires.toISOString();

        db.prepare(
          "UPDATE users SET active = ?, expiresAt = ?, lastRef = ? WHERE email = ? AND deviceId=? AND appId=?"
        ).run(1, expiresAt, reference, email.toLowerCase(), deviceId, appId);
      }
      status = "success";
    }

    const deepLink = `${APP_SCHEME}://paystack-callback?status=${status}&type=subscription&reference=${reference}`;
    res.redirect(deepLink);
  } catch (err) {
    console.error("Callback verification error:", err.message);
    const deepLink = `${APP_SCHEME}://paystack-callback?status=error&type=subscription&reference=${reference}`;
    res.redirect(deepLink);
  }
});

// Verify payment (called by app)
app.get("/verify/:reference", async (req, res) => {
  const reference = req.params.reference;
  try {
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const data = verify.data?.data;
    if (data?.status !== "success") return res.json({ ok: false, error: "not_success" });
    if (data?.amount !== SUBSCRIPTION_AMOUNT * 100) return res.json({ ok: false, error: "amount_mismatch" });

    const email = data.metadata?.email?.toLowerCase();
    const deviceId = data.metadata?.deviceId;
    const appId = data.metadata?.appId;

    if (!email || !deviceId || !appId) return res.json({ ok: false, error: "no_email, no_deviceId, no_appId" });

    const expires = new Date();
    expires.setDate(expires.getDate() + SUBSCRIPTION_DAYS);
    const expiresAt = expires.toISOString();

    db.prepare(
      "UPDATE users SET active = ?, expiresAt = ?, lastRef = ? WHERE email = ? AND deviceId=? AND appId=?"
    ).run(1, expiresAt, reference, email, deviceId, appId);
    

    return res.json({ ok: true, expiresAt });
  } catch (e) {
    const details = e.response?.data || { message: e.message };
    return res.status(500).json({ ok: false, error: "verify_failed", details });
  }
});

// Webhook from Paystack
app.post("/webhook/paystack", (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET)
                     .update(JSON.stringify(req.body))
                     .digest('hex');
  if (hash !== signature) return res.sendStatus(403);

  res.sendStatus(200);

  const event = req.body;
  if (event.event === "charge.success") {
    const reference = event.data.reference;
    const email = event.data.metadata?.email?.toLowerCase();
    const deviceId = event.data.metadata?.deviceId;
    const appId = event.data.metadata?.appId;
    if (email && deviceId && appId) {
      const expires = new Date();
      expires.setDate(expires.getDate() + SUBSCRIPTION_DAYS);
      const expiresAt = expires.toISOString();

      db.prepare(
        "UPDATE users SET active = ?, expiresAt = ?, lastRef = ? WHERE email = ? AND deviceId=? AND appId=?"
      ).run(1, expiresAt, reference, email, deviceId, appId);
      
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
