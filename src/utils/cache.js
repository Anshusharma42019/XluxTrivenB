class MemoryCache {
  constructor(maxSize = 1000, pruneIntervalMs = 60000) {
    this.cache = new Map();
    this.maxSize = maxSize;

    // Periodically prune expired items to prevent memory leaks
    if (pruneIntervalMs > 0) {
      this.pruneInterval = setInterval(() => this.prune(), pruneIntervalMs);
      // unref the timer so it doesn't block the Node process from exiting
      if (this.pruneInterval && typeof this.pruneInterval.unref === 'function') {
        this.pruneInterval.unref();
      }
    }
  }

  /**
   * Store a value in the cache with a specified TTL.
   * Evicts the oldest item if the maximum cache size is reached.
   * @param {string} key 
   * @param {any} value 
   * @param {number} ttlSeconds 
   */
  set(key, value, ttlSeconds) {
    // If the key exists, delete it first to renew its order position
    this.cache.delete(key);

    // Evict oldest (least recently used) if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const expiresAt = Date.now() + (ttlSeconds * 1000);
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * Retrieve a value from the cache. Returns null if expired or not found.
   * Moves accessed keys to the end of the Map (LRU order logic).
   * @param {string} key 
   * @returns {any|null}
   */
  get(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Refresh insertion order (re-insert key to mark it as recently used)
    this.cache.delete(key);
    this.cache.set(key, cached);

    return cached.value;
  }

  /**
   * Delete a specific key from the cache.
   * @param {string} key 
   */
  del(key) {
    this.cache.delete(key);
  }

  /**
   * Flush the entire cache.
   */
  flush() {
    this.cache.clear();
  }

  /**
   * Delete all keys matching a specific substring/pattern.
   * Useful for pattern-based cache invalidation.
   * @param {string} pattern 
   */
  delPattern(pattern) {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Remove all expired entries from memory.
   */
  prune() {
    const now = Date.now();
    for (const [key, cached] of this.cache.entries()) {
      if (now > cached.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

export const cache = new MemoryCache();
