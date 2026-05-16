//js/cache.js
export class APICache {
    constructor(options = {}) {
        this.memoryCache = new Map();
        this.maxSize = options.maxSize || 500;
        this.ttl = options.ttl || 1000 * 60 * 60 * 24; // Default 24 hours
        this.dbName = 'monochrome-cache';
        this.dbVersion = 1;
        this.db = null;
        this.initDB().catch(console.error);
    }

    async initDB() {
        if (typeof indexedDB === 'undefined') return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains('responses')) {
                    const store = db.createObjectStore('responses', { keyPath: 'key' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    generateKey(type, params) {
        const paramString = typeof params === 'object' ? JSON.stringify(params) : String(params);
        return `${type}:${paramString}`;
    }

    async get(type, params) {
        const key = this.generateKey(type, params);

        if (this.memoryCache.has(key)) {
            const cached = this.memoryCache.get(key);
            const effectiveTTL = cached.ttl || this.ttl;
            if (Date.now() - cached.timestamp < effectiveTTL) {
                return cached.data;
            }
            this.memoryCache.delete(key);
        }

        if (this.db) {
            try {
                const cached = await this.getFromIndexedDB(key);
                if (cached) {
                    const effectiveTTL = cached.ttl || this.ttl;
                    if (Date.now() - cached.timestamp < effectiveTTL) {
                        this.memoryCache.set(key, cached);
                        return cached.data;
                    }
                }
            } catch (error) {
                console.log('IndexedDB read error:', error);
            }
        }

        return null;
    }

    async set(type, params, data, customTTL) {
        const key = this.generateKey(type, params);
        const entry = {
            key,
            data,
            timestamp: Date.now(),
            ttl: customTTL,
        };

        this.memoryCache.set(key, entry);

        if (this.memoryCache.size > this.maxSize) {
            const firstKey = this.memoryCache.keys().next().value;
            this.memoryCache.delete(firstKey);
        }

        if (this.db) {
            try {
                await this.setInIndexedDB(entry);
            } catch (error) {
                console.log('IndexedDB write error:', error);
            }
        }
    }

    getFromIndexedDB(key) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                resolve(null);
                return;
            }

            const transaction = this.db.transaction(['responses'], 'readonly');
            const store = transaction.objectStore('responses');
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    setInIndexedDB(entry) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                resolve();
                return;
            }

            const transaction = this.db.transaction(['responses'], 'readwrite');
            const store = transaction.objectStore('responses');
            const request = store.put(entry);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async clear() {
        this.memoryCache.clear();

        if (this.db) {
            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction(['responses'], 'readwrite');
                const store = transaction.objectStore('responses');
                const request = store.clear();

                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        }
    }

    async clearExpired() {
        const now = Date.now();
        const expired = [];

        for (const [key, entry] of this.memoryCache.entries()) {
            const effectiveTTL = entry.ttl || this.ttl;
            if (now - entry.timestamp >= effectiveTTL) {
                expired.push(key);
            }
        }

        expired.forEach((key) => this.memoryCache.delete(key));

        if (this.db) {
            try {
                const transaction = this.db.transaction(['responses'], 'readwrite');
                const store = transaction.objectStore('responses');
                
                // For IndexedDB, we can't easily query by dynamic TTL per row in a single range request
                // unless we store the expiration timestamp.
                // For now, let's just clear those that are definitely older than the default TTL,
                // and maybe do a full scan or just rely on 'get' to filter them out.
                // A better way would be to store 'expiresAt' field.
                
                const index = store.index('timestamp');
                const range = IDBKeyRange.upperBound(now); // Get all
                const request = index.openCursor(range);

                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        const entry = cursor.value;
                        const effectiveTTL = entry.ttl || this.ttl;
                        if (now - entry.timestamp >= effectiveTTL) {
                            cursor.delete();
                        }
                        cursor.continue();
                    }
                };
            } catch (error) {
                console.log('Failed to clear expired IndexedDB entries:', error);
            }
        }
    }

    getCacheStats() {
        return {
            memoryEntries: this.memoryCache.size,
            maxSize: this.maxSize,
            ttl: this.ttl,
        };
    }
}
