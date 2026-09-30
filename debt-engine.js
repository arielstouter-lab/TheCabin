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

// Typical card minimum: the greater of a flat floor or X% of the balance
// (plus that month's interest if addsInterest), never more than is owed.
export function minimumPayment({ balance, apr, minPct = 1, minFloor = 35, addsInterest = true }) {
    const bal = Number(balance) || 0;
    if (bal <= EPS) return 0;
    const interest = (bal * (Number(apr) || 0)) / 1200;
    const raw = Math.max(minFloor, (bal * minPct) / 100 + (addsInterest ? interest : 0));
    return Math.min(bal + interest, raw);
}

// APR in effect for month `ym`. A promo rate applies from its start month up to,
// but not including, its expiration month (so the regular rate is charged in the
// month the promo expires — the conservative choice). A promo with no
// expiration lasts indefinitely; one with no start applies immediately.
export function effectiveApr(d, ym) {
    const regular = Number(d.apr) || 0;
    if (d.promoApr == null || d.promoApr === '') return regular;
    const i = ymToIndex(ym);
    if (d.promoStartYm && i < ymToIndex(d.promoStartYm)) return regular;
    if (d.promoEndYm && i >= ymToIndex(d.promoEndYm)) return regular;
    return Number(d.promoApr) || 0;
}

// Scheduled (regular) payment for one debt this month, capped at what's owed.
function scheduledPayment(d, balance, interest, rate) {
    const owed = balance + interest;
    if (owed <= EPS) return 0;
    let p;
    if (d.paymentOverride > 0) p = d.paymentOverride;
    else if (d.kind === 'mortgage' && d.piPayment > 0) p = d.piPayment;
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

// debts: [{ id, name, kind, balance, apr, promoApr, promoStartYm, promoEndYm,
//           minPct, minFloor, addsInterest,
//           paymentOverride, inBudget, piPayment, pmiAmount, targetBalance }]
//   inBudget   — the regular payment is already inside the Budget's spending,
//                so it isn't deducted from the money available again.
//   pmiAmount/targetBalance — PMI is paid (from the Budget) until the balance
//                reaches targetBalance; after that it becomes free money.
// monthlyMoney — default money available per month (Budget Net Balance)
// overrides    — { 'YYYY-MM': amount } replaces the default for that month
// mode         — 'plan' (extra money applied) | 'minimums' (no extra at all)
// pmiFirst     — put extra money on the mortgage until the PMI target is hit
export function simulate({
                             debts, monthlyMoney = 0, overrides = {}, startYm,
                             strategy = 'avalanche', pmiFirst = false, mode = 'plan', maxMonths = MAX_MONTHS
                         }) {
    const ds = debts.filter(d => (Number(d.balance) || 0) > EPS).map(d => ({
        id: d.id, name: d.name, kind: d.kind, apr: Number(d.apr) || 0, rate: Number(d.apr) || 0,
        promoApr: d.promoApr ?? null, promoStartYm: d.promoStartYm || null, promoEndYm: d.promoEndYm || null,
        minPct: d.minPct ?? 1, minFloor: d.minFloor ?? 35, addsInterest: d.addsInterest !== false,
        paymentOverride: d.paymentOverride > 0 ? d.paymentOverride : 0,
        inBudget: !!d.inBudget, piPayment: Number(d.piPayment) || 0,
        pmiAmount: d.pmiAmount > 0 && d.targetBalance > 0 ? d.pmiAmount : 0,
        targetBalance: Number(d.targetBalance) || 0,
        bal: Number(d.balance), B: null, paidOffYm: null, interestTotal: 0,
        pmiActive: false, pmiAlreadyMet: false, pmiDropYm: null, cur: null
    }));
    ds.forEach(d => {
        if (d.pmiAmount > 0) {
            d.pmiActive = d.bal > d.targetBalance + EPS;
            d.pmiAlreadyMet = !d.pmiActive;
        }
    });

    const rows = [];
    let totalInterest = 0, totalPmi = 0, totalShortfall = 0, month = 0;

    while (ds.some(d => d.bal > EPS) && month < maxMonths) {
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
            if (d.pmiAmount > 0) {
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

        // 4) extra money goes to the target debt(s), overflowing to the next
        if (extraPool > EPS) {
            const active = ds.filter(d => d.bal > EPS).sort(byStrategy(strategy));
            const pay = (d, cap) => {
                const amt = Math.min(extraPool, cap, d.bal);
                if (amt <= 0) return;
                d.bal -= amt; d.cur.extra += amt; extraPool -= amt;
            };
            if (pmiFirst) {
                for (const d of active) {
                    if (d.pmiActive && d.bal > d.targetBalance + EPS) pay(d, d.bal - d.targetBalance);
                }
            }
            for (const d of active) {
                if (extraPool <= EPS) break;
                pay(d, d.bal);
            }
        }

        // 5) bookkeeping: payoffs and PMI target
        for (const d of ds) {
            if (d.bal <= EPS) {
                d.bal = 0;
                if (d.paidOffYm == null) { d.paidOffYm = ym; events.push(`${d.name} paid off`); }
            }
            if (d.pmiAmount > 0 && d.pmiActive && d.bal <= d.targetBalance + EPS) {
                d.pmiActive = false; d.pmiDropYm = ym;
                events.push('PMI target reached');
            }
        }

        totalInterest += monthInterest;
        totalPmi += pmiPaid;
        rows.push({
            month, ym, available, interest: monthInterest, pmiPaid, shortfall,
            leftover: Math.max(0, extraPool), events,
            totalBalance: ds.reduce((s, d) => s + d.bal, 0),
            balances: Object.fromEntries(ds.map(d => [d.id, d.bal])),
            pay: Object.fromEntries(ds.map(d => [d.id, { regular: d.cur.regular, extra: d.cur.extra }]))
        });
    }

    const paid = d => d.paidOffYm != null;
    const latest = list => list.reduce((m, d) => (m == null || ymToIndex(d.paidOffYm) > ymToIndex(m) ? d.paidOffYm : m), null);
    const nonMort = ds.filter(d => d.kind !== 'mortgage');
    const pmiDebts = ds.filter(d => d.pmiAmount > 0);
    const pmiDebt = pmiDebts[0];

    return {
        rows, months: month, completed: ds.every(paid),
        totalInterest, totalPmi, totalCost: totalInterest + totalPmi, totalShortfall,
        consumerCount: nonMort.length,
        consumerFreeYm: nonMort.length && nonMort.every(paid) ? latest(nonMort) : null,
        debtFreeYm: ds.length && ds.every(paid) ? latest(ds) : null,
        hasPmi: !!pmiDebt,
        pmiAlreadyMet: !!pmiDebt && pmiDebt.pmiAlreadyMet,
        // first month PMI is no longer paid
        pmiFreeYm: !pmiDebt ? null : pmiDebt.pmiAlreadyMet ? addMonths(startYm, 1) : pmiDebt.pmiDropYm ? addMonths(pmiDebt.pmiDropYm, 1) : null,
        debts: ds.map(d => ({ id: d.id, name: d.name, kind: d.kind, paidOffYm: d.paidOffYm, interestTotal: d.interestTotal }))
    };
}