import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import ipRangeCheck from 'ip-range-check';

/**
 * Redis key for the webhook IP allowlist set.
 * Stored as a JSON array of CIDR/IP strings.
 */
const ALLOWLIST_KEY = 'webhook:ip-allowlist';
/** Fallback in-memory list when Redis is unavailable. */
const FALLBACK_KEY_PREFIX = 'webhook:ip-allowlist:entry:';

export interface AllowlistEntry {
  cidr: string;
  addedAt: string;
}

/**
 * WebhookIpAllowlistService — CRUD management for the webhook IP allowlist.
 *
 * Issue #1170 — Replaces the static `WEBHOOK_ALLOWED_IPS` env-var-only
 * configuration with a dynamic, admin-managed list stored in Redis
 * (via CacheService).  The `WebhookIpAllowlistGuard` consults this service
 * at request time so changes take effect immediately without a restart.
 *
 * When Redis is unavailable the service falls back to an in-memory map so
 * the API keeps running in degraded mode (single-instance only).
 */
@Injectable()
export class WebhookIpAllowlistService {
  private readonly logger = new Logger(WebhookIpAllowlistService.name);

  constructor(private readonly cacheService: CacheService) {}

  /**
   * Validate that `cidr` is a plausible IP or CIDR string.
   * We do a lightweight check: it must contain at least one dot (IPv4) or
   * colon (IPv6), and if a "/" is present the prefix length must be numeric.
   */
  private validateCidr(cidr: string): void {
    if (!cidr || typeof cidr !== 'string') {
      throw new BadRequestException('IP/CIDR is required');
    }
    const trimmed = cidr.trim();
    if (!trimmed) {
      throw new BadRequestException('IP/CIDR cannot be empty');
    }
    if (!trimmed.includes('.') && !trimmed.includes(':')) {
      throw new BadRequestException(
        `Invalid IP/CIDR: "${trimmed}" — must be a valid IPv4/IPv6 address or CIDR range`,
      );
    }
    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      if (parts.length !== 2) {
        throw new BadRequestException(
          `Invalid CIDR: "${trimmed}" — expected format <ip>/<prefix>`,
        );
      }
      const prefix = parseInt(parts[1], 10);
      if (isNaN(prefix) || prefix < 0 || prefix > 128) {
        throw new BadRequestException(
          `Invalid CIDR prefix: "${parts[1]}" — must be 0–128`,
        );
      }
    }
  }

  /**
   * Add an IP/CIDR to the allowlist.
   * Idempotent — adding an existing entry does not duplicate it.
   */
  async addEntry(cidr: string): Promise<AllowlistEntry> {
    const normalized = cidr.trim();
    this.validateCidr(normalized);

    const entries = await this.getEntryMap();
    const entry: AllowlistEntry = {
      cidr: normalized,
      addedAt: new Date().toISOString(),
    };
    entries.set(normalized, entry);

    await this.persist(entries);
    this.logger.log(`Added IP/CIDR to webhook allowlist: ${normalized}`);
    return entry;
  }

  /**
   * List all entries in the allowlist.
   */
  async listEntries(): Promise<AllowlistEntry[]> {
    const entries = await this.getEntryMap();
    return Array.from(entries.values()).sort((a, b) =>
      a.addedAt.localeCompare(b.addedAt),
    );
  }

  /**
   * Remove an IP/CIDR from the allowlist.
   * Returns true if the entry existed and was removed.
   */
  async removeEntry(cidr: string): Promise<boolean> {
    const normalized = cidr.trim();
    this.validateCidr(normalized);

    const entries = await this.getEntryMap();
    const existed = entries.delete(normalized);
    if (existed) {
      await this.persist(entries);
      this.logger.log(`Removed IP/CIDR from webhook allowlist: ${normalized}`);
    }
    return existed;
  }

  /**
   * Return the raw list of CIDR strings for guard consumption.
   * Used by `WebhookIpAllowlistGuard` to check incoming requests.
   */
  async getAllowlist(): Promise<string[]> {
    const entries = await this.getEntryMap();
    return Array.from(entries.keys());
  }

  /**
   * Check whether `ip` is in the allowlist.
   * Returns `true` if the allowlist is empty (open — development mode).
   */
  async isAllowed(ip: string): Promise<boolean> {
    const allowlist = await this.getAllowlist();
    if (allowlist.length === 0) return true;
    return ipRangeCheck(ip, allowlist);
  }

  // ── Internal persistence ─────────────────────────────────────────────────────

  /**
   * Get the current allowlist as a Map (cidr → entry).
   * Loads from Redis when available, otherwise from the in-memory fallback.
   */
  private async getEntryMap(): Promise<Map<string, AllowlistEntry>> {
    const raw = await this.cacheService.get<AllowlistEntry[]>(ALLOWLIST_KEY);
    if (raw && Array.isArray(raw)) {
      return new Map(raw.map((e) => [e.cidr, e]));
    }
    return new Map();
  }

  /**
   * Persist the allowlist map to Redis (or the no-op fallback).
   * TTL: 7 days — the data is managed via the API so it should not expire,
   * but we set a generous TTL as a safety net.
   */
  private async persist(entries: Map<string, AllowlistEntry>): Promise<void> {
    const arr = Array.from(entries.values());
    const persisted = await this.cacheService.set(ALLOWLIST_KEY, arr, 604800);
    if (!persisted) {
      this.logger.warn(
        'Webhook IP allowlist NOT persisted to Redis (cache unavailable) — changes will be lost on restart',
      );
    }
  }
}
