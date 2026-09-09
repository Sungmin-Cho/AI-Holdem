export function createLobbyCommandClient({
  request,
  storage,
  onPoll = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  key = "holdem.app.command.v1",
}) {
  async function settle(payload, { submit = false } = {}) {
    let receipt;
    if (submit) {
      try {
        receipt = await request("/api/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        if (error.status && error.status !== 503) {
          storage.removeItem(key);
          throw error;
        }
      }
    }
    if (!receipt) {
      try {
        receipt = await request(`/api/commands/${payload.requestId}`);
      } catch (error) {
        if (error.status !== 404) throw error;
        try {
          receipt = await request("/api/commands", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch (error) {
          if (error.status && error.status !== 503) storage.removeItem(key);
          throw error;
        }
      }
    }
    while (receipt.status === "accepted") {
      await sleep(250);
      receipt = await request(`/api/commands/${payload.requestId}`);
      await onPoll();
    }
    if (!["succeeded", "failed"].includes(receipt.status))
      throw new Error("COMMAND_REPLY_INVALID");
    storage.removeItem(key);
    if (receipt.status === "failed") throw new Error(receipt.error);
    return receipt;
  }
  return {
    async send(payload) {
      if (storage.getItem(key)) throw new Error("COMMAND_PENDING");
      storage.setItem(key, JSON.stringify(payload));
      return settle(payload, { submit: true });
    },
    async recover() {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const payload = JSON.parse(raw);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId ?? ""))
        throw new Error("COMMAND_REPLY_INVALID");
      return settle(payload);
    },
    get pending() {
      return !!storage.getItem(key);
    },
  };
}
