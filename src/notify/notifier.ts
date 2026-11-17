export type Level = "info" | "warn" | "error";

export interface Notifier {
  send(level: Level, text: string): Promise<void>;
}

export const consoleNotifier: Notifier = {
  async send(level, text) {
    console.log(JSON.stringify({ level, notify: text, time: new Date().toISOString() }));
  },
};

/** Telegram bot notifier. Never throws: a failed alert must not break trading logic. */
export function telegramNotifier(token: string, chatId: string, fallback: Notifier = consoleNotifier): Notifier {
  return {
    async send(level, text) {
      const icon = level === "error" ? "🚨" : level === "warn" ? "⚠️" : "ℹ️";
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `${icon} ${text}` }),
        });
        if (!res.ok) await fallback.send(level, `[telegram ${res.status}] ${text}`);
      } catch {
        await fallback.send(level, text);
      }
    },
  };
}
