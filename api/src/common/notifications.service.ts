import { Injectable, Logger } from '@nestjs/common';

/**
 * Per-user notification opt-in preferences.
 *
 * TODO: persist via TypeORM entity (a `notification_preferences` table) so
 * preferences survive service restarts.
 */
export interface NotificationPreferences {
  offer_filled: boolean;
  credit_approved: boolean;
  mrv_alert: boolean;
  email?: string;
  unsubscribeToken?: string;
}

export type NotificationEvent =
  | 'offer_filled'
  | 'credit_approved'
  | 'mrv_alert';

/**
 * NotificationsService
 *
 * Stores per-user opt-in preferences (keyed by Stellar address) and dispatches
 * async notifications.  The current dispatch implementation logs the notification;
 * real delivery via SendGrid/Resend is a TODO.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /** In-memory preference store keyed by Stellar address. */
  private readonly prefs = new Map<string, NotificationPreferences>();

  /**
   * Return stored preferences for `address`, or sensible defaults if none
   * have been set yet.
   */
  getPreferences(address: string): NotificationPreferences {
    return (
      this.prefs.get(address) ?? {
        offer_filled: true,
        credit_approved: true,
        mrv_alert: true,
      }
    );
  }

  /**
   * Merge `patch` into the stored preferences for `address`.
   * Generates an `unsubscribeToken` (UUID v4) the first time preferences are
   * saved if one is not already present.
   */
  updatePreferences(
    address: string,
    patch: Partial<NotificationPreferences>,
  ): NotificationPreferences {
    const current = this.getPreferences(address);
    const updated: NotificationPreferences = { ...current, ...patch };

    if (!updated.unsubscribeToken) {
      updated.unsubscribeToken = crypto.randomUUID();
    }

    this.prefs.set(address, updated);
    this.logger.debug(`Preferences updated for ${address}`);
    return updated;
  }

  /**
   * Dispatch a notification to `address` for `event`.
   *
   * - Checks the user's opt-in flag for the event type.
   * - Logs the notification (TODO: replace with SendGrid/Resend call).
   * - If an email address is stored, logs the email template content
   *   including the unsubscribe token.
   */
  async dispatch(
    address: string,
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const prefs = this.getPreferences(address);

    if (!prefs[event]) {
      this.logger.debug(
        `[notify] user=${address} event=${event} skipped (opted out)`,
      );
      return;
    }

    this.logger.log(
      `[notify] user=${address} event=${event} payload=${JSON.stringify(payload)}`,
    );

    if (prefs.email) {
      // TODO: replace with real email delivery via SendGrid/Resend.
      this.logger.log(
        `[notify:email] to=${prefs.email} event=${event} ` +
          `unsubscribe_token=${prefs.unsubscribeToken ?? 'n/a'} ` +
          `payload=${JSON.stringify(payload)}`,
      );
    }
  }
}
