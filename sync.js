// sync.js — offline write queue with last-write-wins conflict resolution.
// Shared by any page that writes to Supabase (lists.js, creditcards.js, ...).
// Sits at the app root alongside dom.js.
//
// How it works:
// - Every write carries a client-set `updated_at` timestamp (the moment the
//   edit was made, not when it finally reached the network).
// - If offline, or the request fails, the write is queued in localStorage
//   and retried later — on reconnect, on an interval, and once on load.
// - Updates use a conditional WHERE updated_at <= :mine, so a late-arriving
//   offline write can never overwrite a change that happened more recently
//   elsewhere. If the condition fails, the row already has a newer value —
//   that's a correctly-lost race, not an error, so nothing is retried.

const QUEUE_KEY = 'thecabin_pending_ops';
let queue = loadQueue();
let flushing = false;

function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
    catch (e) { return []; }
}

function saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) {}
}

export function pendingCount() {
    return queue.length;
}

// Returns an ISO timestamp to stamp on a payload at the moment of the edit.
export function nowStamp() {
    return new Date().toISOString();
}

// op: { table, type: 'insert' | 'update' | 'delete', id, idColumn, payload }
// - insert: payload is the full row to insert (include updated_at: nowStamp())
// - update: payload is the patch (must include updated_at: nowStamp())
// - delete: id + idColumn only
export async function writeOrQueue(sb, op) {
    if (navigator.onLine) {
        const ok = await trySend(sb, op);
        if (ok) return { ok: true, queued: false };
    }
    queue.push(op);
    saveQueue();
    return { ok: false, queued: true };
}

async function trySend(sb, op) {
    try {
        if (op.type === 'insert') {
            const { error } = await sb.from(op.table).insert(op.payload);
            if (error) throw error;
        } else if (op.type === 'update') {
            const { error } = await sb.from(op.table)
                .update(op.payload)
                .eq(op.idColumn || 'id', op.id)
                .lte('updated_at', op.payload.updated_at)
                .select();
            if (error) throw error;
            // An empty result here means a newer write already exists server-side.
            // That's the conflict resolving correctly, not a failure — don't retry.
        } else if (op.type === 'delete') {
            const { error } = await sb.from(op.table).delete().eq(op.idColumn || 'id', op.id);
            if (error) throw error;
        }
        return true;
    } catch (err) {
        console.warn('Sync: write failed, will retry later:', op, err);
        return false; // network/server error — keep queued
    }
}

export async function flushQueue(sb, onChange) {
    if (flushing || !navigator.onLine || !queue.length) return;
    flushing = true;

    const remaining = [];
    for (const op of queue) {
        const ok = await trySend(sb, op);
        if (!ok) remaining.push(op);
    }
    queue = remaining;
    saveQueue();
    flushing = false;
    if (onChange) onChange(queue.length);
}

// Call once per page, after sb is available.
// onChange(count) fires whenever the pending count changes — wire it to
// setStatus or a small badge so people know a change hasn't synced yet.
export function initSync(sb, { onChange } = {}) {
    window.addEventListener('online', () => flushQueue(sb, onChange));
    // Some mobile browsers don't reliably fire 'online' — poll as a backstop.
    setInterval(() => flushQueue(sb, onChange), 20000);
    flushQueue(sb, onChange); // try once immediately on load
    if (onChange) onChange(queue.length);
}

// Whether a given row id currently has a queued-but-not-yet-sent write.
// Use this when merging fresh server/realtime data into local state, so a
// reload doesn't overwrite an edit that's still waiting to sync out.
export function hasPendingWrite(table, id) {
    return queue.some(op => op.table === table && op.id === id);
}

// Returns the queued op for a row (or undefined). Lets callers branch on
// op.type — e.g. don't resurrect a row that's pending delete, do keep a
// row that's pending insert even though the server doesn't have it yet.
export function getPendingOp(table, id) {
    return queue.find(op => op.table === table && op.id === id);
}
