// Pure debt math — no DOM, no Supabase. Safe to test in Node.
//
// Months are 'YYYY-MM' strings. A snapshot month is the month the balances
// were recorded; the projection's first payment month is the month after it.

export const MAX_MONTHS = 600; // 50 years — the simulation gives up after this
const EPS = 0.005;

// ---------------------------------------------------------------- months
export const ymToIndex = ym => {
    const [y, m] = String(ym).split('-').map(Number);
    return y * 12 + (m - 1);
};
export const indexToYm = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const addMonths = (ym, n) => indexToYm(ymToIndex(ym) + n);
export const isYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));

// ----------------------------------------------------------- exact dates
const DAY_MS = 86400000;
const daysInMonth = ym => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
// 'YYYY-MM-DD' -> whole days since the epoch (null if it isn't a valid date)
const dayNumber = iso => {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return null;
    return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
};

// APR charged in month `ym`, blended by day when a promo starts or ends inside
// that month. promoStart / promoEnd are 'YYYY-MM-DD'; the expiration date is the
// last day the promo rate applies. A promo with no start applies from the
// beginning; one with no expiration lasts indefinitely.
export function effectiveApr(d, ym) {
    const regular = Number(d.apr) || 0;
    if (d.promoApr == null || d.promoApr === '') return regular;
    const [y, m] = ym.split('-').map(Number);
    const first = Math.floor(Date.UTC(y, m - 1, 1) / DAY_MS);
    const n = daysInMonth(ym);
    const last = first + n - 1;
    const from = dayNumber(d.promoStart);
    const to = dayNumber(d.promoEnd);
    const lo = from == null ? first : Math.max(first, from);
    const hi = to == null ? last : Math.min(last, to);
    const promoDays = Math.max(0, hi - lo + 1);
    if (promoDays <= 0) return regular;
    const promo = Number(d.promoApr) || 0;
    return (promo * promoDays + regular * (n - promoDays)) / n;
}

// ------------------------------------------------------- payment formulas
// Fixed principal-and-interest payment for a fully amortizing loan.
export function amortizedPayment(principal, aprPct, termMonths) {
    const P = Number(principal) || 0;
    const n = Math.round(Number(termMonths) || 0);
    if (P <= 0 || n <= 0) return 0;
    const r = (Number(aprPct) || 0) / 1200;
    if (r === 0) return P / n;
    return (P * r) / (1 - Math.pow(1 + r, -n));
}
export const mortgagePayment = amortizedPayment; // older name

// Typical card minimum: the greater of a flat floor or X% of the balance
// (plus that month's interest if addsInterest), never more than is owed.
export function minimumPayment({ balance, apr, minPct = 1, minFloor = 35, addsInterest = true }) {
    const bal = Number(balance) || 0;
    if (bal <= EPS) return 0;
    const interest = (bal * (Number(apr) || 0)) / 1200;
    const raw = Math.max(minFloor, (bal * minPct) / 100 + (addsInterest ? interest : 0));
    return Math.min(bal + interest, raw);
}

// Scheduled (regular) payment for one debt this month, capped at what's owed.
function scheduledPayment(d, balance, interest, rate) {
    const owed = balance + interest;
    if (owed <= EPS) return 0;
    let p;
    if (d.paymentOverride != null && d.paymentOverride >= 0) p = d.paymentOverride;
    else if (d.piPayment > 0) p = d.piPayment; // mortgages and amortizing loans
    else p = minimumPayment({ balance, apr: rate, minPct: d.minPct, minFloor: d.minFloor, addsInterest: d.addsInterest });
    return Math.min(owed, p);
}

