// sync.js — offline write outbox with last-write-wins conflict resolution.
// Shared by any page that writes to Supabase (lists, moving, creditcards, ...).
// Sits in SharedJS alongside dom.js.
//
// How it works (write-ahead outbox):
// - Every write is stamped with a client-side `updated_at` (the moment of the
//   edit, not when it reaches the network) and is saved to localStorage
//   FIRST. writeOrQueue() returns immediately; it never waits on the network.
//   That means the UI can never hang on a weak "one bar" connection, and an
//   edit can't be lost if the tab is closed or killed mid-request.
// - A background flush sends ops one at a time, in order, and only removes an
//   op once the server accepted it. It runs right after each write, on
//   reconnect, when the page becomes visible, and on a 20s interval.
// - Updates use a conditional WHERE updated_at <= :mine, so a late-arriving
//   offline write can never overwrite a newer change made elsewhere. An empty
//   result there is a correctly-lost race, not an error.
// - Re-sending an op is always safe: inserts that already landed come back as
//   a duplicate-primary-key error, which is treated as success; updates,
//   upserts and deletes are idempotent.
// - Network failures/timeouts stop the flush and keep everything queued
//   (order preserved). Ops the server actively rejects (constraint/RLS errors)
//   are retried a few times, then parked in a separate "failed" list so one
//   bad op can't block the whole queue forever.

const QUEUE_KEY = 'thecabin_pending_ops';
const FAILED_KEY = 'thecabin_failed_ops';
const SEND_TIMEOUT_MS = 8000;        // give up on a single request after this
const RETRY_COOLDOWN_MS = 10000;     // after a network failure, don't re-hammer on every write
const MAX_REJECTIONS = 5;
const PENDING_BADGE_DELAY_MS = 1500; // don't flash "pending" for edits that sync instantly
const POLL_MS = 20000;

let queue = loadList(QUEUE_KEY);
let flushing = false;
let lastNetworkFailure = 0;
let notifyTimer = null;
const ctx = { sb: null, onChange: null, onFlushed: null };

function loadList(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; }
    catch (e) { return []; }
}

function saveList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
}

function saveQueue() { saveList(QUEUE_KEY, queue); }

export function pendingCount() {
    return queue.length;
}

// Ops the server rejected repeatedly (kept so nothing is silently lost).
export function failedOps() {
    return loadList(FAILED_KEY);
}

// Returns an ISO timestamp to stamp on a payload at the moment of the edit.
export function nowStamp() {
    return new Date().toISOString();
}

// Reject if a promise takes longer than ms. Handy for reads (loadAll).
export function withTimeout(promise, ms, label = 'Request') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function notify() {
    clearTimeout(notifyTimer);
    if (!ctx.onChange) return;
    if (queue.length === 0) { ctx.onChange(0); return; }
    notifyTimer = setTimeout(() => { if (ctx.onChange) ctx.onChange(queue.length); }, PENDING_BADGE_DELAY_MS);
}

// op: { table, type: 'insert' | 'update' | 'upsert' | 'delete' | 'rpc', id, idColumn, payload, options }
// - insert: payload is the full row to insert (include a client-generated id)
// - upsert: payload is the row (include updated_at: nowStamp()), options: { onConflict }
// - update: payload is the patch (include updated_at: nowStamp() when the table has it)
// - delete: id + idColumn only
// - rpc:    fn + args
//
// Resolves immediately with { ok: true, queued: true } once the op is safely
// stored. Use pendingCount()/initSync's onChange to know whether it has synced.
export function writeOrQueue(sb, op) {
    if (!ctx.sb) ctx.sb = sb;
    queue.push(op);
    saveQueue();
    notify();
    flushQueue(sb); // fire and forget
    return Promise.resolve({ ok: true, queued: true });
}

function sendOnce(sb, op, signal) {
    const col = op.idColumn || 'id';
    switch (op.type) {
        case 'insert':
            return sb.from(op.table).insert(op.payload).abortSignal(signal);
        case 'upsert':
            return sb.from(op.table)
                .upsert(op.payload, op.options || { onConflict: col })
                .abortSignal(signal);
        case 'update': {
            let q = sb.from(op.table).update(op.payload).eq(col, op.id);
            // Only tables that carry updated_at get the last-write-wins guard.
            if (op.payload && op.payload.updated_at) q = q.lte('updated_at', op.payload.updated_at);
            return q.select().abortSignal(signal);
            // An empty result means a newer write already exists server-side.
            // That's the conflict resolving correctly, not a failure.
        }
        case 'delete':
            return sb.from(op.table).delete().eq(col, op.id).abortSignal(signal);
        case 'rpc':
            // No single-row identity (e.g. a bulk reorder): no conflict check,
            // retried until it succeeds. Each op should carry a full snapshot.
            return sb.rpc(op.fn, op.args).abortSignal(signal);
        default:
            return Promise.resolve({ error: { code: 'CLIENT_UNKNOWN_OP', message: `Unknown op type: ${op.type}` } });
    }
}

