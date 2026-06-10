async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return body;
}

function setStatus(data) {
  document.getElementById("status").textContent = JSON.stringify(data, null, 2);
}

async function loadConfig() {
  const data = await api("/api/config");
  const cfg = data.config;
  const form = document.getElementById("config-form");
  for (const field of form.querySelectorAll("input, select")) {
    const value = cfg[field.name];
    field.value = value && value !== "***" ? value : "";
  }
}

async function loadWallets() {
  const data = await api("/api/wallets");
  const list = document.getElementById("wallet-list");
  list.innerHTML = "";

  data.wallets.forEach((item) => {
    const li = document.createElement("li");
    const addr = item.valid ? item.address : "INVALID_PRIVATE_KEY";
    li.innerHTML = `<span class="addr">${addr}</span>`;

    if (item.valid) {
      const btn = document.createElement("button");
      btn.className = "remove";
      btn.textContent = "Remove";
      btn.onclick = async () => {
        await api(`/api/wallets/${item.address}`, { method: "DELETE" });
        await loadWallets();
      };
      li.appendChild(btn);
    }

    list.appendChild(li);
  });
}

async function loadStatus() {
  const status = await api("/api/status");
  setStatus(status);
}

async function refreshAll() {
  await Promise.all([loadConfig(), loadWallets(), loadStatus()]);
}

document.getElementById("config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const payload = {};
  for (const field of form.querySelectorAll("input, select")) {
    payload[field.name] = field.value.trim();
  }
  await api("/api/config", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  await refreshAll();
});

document.getElementById("wallet-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyInput = document.getElementById("wallet-key");
  const privateKey = keyInput.value.trim();
  if (!privateKey) {
    return;
  }

  await api("/api/wallets", {
    method: "POST",
    body: JSON.stringify({ privateKey })
  });
  keyInput.value = "";
  await loadWallets();
});

document.getElementById("run-once").onclick = async () => {
  setStatus({ message: "Running..." });
  const res = await api("/api/run-once", { method: "POST" });
  setStatus(res);
};

document.getElementById("start").onclick = async () => {
  const res = await api("/api/start", { method: "POST" });
  setStatus(res);
};

document.getElementById("stop").onclick = async () => {
  const res = await api("/api/stop", { method: "POST" });
  setStatus(res);
};

document.getElementById("refresh").onclick = refreshAll;

refreshAll().catch((error) => setStatus({ error: error.message }));