// ------------------------------------------------------ amortization table
// Original schedule from the first payment month: [{ n, ym, payment, interest, principal, balance }]
export function amortizationSchedule({ principal, aprPct, termMonths, firstPaymentYm, payment }) {
    const P = Number(principal) || 0;
    const n = Math.round(Number(termMonths) || 0);
    if (P <= 0 || n <= 0 || !isYm(firstPaymentYm)) return [];
    const r = (Number(aprPct) || 0) / 1200;
    const pmt = payment > 0 ? payment : amortizedPayment(P, aprPct, n);
    const rows = [];
    let bal = P;
    for (let k = 1; k <= n && bal > EPS; k++) {
        const interest = bal * r;
        let princ = pmt - interest;
        if (k === n || princ > bal) princ = bal;
        bal -= princ;
        if (k === n || bal < EPS) bal = 0;
        rows.push({ n: k, ym: addMonths(firstPaymentYm, k - 1), payment: princ + interest, interest, principal: princ, balance: bal });
    }
    return rows;
}

// Scheduled balance after all payments due through `ym`.
export function scheduledBalanceAt(schedule, principal, ym) {
    let bal = Number(principal) || 0;
    for (const row of schedule) {
        if (ymToIndex(row.ym) <= ymToIndex(ym)) bal = row.balance;
        else break;
    }
    return bal;
}

// -------------------------------------------------------------- simulation
const byStrategy = strategy =>
    strategy === 'snowball'
        ? (a, b) => a.bal - b.bal || b.rate - a.rate // smallest balance first
        : (a, b) => b.rate - a.rate || a.bal - b.bal; // highest current rate first