// Returns 'ok' | 'network' | 'retry' | 'rejected'
//  ok       – server accepted it (or it already had it)
//  network  – offline / timeout / fetch failure: keep queued, stop flushing
//  retry    – auth token problem: keep queued, stop flushing
//  rejected – server answered with a real error (constraint, RLS, ...)
async function trySend(sb, op) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
        const res = await sendOnce(sb, op, controller.signal);
        if (!res || !res.error) return 'ok';

        const err = res.error;
        // An earlier attempt landed (e.g. it timed out client-side but the
        // server got it). Same primary key = already inserted = success.
        if (op.type === 'insert' && err.code === '23505' && /pkey/i.test(err.message || '')) return 'ok';
        if (res.status === 401 || err.code === 'PGRST301' || /jwt/i.test(err.message || '')) return 'retry';
        if (!err.code) return 'network'; // fetch-level failures carry no Postgres/PostgREST code
        console.warn('Sync: server rejected write:', op, err);
        return 'rejected';
    } catch (err) {
        return 'network';
    } finally {
        clearTimeout(timer);
    }
}

function park(op) {
    const failed = loadList(FAILED_KEY);
    failed.push({ ...op, parkedAt: nowStamp() });
    saveList(FAILED_KEY, failed);
    console.error('Sync: giving up on op after repeated rejections (saved in thecabin_failed_ops):', op);
}

export async function flushQueue(sb = ctx.sb, { force = false } = {}) {
    if (flushing || !sb || !navigator.onLine || !queue.length) return;
    if (!force && Date.now() - lastNetworkFailure < RETRY_COOLDOWN_MS) return;

    flushing = true;
    let sentAny = false;
    try {
        let i = 0;
        // New writes during the flush are appended to the end and picked up here.
        while (i < queue.length) {
            const op = queue[i];
            const result = await trySend(sb, op);

            if (result === 'ok') {
                queue.splice(i, 1);
                sentAny = true;
                lastNetworkFailure = 0;
            } else if (result === 'rejected') {
                op.attempts = (op.attempts || 0) + 1;
                if (op.attempts >= MAX_REJECTIONS) {
                    park(op);
                    queue.splice(i, 1);
                } else {
                    i++; // leave it for a later flush, keep going
                }
            } else {
                lastNetworkFailure = Date.now();
                break; // offline / timeout / auth: stop here, keep order
            }
            saveQueue();
        }
    } finally {
        saveQueue();
        flushing = false;
        notify();
    }
    if (sentAny && ctx.onFlushed) ctx.onFlushed();
}

// Call once per page, after sb is available.
// onChange(count)  – pending count changed (wire to setStatus / a badge).
// onFlushed()      – at least one queued op reached the server (good moment
//                    to refresh from the server).
export function initSync(sb, { onChange, onFlushed } = {}) {
    ctx.sb = sb;
    ctx.onChange = onChange || null;
    ctx.onFlushed = onFlushed || null;

    const flush = () => flushQueue(sb, { force: true });
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') flush();
    });
    // Some mobile browsers don't reliably fire 'online' — poll as a backstop.
    setInterval(flush, POLL_MS);
    flush();
    notify();
}

// Which op types are queued for a row (a Set, possibly empty). Use this when
// merging fresh server/realtime data into local state so a reload doesn't
// overwrite an edit that's still waiting to sync:
//   has('delete')  → don't resurrect the row
//   has('update')  → keep the local version
//   has('insert')  → keep the row even though the server doesn't have it yet
export function pendingTypes(table, id) {
    return new Set(queue.filter(op => op.table === table && op.id === id).map(op => op.type));
}

export function hasPendingWrite(table, id) {
    return queue.some(op => op.table === table && op.id === id);
}

// First queued op for a row (kept for existing callers; prefer pendingTypes).
export function getPendingOp(table, id) {
    return queue.find(op => op.table === table && op.id === id);
}