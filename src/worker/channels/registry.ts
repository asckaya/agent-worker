import type { ChannelAdapter, ChannelCapabilities } from "./types";

export class ChannelRegistry {
  private readonly channels = new Map<string, ChannelAdapter>();

  register(channel: ChannelAdapter) {
    if (this.channels.has(channel.name)) {
      throw new Error(`Channel already registered: ${channel.name}`);
    }

    this.channels.set(channel.name, channel);
  }

  get(name: string) {
    return this.channels.get(name);
  }

  list() {
    return [...this.channels.values()];
  }

  listCapabilities(): ChannelCapabilities[] {
    return this.list().map((channel) => channel.capabilities);
  }
}

export function createChannelRegistry(channels: ChannelAdapter[] = []) {
  const registry = new ChannelRegistry();
  for (const channel of channels) {
    registry.register(channel);
  }
  return registry;
}
