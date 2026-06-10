const { ethers } = require("ethers");

const LENS_ABI = [
  "function getAmountOut(address token, uint256 amountIn, bool isBuy) external view returns (address router, uint256 amountOut)",
  "function isGraduated(address token) external view returns (bool)"
];

const ROUTER_ABI = [
  "function buy((uint256 amountOutMin, address token, address to, uint256 deadline) params) payable",
  "function sell((uint256 amountIn, uint256 amountOutMin, address token, address to, uint256 deadline) params)"
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
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

  if (!ethers.isAddress(config.TOKEN_ADDRESS)) {
    throw new Error("TOKEN_ADDRESS is not a valid address.");
  }

  if (!ethers.isAddress(config.FEE_ADDRESS)) {
    throw new Error("FEE_ADDRESS is not a valid address.");
  }

  if (config.PROCEEDS_ADDRESS && !ethers.isAddress(config.PROCEEDS_ADDRESS)) {
    throw new Error("PROCEEDS_ADDRESS is not a valid address.");
  }

  const mode = (config.TRADE_MODE || "BUY_ONLY").toUpperCase();
  if (mode !== "BUY_ONLY" && mode !== "BUY_THEN_SELL") {
    throw new Error("TRADE_MODE must be BUY_ONLY or BUY_THEN_SELL.");
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
    const tradeMode = (config.TRADE_MODE || "BUY_ONLY").toUpperCase();
    const sellSlippageBps = Number.parseInt(config.SELL_SLIPPAGE_BPS || "300", 10);
    const sellDelayMs = Number.parseInt(config.SELL_DELAY_MS || "1200", 10);
    const proceedsAddress = config.PROCEEDS_ADDRESS || "";
    const gasReserveMon = config.GAS_RESERVE_MON || "0.002";
    const gasReserveWei = ethers.parseEther(gasReserveMon);

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
      feeWallet,
      tradeMode,
      sellSlippageBps: Number.isNaN(sellSlippageBps) ? 300 : Math.min(Math.max(sellSlippageBps, 1), 2000),
      sellDelayMs: Number.isNaN(sellDelayMs) ? 1200 : Math.max(0, sellDelayMs),
      proceedsAddress,
      gasReserveWei
    };
  }

  async _sweepMon(wallet, targetAddress, gasReserveWei) {
    if (!targetAddress) {
      return null;
    }

    const balance = await wallet.provider.getBalance(wallet.address);
    if (balance <= gasReserveWei) {
      return null;
    }

    const value = balance - gasReserveWei;
    const tx = await wallet.sendTransaction({
      to: targetAddress,
      value
    });
    await tx.wait(1);
    return {
      from: wallet.address,
      to: targetAddress,
      amountWei: value.toString(),
      amountMon: ethers.formatEther(value),
      hash: tx.hash
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

      const cycleBuys = [];
      const cycleSells = [];
      const sweeps = [];
      const tokenContract = new ethers.Contract(token, ERC20_ABI, runtime.provider);
      const shouldSell = runtime.tradeMode === "BUY_THEN_SELL";

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
        cycleBuys.push({
          wallet: wallet.address,
          hash: tx.hash
        });
        totalInput += amountIn;

        if (shouldSell) {
          await new Promise((resolve) => setTimeout(resolve, runtime.sellDelayMs));

          const tokenBalance = await tokenContract.balanceOf(wallet.address);
          if (tokenBalance > 0n) {
            const [sellRouterAddr, expectedMonOut] = await lens.getAmountOut(token, tokenBalance, false);
            const sellRouter =
              sellRouterAddr && sellRouterAddr !== ethers.ZeroAddress ? sellRouterAddr : actualRouterAddr;

            const allowance = await tokenContract.allowance(wallet.address, sellRouter);
            if (allowance < tokenBalance) {
              const approveTx = await tokenContract.connect(wallet).approve(sellRouter, ethers.MaxUint256);
              await approveTx.wait(1);
            }

            const sellMinOut =
              (expectedMonOut * BigInt(10000 - runtime.sellSlippageBps)) / 10000n;
            const sellTx = await new ethers.Contract(sellRouter, ROUTER_ABI, runtime.provider)
              .connect(wallet)
              .sell({
                amountIn: tokenBalance,
                amountOutMin: sellMinOut,
                token,
                to: runtime.proceedsAddress || wallet.address,
                deadline
              }, {
                gasLimit: 500000
              });
            await sellTx.wait(1);
            cycleSells.push({
              wallet: wallet.address,
              hash: sellTx.hash,
              amountInWei: tokenBalance.toString(),
              expectedMonOutWei: expectedMonOut.toString(),
              destination: runtime.proceedsAddress || wallet.address
            });
          }
        }

        if (runtime.proceedsAddress) {
          const sweep = await this._sweepMon(wallet, runtime.proceedsAddress, runtime.gasReserveWei);
          if (sweep) {
            sweeps.push(sweep);
          }
        }

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
        sellsExecuted: cycleSells.length,
        sweepsExecuted: sweeps.length,
        tradeMode: runtime.tradeMode,
        proceedsAddress: runtime.proceedsAddress || null,
        totalInputWei: totalInput.toString(),
        totalInputMon: ethers.formatEther(totalInput),
        feeAmountWei: feeAmount.toString(),
        feeAmountMon: ethers.formatEther(feeAmount),
        feeTxHash,
        buyTxs: cycleBuys,
        sellTxs: cycleSells,
        sweepTxs: sweeps
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
