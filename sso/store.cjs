const crypto = require('node:crypto');

// Every value is encrypted, including temporary PKCE flows and task results.
// The database contains no raw bearer tokens, phone numbers or model inputs.
function codec(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('会话加密密钥必须为 32 字节');
  return {
    encode(value, aad) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(aad)); return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]); },
    decode(bytes, aad) { const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(bytes.subarray(-16)); return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString()); }
  };
}
class MemoryStore {
  constructor({now = Date.now, key = crypto.randomBytes(32)} = {}) { this.now = now; this.codec = codec(key); this.rows = new Map(); this.locks = new Map(); this.kind = 'memory'; }
  async init() {}
  async close() {}
  id(ns, key) { return crypto.createHash('sha256').update(ns + ':' + key).digest('hex'); }
  async get(ns, key) { const id = this.id(ns, key), row = this.rows.get(id); return row && row.expires > this.now() ? this.codec.decode(row.value, id) : null; }
  async atomic(ns, key, fn) {
    const id = this.id(ns, key), previous = this.locks.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const row = this.rows.get(id), value = await this.get(ns, key), change = await fn(value);
      if (Object.hasOwn(change, 'value')) {
        if (change.value === null) this.rows.delete(id);
        else this.rows.set(id, {value: this.codec.encode(change.value, id), expires: change.expires ?? row?.expires ?? this.now() + 86400000});
      }
      // Bounded test/dev memory; production uses MySQL.
      for (const [k, v] of this.rows) if (v.expires <= this.now()) this.rows.delete(k);
      if (this.rows.size > 20000) throw new Error('会话存储容量已满');
      return change.result;
    });
    this.locks.set(id, operation);
    try { return await operation; } finally { if (this.locks.get(id) === operation) this.locks.delete(id); }
  }
  put(ns, key, value, expires) { return this.atomic(ns, key, () => ({value, expires})); }
  take(ns, key) { return this.atomic(ns, key, value => ({value: null, result: value})); }
}
class MysqlStore {
  constructor({pool, key, namespace, now = Date.now}) { this.pool = pool; this.codec = codec(key); this.namespace = namespace; this.now = now; this.kind = 'mysql'; this.nextPrune = 0; this.pruning = null; }
  id(ns, key) { return crypto.createHash('sha256').update(this.namespace + ':' + ns + ':' + key).digest('hex'); }
  async init() {
    await this.pool.execute('CREATE TABLE IF NOT EXISTS zhangmen_state (id CHAR(64) PRIMARY KEY, payload LONGBLOB NULL, expires BIGINT NOT NULL, INDEX zhangmen_expiry(expires)) ENGINE=InnoDB');
    await this.prune();
  }
  async prune() {
    if(this.pruning)return this.pruning;
    if(this.now()<this.nextPrune)return;
    this.pruning=this.pool.execute('DELETE FROM zhangmen_state WHERE expires < ? LIMIT 1000',[this.now()]);
    try{await this.pruning;this.nextPrune=this.now()+60000;}finally{this.pruning=null;}
  }
  async close() { await this.pruning; await this.pool.end(); }
  async get(ns, key) {
    await this.prune();
    const id = this.id(ns, key), [rows] = await this.pool.execute('SELECT payload, expires FROM zhangmen_state WHERE id = ?', [id]);
    const row = rows[0]; return row?.payload && Number(row.expires) > this.now() ? this.codec.decode(row.payload, id) : null;
  }
  async atomic(ns, key, fn) {
    await this.prune();
    const id = this.id(ns, key), connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('INSERT INTO zhangmen_state(id,payload,expires) VALUES(?,NULL,0) ON DUPLICATE KEY UPDATE id=id', [id]);
      const [rows] = await connection.execute('SELECT payload,expires FROM zhangmen_state WHERE id = ? FOR UPDATE', [id]), row = rows[0];
      const value = row.payload && Number(row.expires) > this.now() ? this.codec.decode(row.payload, id) : null;
      const change = await fn(value);
      if (Object.hasOwn(change, 'value')) {
        if (change.value === null) await connection.execute('DELETE FROM zhangmen_state WHERE id = ?', [id]);
        else await connection.execute('UPDATE zhangmen_state SET payload = ?, expires = ? WHERE id = ?', [this.codec.encode(change.value, id), change.expires ?? (Number(row.expires) || this.now() + 86400000), id]);
      }
      await connection.commit(); return change.result;
    } catch (error) { await connection.rollback().catch(() => {}); throw error; }
    finally { connection.release(); }
  }
  put(ns, key, value, expires) { return this.atomic(ns, key, () => ({value, expires})); }
  take(ns, key) { return this.atomic(ns, key, value => ({value: null, result: value})); }
}
module.exports = {MemoryStore, MysqlStore, codec};
