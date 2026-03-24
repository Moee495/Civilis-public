import { Server as SocketIOServer } from 'socket.io';

export type AgentType = 'scout' | 'analyst' | 'executor';

export type EventType =
  | 'signal_published'
  | 'signal_purchased'
  | 'advice_published'
  | 'advice_purchased'
  | 'trade_executed'
  | 'challenge_scored'
  | 'agent_registered';

export interface AgentEvent {
  type: EventType;
  agentId: string;
  agentName: string;
  agentType: AgentType;
  comment: string; // personality
  data: Record<string, unknown>;
  txHash?: string;
  timestamp?: number;
}

export class EventBus {
  private io: SocketIOServer;
  private eventBuffer: AgentEvent[] = [];
  private readonly MAX_BUFFER_SIZE = 100;

  constructor(io: SocketIOServer) {
    this.io = io;
  }

  emit(event: AgentEvent): void {
    const eventWithTimestamp: AgentEvent = {
      ...event,
      timestamp: Date.now(),
    };

    // Broadcast to all connected clients
    this.io.emit('agent_event', eventWithTimestamp);

    // Store in ring buffer
    this.eventBuffer.push(eventWithTimestamp);
    if (this.eventBuffer.length > this.MAX_BUFFER_SIZE) {
      this.eventBuffer.shift();
    }
  }

  getRecent(count: number = 10): AgentEvent[] {
    return this.eventBuffer.slice(-count);
  }
}
