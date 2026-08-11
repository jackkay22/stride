/* A small in-memory stand-in for the Supabase client, covering only the query
   shapes plan-service.js actually uses. Lets the tests exercise the real logic
   without touching the live database. */

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.mode = 'select';
    this._limit = null;
    this._single = false;
    this._returning = false;
    this.payload = null;
  }

  select(cols) {
    if (this.mode === 'select') this.columns = cols || '*';
    else this._returning = true;
    return this;
  }
  insert(rows) { this.mode = 'insert'; this.payload = rows; return this; }
  update(patch) { this.mode = 'update'; this.payload = patch; return this; }
  upsert(row) { this.mode = 'upsert'; this.payload = row; return this; }

  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
  order(c, o) { this.orders.push({ c, asc: o?.ascending !== false }); return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._single = true; return this; }

  #rows() {
    if (!this.store[this.table]) this.store[this.table] = [];
    return this.store[this.table];
  }

  #match(rows) {
    return rows.filter((r) => this.filters.every((f) => f(r)));
  }

  #sort(rows) {
    const out = [...rows];
    for (const { c, asc } of [...this.orders].reverse()) {
      out.sort((a, b) => {
        const x = a[c], y = b[c];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x > y ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    return out;
  }

  #finish(data) {
    if (this._single) {
      if (data.length === 1) return { data: data[0], error: null };
      return { data: null, error: { message: `expected 1 row, got ${data.length}` } };
    }
    return { data, error: null };
  }

  then(resolve, reject) {
    try {
      const rows = this.#rows();
      let result;

      if (this.mode === 'insert' || this.mode === 'upsert') {
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
        const created = incoming.map((r) => ({
          id: uuid(),
          created_at: new Date().toISOString(),
          changed_at: new Date().toISOString(),
          ...r,
        }));
        rows.push(...created);
        result = this.#finish(created);
      } else if (this.mode === 'update') {
        const hit = this.#match(rows);
        for (const r of hit) Object.assign(r, this.payload);
        result = this.#finish(hit);
      } else {
        let data = this.#sort(this.#match(rows));
        if (this._limit !== null) data = data.slice(0, this._limit);
        result = this.#finish(data);
      }
      resolve(result);
    } catch (err) {
      reject(err);
    }
  }
}

export function makeFakeSupabase(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  return {
    store,
    from(table) { return new Query(store, table); },
  };
}
