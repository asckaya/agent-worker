const TELEGRAM_COMMANDS = [
  { command: "start", description: "Show help and connection status" },
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Show runtime status" },
  { command: "memory", description: "List saved memory" },
  { command: "pending", description: "List pending tool approvals" },
  { command: "forget", description: "Delete a memory by id" },
  { command: "approve", description: "Approve a pending tool by id" },
  { command: "deny", description: "Deny a pending tool by id" },
  { command: "stop", description: "Cancel the active response" },
  { command: "new", description: "Start a fresh turn" },
  { command: "reset", description: "Reset active run state" },
  { command: "id", description: "Show this Telegram chat id" },
];

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is required.");
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ commands: TELEGRAM_COMMANDS }),
});

const body = (await response.json().catch(() => ({}))) as TelegramApiResponse<boolean>;
if (!response.ok || body.ok === false) {
  console.error(
    `setMyCommands failed: ${response.status} ${body.description ?? "Telegram request failed."}`,
  );
  process.exit(1);
}

console.log(`Registered ${TELEGRAM_COMMANDS.length} Telegram bot commands.`);

export {};
