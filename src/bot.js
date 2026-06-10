const { ethers } = require("ethers");
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction
} = require("@solana/web3.js");
const bs58Import = require("bs58");
const bs58 = bs58Import.default || bs58Import;

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
const DEFAULT_SOL_INPUT_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_JUPITER_BASE_URL = "https://quote-api.jup.ag/v6";

function parseBuyerKeys(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((pk) => pk.trim())
    .filter(Boolean);
}

function normalizeChain(raw) {
  return (raw || "EVM").trim().toUpperCase();
}

function decodeSolanaSecretKey(secret) {
  const trimmed = `${secret || ""}`.trim();
  if (!trimmed) {
    throw new Error("Empty Solana secret key.");
  }

  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) {
      throw new Error("Solana key JSON must be an array of bytes.");
    }
    return Uint8Array.from(arr);
  }

  return bs58.decode(trimmed);
}

function parseSolanaWallet(secret) {
  const bytes = decodeSolanaSecretKey(secret);
  return Keypair.fromSecretKey(bytes);
}

function deriveWalletAddress(secret, chain) {
  const normalized = normalizeChain(chain);
  if (normalized === "SOLANA") {
    return parseSolanaWallet(secret).publicKey.toBase58();
  }
  return new ethers.Wallet(secret).address;
}

