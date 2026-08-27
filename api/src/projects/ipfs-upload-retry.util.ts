import axios, { AxiosError } from 'axios';
import { Logger } from '@nestjs/common';

const logger = new Logger('IpfsUploadRetry');

const RETRYABLE_STATUS_CODES = new Set([429, 503]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return true; // network/timeout errors: retry
  const status = (err as AxiosError).response?.status;
  if (status === 400 || status === 401) return false;
  if (status == null) return true; // network timeout, no response
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Issue #359 follow-up: Pinata uploads had no retry, so a single transient
 * 503 lost the project submission. Mirrors the exponential-backoff pattern
 * used in StellarService.submitTransactionWithRetry (100ms, 200ms, 400ms).
 *
 * Not yet wired into ProjectsService.uploadToIpfs — swap the raw axios.post
 * call there for uploadToIpfsWithRetry() and add the pending_uploads
 * fallback table/background job described in the issue.
 */
export async function uploadToIpfsWithRetry<T>(
  requestFn: () => Promise<T>,
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await requestFn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) {
        throw err;
      }

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn(
        `Pinata upload failed, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}
