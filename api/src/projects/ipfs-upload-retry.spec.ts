import axios, { AxiosError } from 'axios';
import { uploadToIpfsWithRetry } from './ipfs-upload-retry.util';

function axiosErrorWithStatus(status: number): AxiosError {
  const err = new Error(`Request failed with status ${status}`) as AxiosError;
  err.isAxiosError = true;
  err.response = { status } as AxiosError['response'];
  return err;
}

describe('uploadToIpfsWithRetry', () => {
  beforeAll(() => {
    jest
      .spyOn(axios, 'isAxiosError')
      .mockImplementation(
        (payload: unknown): payload is AxiosError =>
          (payload as AxiosError)?.isAxiosError === true,
      );
  });

  it('retries on 503 twice then succeeds on the third attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(axiosErrorWithStatus(503))
      .mockRejectedValueOnce(axiosErrorWithStatus(503))
      .mockResolvedValueOnce({ IpfsHash: 'bafy123' });

    const result = await uploadToIpfsWithRetry(fn);

    expect(result).toEqual({ IpfsHash: 'bafy123' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on 400 without retrying', async () => {
    const fn = jest.fn().mockRejectedValueOnce(axiosErrorWithStatus(400));

    await expect(uploadToIpfsWithRetry(fn)).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
