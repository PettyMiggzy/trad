const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { BumpBot, parseBuyerKeys } = require("./bot");
const { getEffectiveConfig, updateConfigFields, loadEnvFile, ENV_PATH } = require("./envStore");

dotenv.config();

const app = express();
const bot = new BumpBot(getEffectiveConfig);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(process.cwd(), "public")));

function sanitizeConfig(config) {
  const masked = { ...config };
  const secretFields = ["BUYER_KEYS", "FEE_PAYER_KEY"];
  for (const key of secretFields) {
    if (masked[key]) {
      masked[key] = "***";
    }
  }

  const buyers = parseBuyerKeys(config.BUYER_KEYS);
  masked.BUYER_WALLETS = buyers.map((pk) => {
    try {
      return new (require("ethers").ethers.Wallet)(pk).address;
    } catch {
      return "INVALID_PRIVATE_KEY";
    }
  });

  return masked;
}

app.get("/api/config", (req, res) => {
  const cfg = getEffectiveConfig();
  res.json({
    envPath: ENV_PATH,
    config: sanitizeConfig(cfg)
  });
});

app.post("/api/config", (req, res) => {
  const allowed = [
    "MONAD_RPC",
    "TOKEN_ADDRESS",
    "BUMP_AMOUNT_MON",
    "INTERVAL_MS",
    "FEE_PERCENT",
    "FEE_ADDRESS",
    "FEE_PAYER_KEY",
    "MAX_BUYS_PER_CYCLE",
    "LENS_ADDRESS",
    "ROUTER_ADDRESS"
  ];

  const patch = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      patch[key] = req.body[key];
    }
  }

  updateConfigFields(patch);
  res.json({ ok: true });
});

app.get("/api/wallets", (req, res) => {
  const cfg = getEffectiveConfig();
  const keys = parseBuyerKeys(cfg.BUYER_KEYS);
  const wallets = keys.map((pk) => {
    try {
      const address = new (require("ethers").ethers.Wallet)(pk).address;
      return { address, valid: true };
    } catch {
      return { address: null, valid: false };
    }
  });
  res.json({ count: wallets.length, wallets });
});

app.post("/api/wallets", (req, res) => {
  const key = `${req.body.privateKey || ""}`.trim();
  if (!key) {
    return res.status(400).json({ ok: false, error: "privateKey is required" });
  }

  let address;
  try {
    address = new (require("ethers").ethers.Wallet)(key).address;
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid private key" });
  }

  const env = loadEnvFile();
  const existing = parseBuyerKeys(env.BUYER_KEYS);

  if (existing.includes(key)) {
    return res.status(409).json({ ok: false, error: "Key already exists", address });
  }

  existing.push(key);
  updateConfigFields({ BUYER_KEYS: existing.join(",") });
  return res.json({ ok: true, address });
});

app.delete("/api/wallets/:address", (req, res) => {
  const target = req.params.address.toLowerCase();
  const env = loadEnvFile();
  const existing = parseBuyerKeys(env.BUYER_KEYS);

  const kept = existing.filter((pk) => {
    try {
      const walletAddress = new (require("ethers").ethers.Wallet)(pk).address.toLowerCase();
      return walletAddress !== target;
    } catch {
      return true;
    }
  });

  updateConfigFields({ BUYER_KEYS: kept.join(",") });
  return res.json({ ok: true, removedAddress: req.params.address });
});

app.post("/api/run-once", async (req, res) => {
  const result = await bot.runOnce();
  res.json(result);
});

app.post("/api/start", async (req, res) => {
  try {
    const status = await bot.startScheduler();
    res.json({ ok: true, status });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.post("/api/stop", (req, res) => {
  const status = bot.stopScheduler();
  res.json({ ok: true, status });
});

app.get("/api/status", (req, res) => {
  res.json(bot.getStatus());
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

const port = Number.parseInt(process.env.PORT || "3000", 10);
app.listen(port, () => {
  console.log(`Dashboard running on http://localhost:${port}`);
});
