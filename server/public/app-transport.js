// App credentials stay in sessionStorage; relay credentials never enter this page.
const params = new URLSearchParams(location.search);
export const appGameId = params.get("appGame");
export const appEpoch = params.get("epoch");
export function appFetch(endpoint, options = {}) {
  const headers = new Headers(options.headers);
  headers.set(
    "authorization",
    `Bearer ${sessionStorage.getItem("holdem-app-token") ?? ""}`,
  );
  headers.set("x-game-epoch", appEpoch ?? "");
  return fetch(`/api/game/${appGameId}/${endpoint}`, { ...options, headers });
}
export function eventStream(endpoint) {
  const listeners = new Map(),
    controller = new AbortController();
  let lastId = 0;
  const stream = {
    addEventListener(kind, fn) {
      listeners.set(kind, fn);
    },
    close() {
      controller.abort();
    },
  };
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const query = new URLSearchParams(endpoint.split("?")[1]);
        query.set("after", String(lastId));
        const response = await appFetch(`${endpoint.split("?")[0]}?${query}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("SSE_FAILED");
        await stream.onopen?.();
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value.replace(/\r\n/g, "\n");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let kind = "message",
              data = [],
              id = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) kind = line.slice(6).trim();
              else if (line.startsWith("data:"))
                data.push(line.slice(5).trimStart());
              else if (line.startsWith("id:")) id = line.slice(3).trim();
            }
            if (data.length) {
              lastId = Math.max(lastId, Number(id) || 0);
              const event = { data: data.join("\n"), lastEventId: id };
              if (kind === "message") stream.onmessage?.(event);
              else listeners.get(kind)?.(event);
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      stream.onerror?.();
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return stream;
}
