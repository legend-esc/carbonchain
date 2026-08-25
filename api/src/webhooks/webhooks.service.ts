import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import axios, { AxiosError } from 'axios';
import { CacheService } from '../common/cache.service';

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: Date;
  lastTriggeredAt?: Date;
  failureCount: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
}

const WEBHOOKS_KEY = 'webhooks:registry';
const DELIVERIES_KEY = 'webhooks:deliveries';
const DELIVERY_QUEUE_KEY = 'webhooks:queue';

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);
  private webhooks: Map<string, Webhook> = new Map();
  private deliveries: Map<string, WebhookDelivery> = new Map();
  private readonly MAX_RETRIES = 5;
  private readonly BASE_RETRY_DELAY_MS = 1000;
  private readonly signatureHeaderName: string;
  private readonly signatureAlgorithm: string;
  private isProcessingQueue = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
  ) {
    this.signatureHeaderName =
      this.configService.get<string>('WEBHOOK_SIGNATURE_HEADER') ||
      'x-mrv-signature';
    this.signatureAlgorithm =
      this.configService.get<string>('WEBHOOK_SIGNATURE_ALGO') || 'sha256';
  }

  async onModuleInit(): Promise<void> {
    await this.loadFromDurableStore();
  }

  private async loadFromDurableStore(): Promise<void> {
    try {
      const stored = await this.cache.get<Webhook[]>(WEBHOOKS_KEY);
      if (stored) {
        this.webhooks = new Map(stored.map((w) => [w.id, w]));
        this.logger.log(
          `Loaded ${this.webhooks.size} webhooks from durable store`,
        );
      }

      const storedDeliveries =
        await this.cache.get<WebhookDelivery[]>(DELIVERIES_KEY);
      if (storedDeliveries) {
        this.deliveries = new Map(storedDeliveries.map((d) => [d.id, d]));
        this.logger.log(
          `Loaded ${this.deliveries.size} deliveries from durable store`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to load webhooks from durable store: ${(err as Error).message}`,
      );
    }
  }

  private async persistWebhooks(): Promise<void> {
    try {
      await this.cache.set(
        WEBHOOKS_KEY,
        Array.from(this.webhooks.values()),
        86400,
      );
    } catch (err) {
      this.logger.warn(`Failed to persist webhooks: ${(err as Error).message}`);
    }
  }

  private async persistDeliveries(): Promise<void> {
    try {
      await this.cache.set(
        DELIVERIES_KEY,
        Array.from(this.deliveries.values()),
        86400,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to persist deliveries: ${(err as Error).message}`,
      );
    }
  }

  registerWebhook(url: string, events: string[]): Webhook {
    const id = `webhook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const webhook: Webhook = {
      id,
      url,
      events,
      active: true,
      createdAt: new Date(),
      failureCount: 0,
    };
    this.webhooks.set(id, webhook);
    this.persistWebhooks();
    this.logger.log(
      `Registered webhook ${id} for events: ${events.join(', ')}`,
    );
    return webhook;
  }

  getWebhooks(): Webhook[] {
    return Array.from(this.webhooks.values());
  }

  getWebhook(id: string): Webhook | undefined {
    return this.webhooks.get(id);
  }

  deleteWebhook(id: string): boolean {
    const deleted = this.webhooks.delete(id);
    if (deleted) {
      this.persistWebhooks();
    }
    return deleted;
  }

  async triggerWebhooks(eventType: string, eventData: any): Promise<void> {
    const matchingWebhooks = Array.from(this.webhooks.values()).filter(
      (w) => w.active && w.events.includes(eventType),
    );

    for (const webhook of matchingWebhooks) {
      const deliveryId = `delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const delivery: WebhookDelivery = {
        id: deliveryId,
        webhookId: webhook.id,
        eventId: eventData.id || 'unknown',
        status: 'pending',
        attempts: 0,
        nextRetryAt: new Date(),
      };

      this.deliveries.set(deliveryId, delivery);
      await this.enqueueDelivery(webhook, delivery, eventType, eventData);
      await this.persistDeliveries();
    }
  }

  private async enqueueDelivery(
    webhook: Webhook,
    delivery: WebhookDelivery,
    eventType: string,
    eventData: any,
  ): Promise<void> {
    try {
      const job = { webhook, delivery, eventType, eventData };
      await this.cache.set(`${DELIVERY_QUEUE_KEY}:${delivery.id}`, job, 3600);
      this.logger.debug(
        `Enqueued webhook delivery ${delivery.id} for ${webhook.url}`,
      );
    } catch (err) {
      this.logger.warn(`Failed to enqueue delivery: ${(err as Error).message}`);
    }
  }

  async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return;
    }
    this.isProcessingQueue = true;
    try {
      const pendingDeliveries = Array.from(this.deliveries.values()).filter(
        (d) =>
          d.status === 'pending' &&
          (!d.nextRetryAt || d.nextRetryAt <= new Date()),
      );

      for (const delivery of pendingDeliveries) {
        const webhook = this.webhooks.get(delivery.webhookId);
        if (webhook) {
          await this.attemptDelivery(webhook, delivery, 'retry', {
            deliveryId: delivery.id,
          });
        }
      }
      await this.persistDeliveries();
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async attemptDelivery(
    webhook: Webhook,
    delivery: WebhookDelivery,
    eventType: string,
    eventData: any,
  ): Promise<void> {
    delivery.attempts++;
    delivery.lastAttemptAt = new Date();

    try {
      await axios.post(webhook.url, {
        type: eventType,
        data: eventData,
        timestamp: new Date().toISOString(),
      });

      delivery.status = 'success';
      webhook.lastTriggeredAt = new Date();
      webhook.failureCount = 0;
      this.logger.log(
        `Webhook ${webhook.id} delivered successfully for event ${eventType}`,
      );
    } catch (error) {
      const axiosError = error as AxiosError;
      webhook.failureCount++;

      if (delivery.attempts < this.MAX_RETRIES) {
        delivery.status = 'pending';
        const backoffMs =
          this.BASE_RETRY_DELAY_MS * Math.pow(2, delivery.attempts - 1);
        delivery.nextRetryAt = new Date(Date.now() + backoffMs);
        this.logger.warn(
          `Webhook ${webhook.id} delivery failed (attempt ${delivery.attempts}/${this.MAX_RETRIES}), retrying at ${delivery.nextRetryAt}`,
        );
      } else {
        delivery.status = 'failed';
        webhook.active = false;
        this.logger.error(
          `Webhook ${webhook.id} delivery failed after ${this.MAX_RETRIES} attempts: ${axiosError.message}`,
        );
      }
    }
  }

  getDeliveries(webhookId?: string): WebhookDelivery[] {
    let deliveries = Array.from(this.deliveries.values());
    if (webhookId) {
      deliveries = deliveries.filter((d) => d.webhookId === webhookId);
    }
    return deliveries;
  }

  generateSignature(payload: string, secret: string): string {
    return createHmac(this.signatureAlgorithm, secret)
      .update(payload)
      .digest('hex');
  }

  getSignatureHeaderName(): string {
    return this.signatureHeaderName;
  }

  getSignatureAlgorithm(): string {
    return this.signatureAlgorithm;
  }
}
