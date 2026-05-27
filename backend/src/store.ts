declare const require: any;
declare const module: any;

const Redis = require("ioredis");

type KvValue = string | null;

class KvStore {
  private redis: any;
  private redisReady: boolean;
  private memoryStore: Map<string, string>;
  private memorySets: Map<string, Set<string>>;

  constructor(redisUrl?: string) {
    this.redis = new Redis(redisUrl || undefined);
    this.redisReady = false;
    this.memoryStore = new Map<string, string>();
    this.memorySets = new Map<string, Set<string>>();

    this.redis.on("ready", () => {
      this.redisReady = true;
      // eslint-disable-next-line no-console
      console.log("Redis ready");
    });

    this.redis.on("error", (err: any) => {
      // eslint-disable-next-line no-console
      console.warn("[ioredis] error:", err && err.message ? err.message : err);
      this.redisReady = false;
    });
  }

  async get(key: string): Promise<KvValue> {
    if (this.redisReady) {
      try {
        return await this.redis.get(key);
      } catch (_err) {
        // fall through to memory store
      }
    }
    return this.memoryStore.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    if (this.redisReady) {
      try {
        return await this.redis.set(key, value);
      } catch (_err) {
        // fall through to memory store
      }
    }
    this.memoryStore.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    if (this.redisReady) {
      try {
        return await this.redis.del(key);
      } catch (_err) {
        // fall through to memory store
      }
    }
    return this.memoryStore.delete(key) ? 1 : 0;
  }

  async sadd(key: string, member: string): Promise<number> {
    if (this.redisReady) {
      try {
        return await this.redis.sadd(key, member);
      } catch (_err) {
        // fall through to memory set
      }
    }
    const current = this.memorySets.get(key) ?? new Set<string>();
    current.add(member);
    this.memorySets.set(key, current);
    return 1;
  }

  async srem(key: string, member: string): Promise<number> {
    if (this.redisReady) {
      try {
        return await this.redis.srem(key, member);
      } catch (_err) {
        // fall through to memory set
      }
    }
    const current = this.memorySets.get(key);
    if (!current) return 0;
    const existed = current.delete(member);
    if (current.size === 0) {
      this.memorySets.delete(key);
    }
    return existed ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    if (this.redisReady) {
      try {
        const members = await this.redis.smembers(key);
        return members || [];
      } catch (_err) {
        // fall through to memory set
      }
    }
    const current = this.memorySets.get(key);
    return current ? Array.from(current) : [];
  }
}

function createKvStore(redisUrl?: string) {
  return new KvStore(redisUrl);
}

module.exports = {
  createKvStore,
};
