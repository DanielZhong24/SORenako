"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Redis = require("ioredis");
class KvStore {
    redis;
    redisReady;
    memoryStore;
    memorySets;
    constructor(redisUrl) {
        this.redis = new Redis(redisUrl || undefined);
        this.redisReady = false;
        this.memoryStore = new Map();
        this.memorySets = new Map();
        this.redis.on("ready", () => {
            this.redisReady = true;
            // eslint-disable-next-line no-console
            console.log("Redis ready");
        });
        this.redis.on("error", (err) => {
            // eslint-disable-next-line no-console
            console.warn("[ioredis] error:", err && err.message ? err.message : err);
            this.redisReady = false;
        });
    }
    async get(key) {
        if (this.redisReady) {
            try {
                return await this.redis.get(key);
            }
            catch (_err) {
                // fall through to memory store
            }
        }
        return this.memoryStore.get(key) ?? null;
    }
    async set(key, value) {
        if (this.redisReady) {
            try {
                return await this.redis.set(key, value);
            }
            catch (_err) {
                // fall through to memory store
            }
        }
        this.memoryStore.set(key, value);
        return "OK";
    }
    async del(key) {
        if (this.redisReady) {
            try {
                return await this.redis.del(key);
            }
            catch (_err) {
                // fall through to memory store
            }
        }
        return this.memoryStore.delete(key) ? 1 : 0;
    }
    async sadd(key, member) {
        if (this.redisReady) {
            try {
                return await this.redis.sadd(key, member);
            }
            catch (_err) {
                // fall through to memory set
            }
        }
        const current = this.memorySets.get(key) ?? new Set();
        current.add(member);
        this.memorySets.set(key, current);
        return 1;
    }
    async srem(key, member) {
        if (this.redisReady) {
            try {
                return await this.redis.srem(key, member);
            }
            catch (_err) {
                // fall through to memory set
            }
        }
        const current = this.memorySets.get(key);
        if (!current)
            return 0;
        const existed = current.delete(member);
        if (current.size === 0) {
            this.memorySets.delete(key);
        }
        return existed ? 1 : 0;
    }
    async smembers(key) {
        if (this.redisReady) {
            try {
                const members = await this.redis.smembers(key);
                return members || [];
            }
            catch (_err) {
                // fall through to memory set
            }
        }
        const current = this.memorySets.get(key);
        return current ? Array.from(current) : [];
    }
}
function createKvStore(redisUrl) {
    return new KvStore(redisUrl);
}
module.exports = {
    createKvStore,
};
//# sourceMappingURL=store.js.map