const { ethers } = require("ethers");

const LENS_ABI = [
  "function getAmountOut(address token, uint256 amountIn, bool isBuy) external view returns (address router, uint256 amountOut)",
  "function isGraduated(address token) external view returns (bool)"
];

const ROUTER_ABI = [
  "function buy((uint256 amountOutMin, address token, address to, uint256 deadline) params) payable"
];

const DEFAULT_LENS_ADDRESS = "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea";
const DEFAULT_ROUTER_ADDRESS = "0x6F6B8F1a20703309951a5127c45B49b1CD981A22";

function parseBuyerKeys(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((pk) => pk.trim())
    .filter(Boolean);
}

function validateConfig(config) {
  const required = [
    "MONAD_RPC",
    "TOKEN_ADDRESS",
    "BUMP_AMOUNT_MON",
    "INTERVAL_MS",
    "FEE_PERCENT",
    "FEE_ADDRESS"
  ];

  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(", ")}`);
  }

  const keys = parseBuyerKeys(config.BUYER_KEYS);
  if (keys.length === 0) {
    throw new Error("BUYER_KEYS is empty. Add at least one private key.");
  }
}

class BumpBot {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.isRunning = false;
    this.lastResult = null;
    this.intervalHandle = null;
    this.nextRunAt = null;
  }

  _buildRuntime() {
    const config = this.getConfig();
    validateConfig(config);

    const provider = new ethers.JsonRpcProvider(config.MONAD_RPC);
    const lensAddress = config.LENS_ADDRESS || DEFAULT_LENS_ADDRESS;
    const fallbackRouter = config.ROUTER_ADDRESS || DEFAULT_ROUTER_ADDRESS;
    const lens = new ethers.Contract(lensAddress, LENS_ABI, provider);
    const fallbackRouterContract = new ethers.Contract(fallbackRouter, ROUTER_ABI, provider);

    const buyerWallets = parseBuyerKeys(config.BUYER_KEYS).map((pk) => new ethers.Wallet(pk, provider));
    const amountIn = ethers.parseEther(config.BUMP_AMOUNT_MON);
    const maxBuysPerCycle = Number.parseInt(config.MAX_BUYS_PER_CYCLE || "10", 10);
    const feePercent = BigInt(config.FEE_PERCENT);
    const intervalMs = Number.parseInt(config.INTERVAL_MS, 10);
    const token = config.TOKEN_ADDRESS;

    let feeWallet = null;
    if (config.FEE_PAYER_KEY) {
      feeWallet = new ethers.Wallet(config.FEE_PAYER_KEY.trim(), provider);
    } else if (buyerWallets.length > 0) {
      feeWallet = buyerWallets[0];
    }

    return {
      config,
      provider,
      lens,
      fallbackRouterContract,
      buyerWallets,
      amountIn,
      maxBuysPerCycle: Number.isNaN(maxBuysPerCycle) ? 10 : Math.max(1, maxBuysPerCycle),
      feePercent,
      intervalMs: Number.isNaN(intervalMs) ? 60000 : Math.max(5000, intervalMs),
      token,
      feeWallet
    };
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      schedulerActive: Boolean(this.intervalHandle),
      nextRunAt: this.nextRunAt,
      lastResult: this.lastResult
    };
  }

  async runOnce() {
    if (this.isRunning) {
      return {
        skipped: true,
        reason: "Cycle already running."
      };
    }

    this.isRunning = true;
    const startedAt = new Date().toISOString();

    try {
      const runtime = this._buildRuntime();
      const { lens, fallbackRouterContract, buyerWallets, amountIn, token } = runtime;

      const isGrad = await lens.isGraduated(token);
      const [routerAddr, expectedOut] = await lens.getAmountOut(token, amountIn, true);

      const minOut = (expectedOut * 970n) / 1000n;
      const deadline = Math.floor(Date.now() / 1000) + 600;
      let totalInput = 0n;

      const wallets = [...buyerWallets]
        .sort(() => Math.random() - 0.5)
        .slice(0, runtime.maxBuysPerCycle);

      const actualRouterAddr =
        routerAddr && routerAddr !== ethers.ZeroAddress ? routerAddr : fallbackRouterContract.target;

      const cycleTxs = [];

      for (const wallet of wallets) {
        const dynamicRouter = new ethers.Contract(actualRouterAddr, ROUTER_ABI, runtime.provider).connect(wallet);

        const tx = await dynamicRouter.buy(
          {
            amountOutMin: minOut,
            token,
            to: wallet.address,
            deadline
          },
          {
            value: amountIn,
            gasLimit: 500000
          }
        );

        await tx.wait(1);
        cycleTxs.push({
          wallet: wallet.address,
          hash: tx.hash
        });
        totalInput += amountIn;
        await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200));
      }

      let feeTxHash = null;
      const feeAmount = (totalInput * runtime.feePercent) / 100n;
      if (feeAmount > 0n) {
        if (!runtime.feeWallet) {
          throw new Error("Fee transfer configured but no fee payer wallet is available.");
        }
        const feeTx = await runtime.feeWallet.sendTransaction({
          to: runtime.config.FEE_ADDRESS,
          value: feeAmount
        });
        await feeTx.wait(1);
        feeTxHash = feeTx.hash;
      }

      const result = {
        ok: true,
        startedAt,
        endedAt: new Date().toISOString(),
        isGraduated: isGrad,
        routerUsed: actualRouterAddr,
        buysExecuted: wallets.length,
        totalInputWei: totalInput.toString(),
        totalInputMon: ethers.formatEther(totalInput),
        feeAmountWei: feeAmount.toString(),
        feeAmountMon: ethers.formatEther(feeAmount),
        feeTxHash,
        txs: cycleTxs
      };
      this.lastResult = result;
      return result;
    } catch (error) {
      const message = error?.shortMessage || error?.message || String(error);
      const result = {
        ok: false,
        startedAt,
        endedAt: new Date().toISOString(),
        error: message
      };
      this.lastResult = result;
      return result;
    } finally {
      this.isRunning = false;
    }
  }

  async startScheduler() {
    if (this.intervalHandle) {
      return this.getStatus();
    }

    const runtime = this._buildRuntime();
    const tick = async () => {
      this.nextRunAt = new Date(Date.now() + runtime.intervalMs).toISOString();
      await this.runOnce();
    };

    this.nextRunAt = new Date(Date.now() + runtime.intervalMs).toISOString();
    this.intervalHandle = setInterval(tick, runtime.intervalMs);
    await this.runOnce();
    return this.getStatus();
  }

  stopScheduler() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.nextRunAt = null;
    }
    return this.getStatus();
  }
}

module.exports = {
  BumpBot,
  parseBuyerKeys
};
