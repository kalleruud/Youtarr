// In-memory stand-in for representationStore with the same lease, revision
// and idempotency rules, so the facade can be exercised with real files and
// interleaved (concurrent) callers.
const { RepresentationLeaseErrorClass, RevisionErrorClass } = (() => {
  class RepresentationLeaseError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  class RepresentationRevisionError extends Error {
    constructor(currentRevision) { super('revision conflict'); this.code = 'REVISION_CONFLICT'; this.currentRevision = currentRevision; }
  }
  return { RepresentationLeaseErrorClass: RepresentationLeaseError, RevisionErrorClass: RepresentationRevisionError };
})();

const tick = () => new Promise(resolve => setImmediate(resolve));

function createFakeStore() {
  let nextId = 1;
  let owners = 0;
  const rows = [];
  const heads = new Map();
  const head = (id) => {
    if (!heads.has(id)) heads.set(id, { revision: 0, selected: null, owner: null });
    return heads.get(id);
  };
  const view = (row) => ({ ...row });
  const checkLease = (lease, expectedRevision) => {
    const h = head(lease.youtubeId);
    if (h.owner !== lease.owner) throw new RepresentationLeaseErrorClass('LEASE_LOST', 'lost');
    if (expectedRevision !== undefined && expectedRevision !== h.revision) throw new RevisionErrorClass(h.revision);
    return h;
  };
  return {
    rows,
    heads,
    RepresentationLeaseError: RepresentationLeaseErrorClass,
    RepresentationRevisionError: RevisionErrorClass,
    async getHead(id) { await tick(); const h = head(id); return { revision: h.revision, selectedRepresentationId: h.selected, lease: h.owner ? { operation: h.operation } : null }; },
    async list(id) { await tick(); return rows.filter(r => r.youtubeId === id).map(view); },
    async listPublishedStreamLocations() { return new Map(rows.filter(r => r.kind === 'strm' && r.state === 'published').map(r => [r.youtubeId, r.location])); },
    async acquireLease(id, operation, { waitMs = 0 } = {}) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        await tick();
        const h = head(id);
        if (!h.owner) {
          h.owner = `owner-${++owners}`;
          h.operation = operation;
          return { youtubeId: id, owner: h.owner, operation };
        }
        if (Date.now() >= deadline) throw new RepresentationLeaseErrorClass('LEASE_BUSY', 'busy');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    async releaseLease(lease) {
      await tick();
      const h = head(lease.youtubeId);
      if (h.owner === lease.owner) { h.owner = null; h.operation = null; }
    },
    async record(lease, { kind, variant = '', state, location = null, sizeBytes = null, detail = null }, { expectedRevision } = {}) {
      await tick();
      const h = checkLease(lease, expectedRevision);
      const existing = rows.find(r => r.youtubeId === lease.youtubeId && r.kind === kind && r.variant === variant);
      if (existing && existing.state === state && existing.location === location
        && existing.sizeBytes === sizeBytes && existing.detail === detail) {
        return { changed: false, representation: view(existing), revision: h.revision };
      }
      let row = existing;
      if (row) Object.assign(row, { state, location, sizeBytes, detail, revision: row.revision + 1 });
      else {
        row = { id: nextId++, youtubeId: lease.youtubeId, kind, variant, state, location, sizeBytes, detail, revision: 1 };
        rows.push(row);
      }
      h.revision += 1;
      return { changed: true, representation: view(row), revision: h.revision };
    },
    async select(lease, representationId, { expectedRevision } = {}) {
      await tick();
      const h = checkLease(lease, expectedRevision);
      if (representationId != null && !rows.some(r => r.id === representationId && r.youtubeId === lease.youtubeId)) {
        throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
      }
      if (h.selected === representationId) return { changed: false, revision: h.revision };
      h.selected = representationId;
      h.revision += 1;
      return { changed: true, revision: h.revision };
    },
  };
}

module.exports = { createFakeStore };
