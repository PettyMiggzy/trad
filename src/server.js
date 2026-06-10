const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { BumpBot, parseBuyerKeys, normalizeChain, deriveWalletAddress } = require("./bot");
const { getEffectiveConfig, updateConfigFields, loadEnvFile, ENV_PATH } = require("./envStore");

dotenv.config();

const app = express();
const bot = new BumpBot(getEffectiveConfig);

const CONFIG_KEYS = [
  "CHAIN",
  "MONAD_RPC",
  "TOKEN_ADDRESS",
  "BUMP_AMOUNT_MON",
  "SOLANA_RPC",
  "SOLANA_TOKEN_MINT",
  "SOLANA_INPUT_MINT",
  "BUMP_AMOUNT_SOL",
  "BUY_SLIPPAGE_BPS",
  "INTERVAL_MS",
  "FEE_PERCENT",
  "FEE_ADDRESS",
  "FEE_PAYER_KEY",
  "MAX_BUYS_PER_CYCLE",
  "LENS_ADDRESS",
  "ROUTER_ADDRESS",
  "TRADE_MODE",
  "PROCEEDS_ADDRESS",
  "SELL_SLIPPAGE_BPS",
  "SELL_DELAY_MS",
  "GAS_RESERVE_MON",
  "GAS_RESERVE_SOL",
  "JUPITER_BASE_URL",
  "BUYER_KEYS"
];

const DEFAULT_CONFIG = {
  CHAIN: "EVM",
  TRADE_MODE: "BUY_ONLY",
  BUY_SLIPPAGE_BPS: "300",
  SELL_SLIPPAGE_BPS: "300",
  SELL_DELAY_MS: "1200",
  GAS_RESERVE_MON: "0.002",
  GAS_RESERVE_SOL: "0.002",
  SOLANA_INPUT_MINT: "So11111111111111111111111111111111111111112",
  JUPITER_BASE_URL: "https://quote-api.jup.ag/v6"
};

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(process.cwd(), "public")));

function sanitizeConfig(config) {
  const masked = {};
  for (const key of CONFIG_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(config, key) ? config[key] : DEFAULT_CONFIG[key];
    if (value !== undefined) {
      masked[key] = value;
    }
  }
  const secretFields = ["BUYER_KEYS", "FEE_PAYER_KEY"];
  for (const key of secretFields) {
    if (masked[key]) {
      masked[key] = "***";
    }
  }

  const buyers = parseBuyerKeys(config.BUYER_KEYS);
  const chain = normalizeChain(config.CHAIN);
  masked.BUYER_WALLETS = buyers.map((pk) => {
    try {
      return deriveWalletAddress(pk, chain);
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
  const allowed = CONFIG_KEYS.filter((k) => k !== "BUYER_KEYS");

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
  const chain = normalizeChain(cfg.CHAIN);
  const keys = parseBuyerKeys(cfg.BUYER_KEYS);
  const wallets = keys.map((pk) => {
    try {
      const address = deriveWalletAddress(pk, chain);
      return { address, valid: true };
    } catch {
      return { address: null, valid: false };
    }
  });
  res.json({ count: wallets.length, wallets });
});

app.post("/api/wallets", (req, res) => {
  const cfg = getEffectiveConfig();
  const chain = normalizeChain(cfg.CHAIN);
  const key = `${req.body.privateKey || ""}`.trim();
  if (!key) {
    return res.status(400).json({ ok: false, error: "privateKey is required" });
  }

  let address;
  try {
    address = deriveWalletAddress(key, chain);
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
  const cfg = getEffectiveConfig();
  const chain = normalizeChain(cfg.CHAIN);
  const env = loadEnvFile();
  const existing = parseBuyerKeys(env.BUYER_KEYS);

  const kept = existing.filter((pk) => {
    try {
      const walletAddress = deriveWalletAddress(pk, chain).toLowerCase();
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
