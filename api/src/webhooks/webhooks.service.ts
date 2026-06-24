import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

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

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private webhooks: Map<string, Webhook> = new Map();
  private deliveries: Map<string, WebhookDelivery> = new Map();
  private readonly MAX_RETRIES = 5;
  private readonly RETRY_DELAY_MS = 5000;

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
    return this.webhooks.delete(id);
  }

  async triggerWebhooks(eventType: string, eventData: any): Promise<void> {
    const matchingWebhooks = Array.from(this.webhooks.values()).filter(
      (w) => w.active && w.events.includes(eventType),
    );

    for (const webhook of matchingWebhooks) {
      await this.deliverWebhook(webhook, eventType, eventData);
    }
  }

  private async deliverWebhook(
    webhook: Webhook,
    eventType: string,
    eventData: any,
  ): Promise<void> {
    const deliveryId = `delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const delivery: WebhookDelivery = {
      id: deliveryId,
      webhookId: webhook.id,
      eventId: eventData.id || 'unknown',
      status: 'pending',
      attempts: 0,
    };

    this.deliveries.set(deliveryId, delivery);
    await this.attemptDelivery(webhook, delivery, eventType, eventData);
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
        delivery.nextRetryAt = new Date(
          Date.now() + this.RETRY_DELAY_MS * delivery.attempts,
        );
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

  async retryFailedDeliveries(): Promise<void> {
    const now = new Date();
    const pendingDeliveries = Array.from(this.deliveries.values()).filter(
      (d) =>
        d.status === 'pending' &&
        d.nextRetryAt &&
        d.nextRetryAt <= now &&
        d.attempts < this.MAX_RETRIES,
    );

    for (const delivery of pendingDeliveries) {
      const webhook = this.webhooks.get(delivery.webhookId);
      if (webhook) {
        await this.attemptDelivery(webhook, delivery, 'retry', {
          deliveryId: delivery.id,
        });
      }
    }
  }
}
