import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Issue #1299: WebSocket Gateway for Real-Time Marketplace Feeds
 * Broadcasts marketplace events: offer.created, offer.updated, offer.filled, offer.cancelled
 * to connected clients subscribed to marketplace room
 */
@WebSocketGateway({
  namespace: '/marketplace',
  cors: { origin: process.env.CORS_ORIGIN || 'http://localhost:3000' },
})
@Injectable()
export class MarketplaceGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketplaceGateway.name);
  private clientSubscriptions = new Map<string, Set<string>>();

  constructor(private eventEmitter: EventEmitter2) {}

  /**
   * Handle client connection
   */
  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientSubscriptions.set(client.id, new Set());
  }

  /**
   * Handle client disconnection
   */
  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clientSubscriptions.delete(client.id);
  }

  /**
   * Subscribe to marketplace events
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(client: Socket, data: { room: string }): void {
    const { room } = data;
    client.join(`marketplace:${room}`);
    this.clientSubscriptions.get(client.id)?.add(room);
    this.logger.debug(`Client ${client.id} subscribed to ${room}`);
    client.emit('subscribed', { room });
  }

  /**
   * Unsubscribe from marketplace events
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(client: Socket, data: { room: string }): void {
    const { room } = data;
    client.leave(`marketplace:${room}`);
    this.clientSubscriptions.get(client.id)?.delete(room);
    this.logger.debug(`Client ${client.id} unsubscribed from ${room}`);
  }

  /**
   * Broadcast offer created event
   */
  broadcastOfferCreated(offer: any): void {
    this.server.to('marketplace:offers').emit('offer.created', {
      type: 'offer.created',
      timestamp: new Date().toISOString(),
      data: offer,
    });
    this.logger.debug(`Broadcasted offer.created: ${offer.id}`);
  }

  /**
   * Broadcast offer updated event
   */
  broadcastOfferUpdated(offer: any): void {
    this.server.to('marketplace:offers').emit('offer.updated', {
      type: 'offer.updated',
      timestamp: new Date().toISOString(),
      data: offer,
    });
    this.logger.debug(`Broadcasted offer.updated: ${offer.id}`);
  }

  /**
   * Broadcast offer filled event (trade executed)
   */
  broadcastOfferFilled(offer: any, fillAmount: number, buyer: string): void {
    this.server.to('marketplace:offers').emit('offer.filled', {
      type: 'offer.filled',
      timestamp: new Date().toISOString(),
      data: {
        offerId: offer.id,
        fillAmount,
        buyer,
        remainingAmount: offer.tonnes - fillAmount,
      },
    });
    this.logger.debug(`Broadcasted offer.filled: ${offer.id}`);
  }

  /**
   * Broadcast offer cancelled event
   */
  broadcastOfferCancelled(offerId: string, reason: string): void {
    this.server.to('marketplace:offers').emit('offer.cancelled', {
      type: 'offer.cancelled',
      timestamp: new Date().toISOString(),
      data: {
        offerId,
        reason,
      },
    });
    this.logger.debug(`Broadcasted offer.cancelled: ${offerId}`);
  }

  /**
   * #1308 — Broadcast offer.expired event when the stale-offer sync task
   * marks an on-chain expired offer as EXPIRED in the database.
   */
  broadcastOfferExpired(offerId: string, seller: string): void {
    this.server.to('marketplace:offers').emit('offer.expired', {
      type: 'offer.expired',
      timestamp: new Date().toISOString(),
      data: { offerId, seller },
    });
    this.logger.debug(`Broadcasted offer.expired: ${offerId}`);
  }

  /**
   * Get real-time marketplace statistics
   */
  @SubscribeMessage('getStats')
  handleGetStats(client: Socket): void {
    // Could fetch from cache or database
    client.emit('stats', {
      activeOffers: 1200,
      dailyVolume: 50000,
      averagePrice: 25.5,
      connectedBuyers: this.server.engine.clientsCount,
    });
  }

  /**
   * Broadcast price update for specific credit
   */
  broadcastPriceUpdate(creditId: string, newPrice: number): void {
    this.server.to(`marketplace:credit:${creditId}`).emit('price.updated', {
      type: 'price.updated',
      timestamp: new Date().toISOString(),
      data: {
        creditId,
        newPrice,
      },
    });
    this.logger.debug(
      `Broadcasted price update for credit ${creditId}: ${newPrice}`,
    );
  }

  /**
   * Get connected client count for monitoring
   */
  getConnectedClientCount(): number {
    return this.server.engine.clientsCount;
  }

  /**
   * Get subscribed clients by room
   */
  getSubscribersForRoom(room: string): number {
    const roomKey = `marketplace:${room}`;
    const socketSet = this.server.sockets.adapter.rooms.get(roomKey);
    return socketSet ? socketSet.size : 0;
  }
}
