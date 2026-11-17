export type Level = "info" | "warn" | "error";

export interface Notifier {
  send(level: Level, text: string): Promise<void>;
}

export const consoleNotifier: Notifier = {
  async send(level, text) {
    console.log(JSON.stringify({ level, notify: text, time: new Date().toISOString() }));
  },
};

const TELEGRAM_TIMEOUT_MS = 5000;

/** Telegram bot notifier. Never throws and never hangs: a failed alert must not break trading logic. */
export function telegramNotifier(token: string, chatId: string, fallback: Notifier = consoleNotifier): Notifier {
  const safeFallback = async (level: Level, text: string) => {
    try {
      await fallback.send(level, text);
    } catch {
      // Nothing left to report to.
    }
  };
  return {
    async send(level, text) {
      const icon = level === "error" ? "🚨" : level === "warn" ? "⚠️" : "ℹ️";
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `${icon} ${text}` }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        });
        if (!res.ok) await safeFallback(level, `[telegram ${res.status}] ${text}`);
      } catch (e) {
        const why = e instanceof Error ? e.name : "error";
        await safeFallback(level, `[telegram ${why}] ${text}`);
      }
    },
  };
}