// debts: [{ id, name, kind, balance, apr, promoApr, promoStart, promoEnd,
//           minPct, minFloor, addsInterest, paymentOverride, inBudget,
//           piPayment, pmiAmount, targetBalance }]
//   inBudget   — the regular payment is already inside the Budget's spending,
//                so it isn't deducted from the money available again.
//   pmiAmount/targetBalance — PMI is paid (from the Budget) until the balance
//                reaches targetBalance; after that it becomes free money.
// monthlyMoney — default money available per month (Budget Net Balance)
// overrides    — { 'YYYY-MM': amount } replaces the default for that month
// order        — debt ids, highest priority first. Extra money goes to the first
//                debt until it is paid off, then overflows down the list. Debts
//                not listed follow, ordered by `strategy`.
// stopAtPmi    — debt ids whose extra payments stop at their PMI target; after
//                that they only get extra money once every other debt is paid.
// anchors      — { 'YYYY-MM': { [debtId]: { balance, apr, promoApr, promoStart,
//                promoEnd, paymentOverride, piPayment } } }. At the end of that
//                month the snapshot's actual figures replace the projection.
// mode         — 'plan' (extra money applied) | 'minimums' (no extra at all)
export function simulate({
                             debts, monthlyMoney = 0, overrides = {}, startYm,
                             strategy = 'avalanche', order = [], stopAtPmi = [], anchors = {},
                             mode = 'plan', maxMonths = MAX_MONTHS
                         }) {
    const stopSet = new Set(stopAtPmi.map(String));
    const orderIds = order.map(String);

    const ds = debts.map(d => ({
        id: d.id, name: d.name, kind: d.kind, apr: Number(d.apr) || 0, rate: Number(d.apr) || 0,
        promoApr: d.promoApr ?? null, promoStart: d.promoStart || null, promoEnd: d.promoEnd || null,
        minPct: d.minPct ?? 1, minFloor: d.minFloor ?? 35, addsInterest: d.addsInterest !== false,
        paymentOverride: d.paymentOverride != null && Number(d.paymentOverride) >= 0 ? Number(d.paymentOverride) : null,
        inBudget: !!d.inBudget, piPayment: Number(d.piPayment) || 0,
        pmiAmount: d.pmiAmount > 0 && d.targetBalance > 0 ? d.pmiAmount : 0,
        targetBalance: Number(d.targetBalance) || 0,
        bal: Math.max(0, Number(d.balance) || 0), B: null, paidOffYm: null, interestTotal: 0,
        everActive: false, firstActiveYm: null,
        pmiActive: false, pmiAlreadyMet: false, pmiDropYm: null, cur: null
    }));
    ds.forEach(d => {
        if (d.bal > EPS) {
            d.everActive = true;
            d.firstActiveYm = startYm;
            if (d.pmiAmount > 0) {
                d.pmiActive = d.bal > d.targetBalance + EPS;
                d.pmiAlreadyMet = !d.pmiActive;
            }
        }
    });

    const anchorMonths = Object.keys(anchors).filter(isYm).sort();
    const lastAnchorOffset = anchorMonths.length
        ? ymToIndex(anchorMonths[anchorMonths.length - 1]) - ymToIndex(startYm)
        : -Infinity;

    const rows = [];
    let totalInterest = 0, totalPmi = 0, totalShortfall = 0, month = 0;

    while ((ds.some(d => d.bal > EPS) || month < lastAnchorOffset) && month < maxMonths) {
        month++;
        const ym = addMonths(startYm, month);
        const events = [];
        let fromPool = 0, freedBudget = 0, monthInterest = 0;

        // 1) interest accrues, regular payments are made
        for (const d of ds) {
            if (d.bal <= EPS) {
                d.bal = 0;
                d.cur = { interest: 0, regular: 0, extra: 0 };
                if (d.inBudget && d.B) freedBudget += d.B; // paid off: its budgeted payment is free
                continue;
            }
            d.rate = effectiveApr(d, ym);
            const interest = (d.bal * d.rate) / 1200;
            const sched = scheduledPayment(d, d.bal, interest, d.rate);
            if (d.inBudget) {
                if (d.B == null) d.B = sched;
                fromPool += Math.max(0, sched - d.B);
                freedBudget += Math.max(0, d.B - sched);
            } else {
                fromPool += sched;
            }
            d.bal = d.bal + interest - sched;
            d.cur = { interest, regular: sched, extra: 0 };
            d.interestTotal += interest;
            monthInterest += interest;
        }

        // 2) PMI is paid this month, or has already dropped and is now free money
        let pmiPaid = 0, pmiFreed = 0;
        for (const d of ds) {
            if (d.pmiAmount > 0 && d.everActive) {
                if (d.pmiActive) pmiPaid += d.pmiAmount;
                else pmiFreed += d.pmiAmount;
            }
        }

        // 3) money available -> extra after regular payments
        let available = null, extraPool = 0, shortfall = 0;
        if (mode === 'plan') {
            const base = overrides[ym] != null ? Number(overrides[ym]) : Number(monthlyMoney);
            available = Math.max(0, base) + freedBudget + pmiFreed;
            extraPool = available - fromPool;
            if (extraPool < 0) { shortfall = -extraPool; totalShortfall += shortfall; extraPool = 0; }
        }

        // 4) extra money goes down the payoff order, overflowing to the next debt
        if (extraPool > EPS) {
            const cmp = byStrategy(strategy);
            const rankOf = d => { const i = orderIds.indexOf(String(d.id)); return i < 0 ? Infinity : i; };
            const queue = ds.filter(d => d.bal > EPS).sort((a, b) => (rankOf(a) - rankOf(b)) || cmp(a, b));
            const pay = (d, cap) => {
                const amt = Math.min(extraPool, cap, d.bal);
                if (amt <= 0) return;
                d.bal -= amt; d.cur.extra += amt; extraPool -= amt;
            };
            const deferred = [];
            for (const d of queue) {
                if (extraPool <= EPS) break;
                if (stopSet.has(String(d.id)) && d.pmiAmount > 0) {
                    // only up to the PMI target; whatever is left of it waits until the others are paid
                    if (d.pmiActive && d.bal > d.targetBalance + EPS) pay(d, d.bal - d.targetBalance);
                    deferred.push(d);
                } else {
                    pay(d, d.bal);
                }
            }
            for (const d of deferred) {
                if (extraPool <= EPS) break;
                pay(d, d.bal);
            }
        }

        // 5) bookkeeping: payoffs and PMI targets
        for (const d of ds) {
            if (d.bal <= EPS) {
                d.bal = 0;
                if (d.everActive && d.paidOffYm == null) { d.paidOffYm = ym; events.push(`${d.name} paid off`); }
            }
            if (d.pmiAmount > 0 && d.pmiActive && d.bal <= d.targetBalance + EPS) {
                d.pmiActive = false; d.pmiDropYm = ym;
                events.push(`PMI target reached (${d.name})`);
            }
        }

        // 6) a snapshot in this month: its actual figures replace the projection
        const variances = [];
        if (anchors[ym]) {
            for (const [id, a] of Object.entries(anchors[ym])) {
                const d = ds.find(x => String(x.id) === String(id));
                if (!d) continue;
                const projected = d.bal;
                const actual = Math.max(0, Number(a.balance) || 0);
                variances.push({ id: d.id, name: d.name, projected, actual });
                d.bal = actual;
                d.apr = Number(a.apr) || 0;
                d.promoApr = a.promoApr ?? null;
                d.promoStart = a.promoStart || null;
                d.promoEnd = a.promoEnd || null;
                d.paymentOverride = a.paymentOverride != null && Number(a.paymentOverride) >= 0 ? Number(a.paymentOverride) : null;
                if (a.piPayment != null) d.piPayment = Number(a.piPayment) || 0;
                if (actual > EPS) {
                    if (!d.everActive) { d.everActive = true; d.firstActiveYm = ym; }
                    if (d.paidOffYm != null) {
                        // the projection had paid it off, but the snapshot says it is still owed
                        d.paidOffYm = null;
                        const i = events.indexOf(`${d.name} paid off`);
                        if (i >= 0) events.splice(i, 1);
                    }
                } else if (d.everActive && d.paidOffYm == null) {
                    d.paidOffYm = ym;
                    events.push(`${d.name} paid off`);
                }
                if (d.pmiAmount > 0) {
                    d.pmiActive = actual > d.targetBalance + EPS;
                    if (d.pmiActive) { d.pmiDropYm = null; d.pmiAlreadyMet = false; }
                    else if (d.pmiDropYm == null) d.pmiDropYm = ym;
                }
            }
        }

        totalInterest += monthInterest;
        totalPmi += pmiPaid;
        rows.push({
            month, ym, available, interest: monthInterest, pmiPaid, shortfall,
            leftover: Math.max(0, extraPool), events, anchor: variances,
            totalBalance: ds.reduce((s, d) => s + d.bal, 0),
            balances: Object.fromEntries(ds.map(d => [d.id, d.bal])),
            pay: Object.fromEntries(ds.map(d => [d.id, { regular: d.cur ? d.cur.regular : 0, extra: d.cur ? d.cur.extra : 0 }]))
        });
    }

    const seen = ds.filter(d => d.everActive);
    const paid = d => d.paidOffYm != null;
    const latest = list => list.reduce((m, d) => (m == null || ymToIndex(d.paidOffYm) > ymToIndex(m) ? d.paidOffYm : m), null);
    const nonMort = seen.filter(d => d.kind !== 'mortgage');

    return {
        rows, months: month, completed: seen.every(paid),
        totalInterest, totalPmi, totalCost: totalInterest + totalPmi, totalShortfall,
        consumerCount: nonMort.length,
        consumerFreeYm: nonMort.length && nonMort.every(paid) ? latest(nonMort) : null,
        debtFreeYm: seen.length && seen.every(paid) ? latest(seen) : null,
        // one entry per debt with PMI modelled; freeYm is the first month PMI is no longer paid
        pmi: seen.filter(d => d.pmiAmount > 0).map(d => ({
            id: d.id, name: d.name, alreadyMet: d.pmiAlreadyMet,
            freeYm: d.pmiAlreadyMet ? addMonths(startYm, 1) : d.pmiDropYm ? addMonths(d.pmiDropYm, 1) : null
        })),
        debts: seen.map(d => ({ id: d.id, name: d.name, kind: d.kind, paidOffYm: d.paidOffYm, interestTotal: d.interestTotal, firstActiveYm: d.firstActiveYm }))
    };
}