function validateConfig(config) {
  const keys = parseBuyerKeys(config.BUYER_KEYS);
  if (keys.length === 0) {
    throw new Error("BUYER_KEYS is empty. Add at least one private key.");
  }

  const intervalMs = Number.parseInt(config.INTERVAL_MS || "60000", 10);
  if (Number.isNaN(intervalMs) || intervalMs < 5000) {
    throw new Error("INTERVAL_MS must be a number >= 5000.");
  }

  const mode = (config.TRADE_MODE || "BUY_ONLY").toUpperCase();
  if (mode !== "BUY_ONLY" && mode !== "BUY_THEN_SELL") {
    throw new Error("TRADE_MODE must be BUY_ONLY or BUY_THEN_SELL.");
  }

  const chain = normalizeChain(config.CHAIN);
  if (chain !== "EVM" && chain !== "SOLANA") {
    throw new Error("CHAIN must be EVM or SOLANA.");
  }

  if (chain === "EVM") {
    const required = ["MONAD_RPC", "TOKEN_ADDRESS", "BUMP_AMOUNT_MON"];
    const missing = required.filter((key) => !config[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required EVM config: ${missing.join(", ")}`);
    }

    if (!ethers.isAddress(config.TOKEN_ADDRESS)) {
      throw new Error("TOKEN_ADDRESS is not a valid EVM address.");
    }

    if (config.FEE_ADDRESS && !ethers.isAddress(config.FEE_ADDRESS)) {
      throw new Error("FEE_ADDRESS is not a valid EVM address.");
    }

    if (config.PROCEEDS_ADDRESS && !ethers.isAddress(config.PROCEEDS_ADDRESS)) {
      throw new Error("PROCEEDS_ADDRESS is not a valid EVM address.");
    }
  } else {
    const required = ["SOLANA_RPC", "SOLANA_TOKEN_MINT", "BUMP_AMOUNT_SOL"];
    const missing = required.filter((key) => !config[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required Solana config: ${missing.join(", ")}`);
    }

    new PublicKey(config.SOLANA_TOKEN_MINT);
    if (config.PROCEEDS_ADDRESS) {
      new PublicKey(config.PROCEEDS_ADDRESS);
    }
    if (config.FEE_ADDRESS) {
      new PublicKey(config.FEE_ADDRESS);
    }
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

    const common = {
      config,
      chain: normalizeChain(config.CHAIN),
      intervalMs: Math.max(5000, Number.parseInt(config.INTERVAL_MS || "60000", 10)),
      maxBuysPerCycle: Math.max(1, Number.parseInt(config.MAX_BUYS_PER_CYCLE || "10", 10)),
      feePercent: BigInt(config.FEE_PERCENT || "0"),
      tradeMode: (config.TRADE_MODE || "BUY_ONLY").toUpperCase(),
      sellSlippageBps: Math.min(Math.max(Number.parseInt(config.SELL_SLIPPAGE_BPS || "300", 10), 1), 2000),
      buySlippageBps: Math.min(Math.max(Number.parseInt(config.BUY_SLIPPAGE_BPS || "300", 10), 1), 2000),
      sellDelayMs: Math.max(0, Number.parseInt(config.SELL_DELAY_MS || "1200", 10)),
      proceedsAddress: config.PROCEEDS_ADDRESS || ""
    };

    if (common.chain === "SOLANA") {
      return this._buildSolanaRuntime(common);
    }
    return this._buildEvmRuntime(common);
  }

  _buildEvmRuntime(common) {
    const config = common.config;
    const provider = new ethers.JsonRpcProvider(config.MONAD_RPC);
    const lensAddress = config.LENS_ADDRESS || DEFAULT_LENS_ADDRESS;
    const fallbackRouter = config.ROUTER_ADDRESS || DEFAULT_ROUTER_ADDRESS;
    const lens = new ethers.Contract(lensAddress, LENS_ABI, provider);
    const fallbackRouterContract = new ethers.Contract(fallbackRouter, ROUTER_ABI, provider);

    const buyerWallets = parseBuyerKeys(config.BUYER_KEYS).map((pk) => new ethers.Wallet(pk, provider));
    const amountIn = ethers.parseEther(config.BUMP_AMOUNT_MON);
    const token = config.TOKEN_ADDRESS;
    const gasReserveWei = ethers.parseEther(config.GAS_RESERVE_MON || "0.002");

    let feeWallet = null;
    if (config.FEE_PAYER_KEY) {
      feeWallet = new ethers.Wallet(config.FEE_PAYER_KEY.trim(), provider);
    } else if (buyerWallets.length > 0) {
      feeWallet = buyerWallets[0];
    }

    return {
      ...common,
      provider,
      lens,
      fallbackRouterContract,
      buyerWallets,
      amountIn,
      token,
      gasReserveWei,
      feeWallet
    };
  }

  _buildSolanaRuntime(common) {
    const config = common.config;
    const connection = new Connection(config.SOLANA_RPC, "confirmed");
    const buyerWallets = parseBuyerKeys(config.BUYER_KEYS).map(parseSolanaWallet);
    const amountInLamports = BigInt(Math.floor(Number.parseFloat(config.BUMP_AMOUNT_SOL) * LAMPORTS_PER_SOL));
    const tokenMint = new PublicKey(config.SOLANA_TOKEN_MINT);
    const inputMint = new PublicKey(config.SOLANA_INPUT_MINT || DEFAULT_SOL_INPUT_MINT);
    const gasReserveLamports = BigInt(
      Math.floor(Number.parseFloat(config.GAS_RESERVE_SOL || "0.002") * LAMPORTS_PER_SOL)
    );

    let feeWallet = null;
    if (config.FEE_PAYER_KEY) {
      feeWallet = parseSolanaWallet(config.FEE_PAYER_KEY.trim());
    } else if (buyerWallets.length > 0) {
      feeWallet = buyerWallets[0];
    }

    return {
      ...common,
      connection,
      buyerWallets,
      amountInLamports,
      tokenMint,
      inputMint,
      jupiterBaseUrl: config.JUPITER_BASE_URL || DEFAULT_JUPITER_BASE_URL,
      gasReserveLamports,
      feeWallet
    };
  }

  async _quoteJupiter(runtime, inputMint, outputMint, amount, slippageBps) {
    const query = new URLSearchParams({
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amount: amount.toString(),
      slippageBps: `${slippageBps}`
    });
    const url = `${runtime.jupiterBaseUrl}/quote?${query.toString()}`;
    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error || `Jupiter quote failed (${response.status}).`);
    }
    if (!body || !body.outAmount) {
      throw new Error("Jupiter quote response missing outAmount.");
    }
    return body;
  }

  async _swapJupiter(runtime, wallet, quoteResponse) {
    const response = await fetch(`${runtime.jupiterBaseUrl}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error || `Jupiter swap failed (${response.status}).`);
    }
    if (!body.swapTransaction) {
      throw new Error("Jupiter swap response missing swapTransaction.");
    }

    const txBuffer = Buffer.from(body.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([wallet]);
    const signature = await runtime.connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: false
    });
    await runtime.connection.confirmTransaction(signature, "confirmed");
    return signature;
  }

  async _getSplTokenBalance(connection, owner, mint) {
    const response = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    let total = 0n;
    for (const account of response.value) {
      const raw = account.account.data.parsed.info.tokenAmount.amount;
      total += BigInt(raw);
    }
    return total;
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
      amountNative: ethers.formatEther(value),
      hash: tx.hash
    };
  }

  async _sweepSol(runtime, wallet, targetAddress) {
    if (!targetAddress) {
      return null;
    }

    const to = new PublicKey(targetAddress);
    const balance = BigInt(await runtime.connection.getBalance(wallet.publicKey, "confirmed"));
    if (balance <= runtime.gasReserveLamports) {
      return null;
    }

    const lamports = balance - runtime.gasReserveLamports;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: to,
        lamports: Number(lamports)
      })
    );
    const signature = await runtime.connection.sendTransaction(tx, [wallet], {
      maxRetries: 3,
      skipPreflight: false
    });
    await runtime.connection.confirmTransaction(signature, "confirmed");
    return {
      from: wallet.publicKey.toBase58(),
      to: to.toBase58(),
      amountLamports: lamports.toString(),
      amountNative: `${Number(lamports) / LAMPORTS_PER_SOL}`,
      hash: signature
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

  async _runEvmOnce(startedAt, runtime) {
    const { lens, fallbackRouterContract, buyerWallets, amountIn, token } = runtime;

    const isGrad = await lens.isGraduated(token);
    const [routerAddr, expectedOut] = await lens.getAmountOut(token, amountIn, true);
    const minOut = (expectedOut * BigInt(10000 - runtime.buySlippageBps)) / 10000n;
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

      const buyTx = await dynamicRouter.buy(
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

      await buyTx.wait(1);
      cycleBuys.push({ wallet: wallet.address, hash: buyTx.hash });
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

          const sellMinOut = (expectedMonOut * BigInt(10000 - runtime.sellSlippageBps)) / 10000n;
          const sellTx = await new ethers.Contract(sellRouter, ROUTER_ABI, runtime.provider)
            .connect(wallet)
            .sell(
              {
                amountIn: tokenBalance,
                amountOutMin: sellMinOut,
                token,
                to: runtime.proceedsAddress || wallet.address,
                deadline
              },
              {
                gasLimit: 500000
              }
            );
          await sellTx.wait(1);
          cycleSells.push({
            wallet: wallet.address,
            hash: sellTx.hash,
            amountInWei: tokenBalance.toString(),
            expectedNativeOutWei: expectedMonOut.toString(),
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
    if (feeAmount > 0n && runtime.config.FEE_ADDRESS) {
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

    return {
      ok: true,
      chain: "EVM",
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
      totalInputNative: ethers.formatEther(totalInput),
      feeAmountWei: feeAmount.toString(),
      feeAmountNative: ethers.formatEther(feeAmount),
      feeTxHash,
      buyTxs: cycleBuys,
      sellTxs: cycleSells,
      sweepTxs: sweeps
    };
  }

  async _runSolanaOnce(startedAt, runtime) {
    const wallets = [...runtime.buyerWallets]
      .sort(() => Math.random() - 0.5)
      .slice(0, runtime.maxBuysPerCycle);

    const shouldSell = runtime.tradeMode === "BUY_THEN_SELL";
    const cycleBuys = [];
    const cycleSells = [];
    const sweeps = [];
    let totalInput = 0n;

    for (const wallet of wallets) {
      const buyQuote = await this._quoteJupiter(
        runtime,
        runtime.inputMint,
        runtime.tokenMint,
        runtime.amountInLamports,
        runtime.buySlippageBps
      );
      const buySignature = await this._swapJupiter(runtime, wallet, buyQuote);
      cycleBuys.push({
        wallet: wallet.publicKey.toBase58(),
        hash: buySignature,
        expectedOutAmount: buyQuote.outAmount
      });
      totalInput += runtime.amountInLamports;

      if (shouldSell) {
        await new Promise((resolve) => setTimeout(resolve, runtime.sellDelayMs));
        const tokenBalance = await this._getSplTokenBalance(runtime.connection, wallet.publicKey, runtime.tokenMint);
        if (tokenBalance > 0n) {
          const sellQuote = await this._quoteJupiter(
            runtime,
            runtime.tokenMint,
            runtime.inputMint,
            tokenBalance,
            runtime.sellSlippageBps
          );
          const sellSignature = await this._swapJupiter(runtime, wallet, sellQuote);
          cycleSells.push({
            wallet: wallet.publicKey.toBase58(),
            hash: sellSignature,
            amountInRaw: tokenBalance.toString(),
            expectedNativeOut: sellQuote.outAmount
          });
        }
      }

      if (runtime.proceedsAddress) {
        const sweep = await this._sweepSol(runtime, wallet, runtime.proceedsAddress);
        if (sweep) {
          sweeps.push(sweep);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200));
    }

    let feeTxHash = null;
    const feeAmount = (totalInput * runtime.feePercent) / 100n;
    if (feeAmount > 0n && runtime.config.FEE_ADDRESS) {
      if (!runtime.feeWallet) {
        throw new Error("Fee transfer configured but no fee payer wallet is available.");
      }
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: runtime.feeWallet.publicKey,
          toPubkey: new PublicKey(runtime.config.FEE_ADDRESS),
          lamports: Number(feeAmount)
        })
      );
      feeTxHash = await runtime.connection.sendTransaction(tx, [runtime.feeWallet], {
        maxRetries: 3,
        skipPreflight: false
      });
      await runtime.connection.confirmTransaction(feeTxHash, "confirmed");
    }

    return {
      ok: true,
      chain: "SOLANA",
      startedAt,
      endedAt: new Date().toISOString(),
      buysExecuted: wallets.length,
      sellsExecuted: cycleSells.length,
      sweepsExecuted: sweeps.length,
      tradeMode: runtime.tradeMode,
      proceedsAddress: runtime.proceedsAddress || null,
      totalInputLamports: totalInput.toString(),
      totalInputNative: `${Number(totalInput) / LAMPORTS_PER_SOL}`,
      feeAmountLamports: feeAmount.toString(),
      feeAmountNative: `${Number(feeAmount) / LAMPORTS_PER_SOL}`,
      feeTxHash,
      buyTxs: cycleBuys,
      sellTxs: cycleSells,
      sweepTxs: sweeps
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
      const result =
        runtime.chain === "SOLANA"
          ? await this._runSolanaOnce(startedAt, runtime)
          : await this._runEvmOnce(startedAt, runtime);
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
  parseBuyerKeys,
  normalizeChain,
  deriveWalletAddress
};
