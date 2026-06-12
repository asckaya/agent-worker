export interface SlashCommand {
  name: string;
  args: string;
  botName?: string;
  raw: string;
}

const SLASH_COMMAND_PATTERN = /^\/([a-zA-Z][\w-]*)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/;

export function parseSlashCommand(text: string): SlashCommand | null {
  const raw = text.trim();
  const match = SLASH_COMMAND_PATTERN.exec(raw);
  if (!match) return null;

  return {
    name: match[1].toLowerCase(),
    botName: match[2],
    args: match[3]?.trim() ?? "",
    raw,
  };
}

export function isSlashCommand(text: string, command: string) {
  return parseSlashCommand(text)?.name === command.toLowerCase();
}
