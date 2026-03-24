import type { Server as SocketIOServer } from 'socket.io';

export interface RealtimeEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

const MAX_BUFFER = 200;

let io: SocketIOServer | null = null;
const buffer: RealtimeEvent[] = [];

export function bindRealtimeServer(server: SocketIOServer): void {
  io = server;
}

export const eventBus = {
  emit(type: string, payload: Record<string, unknown>): void {
    const event: RealtimeEvent = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    buffer.push(event);
    if (buffer.length > MAX_BUFFER) {
      buffer.shift();
    }

    io?.emit(type, event);
    io?.emit('agent_event', event);
  },
  getRecent(count: number = 20): RealtimeEvent[] {
    return buffer.slice(-count);
  },
};
