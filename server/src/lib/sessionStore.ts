import type { Redis } from 'ioredis';
import { redis } from './redis.js';

export interface PkceStateData {
  codeVerifier: string;
  iss: string;
  launch?: string;
  createdAt: number;
}

export interface UserSessionData {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  patientId: string;
  fhirUser?: string;
  scope: string;
  idToken?: string;
  iss?: string;
  createdAt: number;
}

export class SessionStore {
  private redis: Redis;
  private readonly pkcePrefix = 'pkce:';
  private readonly sessionPrefix = 'session:';
  public readonly defaultPkceTtlSeconds = 300; // 5 minutes
  public readonly defaultSessionTtlSeconds = 3600; // 1 hour

  constructor(redisClient: Redis) {
    this.redis = redisClient;
  }

  /**
   * Saves a PKCE state before redirecting to the EHR authorization endpoint.
   * Auto-expires in `ttlSeconds` (default 5 minutes).
   */
  async savePkceState(
    state: string,
    data: PkceStateData,
    ttlSeconds: number = this.defaultPkceTtlSeconds
  ): Promise<void> {
    const key = this.pkcePrefix + state;
    const value = JSON.stringify(data);
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  /**
   * Atomically fetches and deletes a PKCE state (One-Time Consume Pattern).
   * Prevents replay attacks by ensuring the secret can only be read once.
   */
  async consumePkceState(state: string): Promise<PkceStateData | null> {
    const key = this.pkcePrefix + state;
    // Redis 6.2+ GETDEL command: atomically returns the value and deletes the key
    const raw = await this.redis.getdel(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as PkceStateData;
    } catch {
      return null;
    }
  }

  /**
   * Stores a new user session containing the EHR FHIR access token and patient context.
   * Keyed by random sessionId with TTL set to token validity (in seconds).
   */
  async createSession(
    sessionId: string,
    data: UserSessionData,
    ttlSeconds: number = this.defaultSessionTtlSeconds
  ): Promise<void> {
    const key = this.sessionPrefix + sessionId;
    const value = JSON.stringify(data);
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  /**
   * Retrieves an active session by sessionId. Returns null if expired or not found.
   */
  async getSession(sessionId: string): Promise<UserSessionData | null> {
    const key = this.sessionPrefix + sessionId;
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as UserSessionData;
    } catch {
      return null;
    }
  }

  /**
   * Updates the TTL of an active session (e.g. sliding session window or token refresh).
   */
  async touchSession(sessionId: string, newTtlSeconds: number): Promise<boolean> {
    const key = this.sessionPrefix + sessionId;
    const result = await this.redis.expire(key, newTtlSeconds);
    return result === 1;
  }

  /**
   * Returns remaining TTL in seconds for a session (-2 if key does not exist, -1 if no TTL).
   */
  async getSessionTtl(sessionId: string): Promise<number> {
    const key = this.sessionPrefix + sessionId;
    return await this.redis.ttl(key);
  }

  /**
   * Explicitly terminates a user session (e.g. logout).
   */
  async destroySession(sessionId: string): Promise<boolean> {
    const key = this.sessionPrefix + sessionId;
    const result = await this.redis.del(key);
    return result > 0;
  }
}

export const sessionStore = new SessionStore(redis);
