import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  resolveCoachConfig,
  resolveCredential,
} from '../src/auth';
import { endpointForCredential } from '../src/index';

/**
 * v2.2.5 security regression: a credential owned by the deployment
 * (ACCESS_CODE / server-side .env key) must never be forwarded to an endpoint
 * chosen by the client; only browser-provided (BYOK) keys may use a relay.
 */
describe('v2.2.5 credential endpoint isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('only BYOK credentials may use a custom endpoint', () => {
    expect(endpointForCredential('byok', 'https://relay.example/v1')).toBe('https://relay.example/v1');
    expect(endpointForCredential('byok', undefined)).toBeUndefined();
    expect(endpointForCredential('server', 'https://evil.example/v1')).toBeUndefined();
    expect(endpointForCredential('server', undefined)).toBeUndefined();
  });

  it('resolveCredential reports whether a key is BYOK or the deployment key', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-host-deepseek');
    vi.stubEnv('ACCESS_CODE', 'code123');
    expect(resolveCredential({ provider: 'deepseek', apiKey: 'sk-mine' }).source).toBe('byok');
    expect(resolveCredential({ provider: 'deepseek', accessCode: 'code123' }).source).toBe('server');
  });

  it('server DeepSeek key for coaching ignores a client-supplied relay', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-host-deepseek');
    vi.stubEnv('ACCESS_CODE', 'code123');
    const config = resolveCoachConfig({
      provider: 'deepseek',
      reviewMode: 'deepseek',
      accessCode: 'code123',
      coachBaseUrl: 'https://evil.example/v1',
      coachModel: 'evil-model',
    });
    expect(config.baseUrl).toBe(DEEPSEEK_BASE_URL);
    expect(config.model).toBe(DEEPSEEK_MODEL);
    expect(config.apiKey).toBe('sk-host-deepseek');
  });

  it('BYOK deepseek coaching may still use its own relay', () => {
    const config = resolveCoachConfig({
      provider: 'deepseek',
      reviewMode: 'deepseek',
      coachApiKey: 'sk-mine',
      coachBaseUrl: 'https://my-relay.example/v1',
      coachModel: 'deepseek-chat',
    });
    expect(config.baseUrl).toBe('https://my-relay.example/v1');
    expect(config.model).toBe('deepseek-chat');
    expect(config.apiKey).toBe('sk-mine');
  });

  it('the deployment key still requires a valid access code', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-host-deepseek');
    vi.stubEnv('ACCESS_CODE', 'code123');
    expect(() =>
      resolveCoachConfig({ provider: 'deepseek', reviewMode: 'deepseek', accessCode: 'wrong' }),
    ).toThrowError(/口令/);
  });
});
