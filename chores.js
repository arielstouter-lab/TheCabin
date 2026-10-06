import { cloneEl, refs, emptyState } from './dom.js';

const DEFAULT_DISLIKE = 5;
const sb = window.supabaseClient;
const TABLES = window.TABLES;

let state = null;
const pendingSaves = {};

function debounceSave(key, fn, delay = 400){
  clearTimeout(pendingSaves[key]);
  pendingSaves[key] = setTimeout(async () => {
    try{
      await fn();
    } catch(e){
      setStatus('Could not save — try again.');
    }
  }, delay);
}

function dislikeOf(chore, personId){
  const d = chore.dislike && chore.dislike[personId];
  return typeof d === 'number' ? d : DEFAULT_DISLIKE;
}

function costFor(chore, personId){
  return chore.timesPerWeek * chore.minutes * dislikeOf(chore, personId);
}

function shareOf(chore, personId){
  const pct = (state.assignments[chore.id] && state.assignments[chore.id][personId]) || 0;
  return Math.round(costFor(chore, personId) * pct / 100);
}

function choreTotalAtCurrentSplit(chore){
  return state.people.reduce((sum,p) => sum + shareOf(chore, p.id), 0);
}

function splitTotal(choreId){
  const a = state.assignments[choreId] || {};
  return Object.values(a).reduce((s,v)=>s+(v||0),0);
}

async function load(){
  try{
    const [{data: people}, {data: chores}, {data: dislikes}, {data: assignments}] = await Promise.all([
      sb.from(TABLES.PEOPLE).select('*').order('created_at'),
      sb.from(TABLES.CHORES).select('*').order('created_at'),
      sb.from(TABLES.CHORE_DISLIKES).select('*'),
      sb.from(TABLES.CHORE_ASSIGNMENTS).select('*')
    ]);

    const chorelist = (chores || []).map(c => ({
      id: c.id,
      name: c.name,
      timesPerWeek: c.times_per_week,
      minutes: c.minutes,
      dislike: {}
    }));
    (dislikes || []).forEach(d => {
      const c = chorelist.find(c => c.id === d.chore_id);
      if(c) c.dislike[d.person_id] = d.dislike;
    });

    const assignMap = {};
    (assignments || []).forEach(a => {
      assignMap[a.chore_id] = assignMap[a.chore_id] || {};
      assignMap[a.chore_id][a.person_id] = a.pct;
    });

    state = {
      people: (people || []).map(p => ({id: p.id, name: p.name})),
      chores: chorelist,
      assignments: assignMap
    };
  } catch(e){
    setStatus('Could not load data.');
    state = {people: [], chores: [], assignments: {}};
  }
  render();
  setupRealtime();
}

function totalsByPerson(){
  const totals = {};
  state.people.forEach(p => totals[p.id] = 0);
  state.chores.forEach(c => {
    state.people.forEach(p => { totals[p.id] += shareOf(c, p.id); });
  });
  return totals;
}

async function autoBalance(){
  if(state.people.length === 0) return;
  const totals = {};
  state.people.forEach(p => totals[p.id] = 0);
  const newAssign = {};

  const sorted = [...state.chores].sort((a,b) => {
    const worstA = Math.max(...state.people.map(p => costFor(a, p.id)), 0);
    const worstB = Math.max(...state.people.map(p => costFor(b, p.id)), 0);
    return worstB - worstA;
  });
  sorted.forEach(chore => {
    let best = state.people[0].id;
    state.people.forEach(p => {
      if(totals[p.id] + costFor(chore, p.id) < totals[best] + costFor(chore, best)) best = p.id;
    });
    newAssign[chore.id] = {[best]: 100};
    totals[best] += costFor(chore, best);
  });

  let guard = 0;
  while(guard++ < 200){
    let maxP = state.people[0].id, minP = state.people[0].id;
    state.people.forEach(p => {
      if(totals[p.id] > totals[maxP]) maxP = p.id;
      if(totals[p.id] < totals[minP]) minP = p.id;
    });
    const diff = totals[maxP] - totals[minP];
    if(diff <= 1 || maxP === minP) break;

    const candidates = state.chores
            .filter(c => newAssign[c.id] && newAssign[c.id][maxP] === 100)
            .sort((a,b) => costFor(a, maxP) - costFor(b, maxP));
    if(candidates.length === 0) break;
    const chore = candidates[0];
    const unitMax = costFor(chore, maxP) / 100;
    const unitMin = costFor(chore, minP) / 100;
    if(unitMax + unitMin <= 0) break;

    const y = diff / (unitMax + unitMin);
    if(y >= 100){
      newAssign[chore.id] = {[minP]: 100};
      totals[maxP] -= costFor(chore, maxP);
      totals[minP] += costFor(chore, minP);
    } else {
      const pctToMin = Math.max(0, Math.min(100, Math.round(y)));
      const pctToMax = 100 - pctToMin;
      newAssign[chore.id] = {[minP]: pctToMin, [maxP]: pctToMax};
      totals[maxP] -= Math.round(costFor(chore, maxP) * pctToMin / 100);
      totals[minP] -= Math.round(costFor(chore, minP) * pctToMin / 100);
      break;
    }
  }

  state.assignments = newAssign;
  render();

  try{
    const choreIds = Object.keys(newAssign);
    if(choreIds.length){
      await sb.from('chore_assignments').delete().in('chore_id', choreIds);
      const rows = choreIds.flatMap(choreId =>
              Object.entries(newAssign[choreId]).map(([personId, pct]) => ({chore_id: choreId, person_id: personId, pct}))
      );
      await sb.from('chore_assignments').insert(rows);
    }
  } catch(e){
    setStatus('Balanced locally, but could not save.');
  }
}

function render(){
  renderBeam();
  renderChores();
  renderPeople();
}

function renderBeam(){
  const beam = document.getElementById('cl-beam');
  const targetLabel = document.getElementById('cl-target-label');
  beam.replaceChildren();

  const totals = totalsByPerson();
  const values = Object.values(totals);
  const max = Math.max(1, ...values);
  const mean = values.length ? values.reduce((a,b)=>a+b,0) / values.length : 0;

  if(state.people.length === 0){
    const label = document.createElement('p');
    label.className = 'cl-beam-label';
    label.textContent = 'Add people to see the balance.';
    beam.append(label);
    if (targetLabel) targetLabel.textContent = '';
    return;
  }
  if (targetLabel) targetLabel.textContent = 'target ≈ ' + Math.round(mean) + ' pts/wk each';

  const label = document.createElement('p');
  label.className = 'cl-beam-label';
  label.textContent = 'Weekly points per person — gold line marks the even split.';
  beam.append(label);

  const frag = document.createDocumentFragment();
  state.people.forEach(p => {
    const t = totals[p.id] || 0;
    const widthPct = max > 0 ? (t / max) * 100 : 0;
    const targetPct = max > 0 ? (mean / max) * 100 : 0;
    const over = mean > 0 && t > mean * 1.15;

    const row = cloneEl('tpl-cl-beam-row');
    const r = refs(row);
    r.name.textContent = p.name;
    r.fill.style.width = `${widthPct}%`;
    if (over) r.fill.classList.add('over');
    r.target.style.left = `${targetPct}%`;
    r.pts.textContent = t;
    frag.append(row);
  });
  beam.append(frag);
}

function renderChores(){
  const list = document.getElementById('cl-chore-list');
  list.replaceChildren();

  if(state.chores.length === 0){
    list.append(emptyState('No chores yet — add one below.'));
    return;
  }

  const frag = document.createDocumentFragment();
  state.chores.forEach(c => {
    const card = cloneEl('tpl-cl-chore-card');
    const r = refs(card);

    card.dataset.row = c.id;

    // Top row
    r.nameInput.value = c.name;
    r.nameInput.dataset.chore = c.id;
    r.ptsBadge.dataset.ptsBadge = c.id;
    r.ptsBadge.textContent = `${choreTotalAtCurrentSplit(c)} pts/wk`;
    r.delBtn.dataset.delChore = c.id;

    // Frequency and minutes
    r.timesPerWeek.value = c.timesPerWeek;
    r.timesPerWeek.dataset.chore = c.id;
    r.minutes.value = c.minutes;
    r.minutes.dataset.chore = c.id;

    // Dislike chips
    state.people.forEach(p => {
      const chip = cloneEl('tpl-cl-dislike-chip');
      const cr = refs(chip);
      chip.title = `${p.name}'s dislike of this chore`;
      cr.name.textContent = p.name;
      cr.input.value = dislikeOf(c, p.id);
      cr.input.dataset.dislikeChore = c.id;
      cr.input.dataset.dislikePerson = p.id;
      r.dislikeRow.append(chip);
    });

    // Split chips
    const total = splitTotal(c.id);
    state.people.forEach(p => {
      const chip = cloneEl('tpl-cl-split-chip');
      const cr = refs(chip);
      cr.name.textContent = p.name;
      const pct = (state.assignments[c.id] && state.assignments[c.id][p.id]) || 0;
      cr.input.value = pct;
      cr.input.dataset.splitChore = c.id;
      cr.input.dataset.splitPerson = p.id;
      r.splitRow.insertBefore(chip, r.splitTotal);
    });

    r.splitTotal.dataset.splitTotal = c.id;
    r.splitTotal.textContent = `${total}%`;
    r.splitTotal.className = 'cl-split-total ' + (total === 100 ? 'good' : (total === 0 ? '' : 'bad'));

    frag.append(card);
  });
  list.append(frag);
}

function renderPeople(){
  const wrap = document.getElementById('cl-people-list');
  wrap.replaceChildren();

  const totals = totalsByPerson();
  if(state.people.length === 0){
    wrap.append(emptyState('No one on the ledger yet — add someone below.'));
    return;
  }

  const frag = document.createDocumentFragment();
  state.people.forEach(p => {
    const card = cloneEl('tpl-cl-person');
    const r = refs(card);

    r.nameInput.value = p.name;
    r.nameInput.dataset.personName = p.id;
    r.removeBtn.dataset.delPerson = p.id;
    r.total.textContent = `${totals[p.id] || 0} pts/wk`;

    const mine = state.chores.filter(c => ((state.assignments[c.id] || {})[p.id] || 0) > 0);
    if(mine.length === 0){
      r.tickets.append(emptyState('No chores assigned yet.'));
    } else {
      const ticketsFrag = document.createDocumentFragment();
      mine.forEach(c => {
        const ticket = cloneEl('tpl-cl-ticket');
        const tr = refs(ticket);
        const pct = (state.assignments[c.id] || {})[p.id] || 0;
        tr.name.textContent = c.name;
        tr.share.textContent = `${pct}% · dislike ${dislikeOf(c, p.id)}`;
        tr.pts.textContent = shareOf(c, p.id);
        ticketsFrag.append(ticket);
      });
      r.tickets.append(ticketsFrag);
    }

    frag.append(card);
  });
  wrap.append(frag);
}

function refreshChoreBadge(choreId){
  const chore = state.chores.find(c => c.id === choreId);
  if(!chore) return;
  const badge = document.querySelector(`[data-pts-badge="${choreId}"]`);
  if(badge) badge.textContent = choreTotalAtCurrentSplit(chore) + ' pts/wk';
  const totalEl = document.querySelector(`[data-split-total="${choreId}"]`);
  if(totalEl){
    const total = splitTotal(choreId);
    totalEl.textContent = total + '%';
    totalEl.className = 'cl-split-total ' + (total === 100 ? 'good' : (total === 0 ? '' : 'bad'));
  }
}

function refreshPeopleTotalsAndTickets(){
  renderPeople();
  renderBeam();
}

document.addEventListener('input', (e) => {
  const t = e.target;

  if(t.matches('input[data-field][data-chore]')){
    const chore = state.chores.find(c => c.id === t.dataset.chore);
    if(!chore) return;
    if(t.dataset.field === 'name') chore.name = t.value;
    if(t.dataset.field === 'timesPerWeek') chore.timesPerWeek = Math.max(0, parseFloat(t.value) || 0);
    if(t.dataset.field === 'minutes') chore.minutes = Math.max(0, parseFloat(t.value) || 0);
    refreshChoreBadge(chore.id);
    refreshPeopleTotalsAndTickets();
    debounceSave(`chore-fields-${chore.id}`, () =>
            sb.from(TABLES.CHORES).update({
              name: chore.name, times_per_week: chore.timesPerWeek, minutes: chore.minutes
            }).eq('id', chore.id)
    );
  }

  if(t.matches('input[data-dislike-chore][data-dislike-person]')){
    const choreId = t.dataset.dislikeChore;
    const personId = t.dataset.dislikePerson;
    const chore = state.chores.find(c => c.id === choreId);
    if(!chore) return;
    const val = Math.min(10, Math.max(1, parseInt(t.value,10) || 1));
    chore.dislike = chore.dislike || {};
    chore.dislike[personId] = val;
    refreshChoreBadge(choreId);
    refreshPeopleTotalsAndTickets();
    debounceSave(`dislike-${choreId}-${personId}`, () =>
            sb.from(TABLES.CHORE_DISLIKES).upsert({chore_id: choreId, person_id: personId, dislike: val})
    );
  }

  if(t.matches('input[data-split-chore][data-split-person]')){
    const choreId = t.dataset.splitChore;
    const personId = t.dataset.splitPerson;
    const pct = Math.min(100, Math.max(0, parseInt(t.value,10) || 0));
    state.assignments[choreId] = state.assignments[choreId] || {};
    state.assignments[choreId][personId] = pct;
    refreshChoreBadge(choreId);
    refreshPeopleTotalsAndTickets();
    debounceSave(`split-${choreId}-${personId}`, () =>
            sb.from(TABLES.CHORE_ASSIGNMENTS).upsert({chore_id: choreId, person_id: personId, pct})
    );
  }

  if(t.matches('input[data-person-name]')){
    const p = state.people.find(p => p.id === t.dataset.personName);
    if(!p) return;
    p.name = t.value;
    renderBeam();
    renderChores();
    renderPeople();
    debounceSave(`person-name-${p.id}`, () =>
            sb.from(TABLES.PEOPLE).update({name: p.name}).eq('id', p.id)
    );
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target;

  if(t.matches('[data-del-chore]')){
    const id = t.getAttribute('data-del-chore');
    state.chores = state.chores.filter(c => c.id !== id);
    delete state.assignments[id];
    render();
    try{
      await sb.from(TABLES.CHORES).delete().eq('id', id);
    } catch(err){ setStatus('Could not delete chore.'); }
  }

  if(t.matches('[data-del-person]')){
    if(state.people.length <= 1){ setStatus('Keep at least one person.'); return; }
    const id = t.getAttribute('data-del-person');
    state.people = state.people.filter(p => p.id !== id);
    state.chores.forEach(c => { if(c.dislike) delete c.dislike[id]; });
    Object.keys(state.assignments).forEach(cid => {
      if(state.assignments[cid]) delete state.assignments[cid][id];
    });
    render();
    try{
      await sb.from(TABLES.PEOPLE).delete().eq('id', id);
    } catch(err){ setStatus('Could not delete person.'); }
  }

  if(t.id === 'cl-add-chore'){
    const input = document.getElementById('cl-new-chore-name');
    const name = input.value.trim();
    if(!name) return;

    try{
      const {data, error} = await sb.from(TABLES.CHORES)
              .insert({name, times_per_week: 1, minutes: 15})
              .select()
              .single();
      if(error || !data){ setStatus('Could not add chore.'); return; }
      const id = data.id;

      const dislike = {};
      state.people.forEach(p => dislike[p.id] = DEFAULT_DISLIKE);
      if(state.people.length){
        await sb.from(TABLES.CHORE_DISLIKES).upsert(
                state.people.map(p => ({chore_id: id, person_id: p.id, dislike: DEFAULT_DISLIKE}))
        );
      }
      const firstPerson = state.people[0];
      if(firstPerson){
        await sb.from(TABLES.CHORE_ASSIGNMENTS).upsert({chore_id: id, person_id: firstPerson.id, pct: 100});
      }

      state.chores.push({id, name, timesPerWeek: 1, minutes: 15, dislike});
      state.assignments[id] = firstPerson ? {[firstPerson.id]: 100} : {};
      input.value = '';
      render();
    } catch(err){
      setStatus('Could not add chore.');
    }
  }

  if(t.id === 'cl-add-person'){
    const input = document.getElementById('cl-new-person-name');
    const name = input.value.trim();
    if(!name) return;

    try{
      const {data, error} = await sb.from(TABLES.PEOPLE)
              .insert({name})
              .select()
              .single();
      if(error || !data){ setStatus('Could not add person.'); return; }
      const id = data.id;

      if(state.chores.length){
        await sb.from(TABLES.CHORE_DISLIKES).upsert(
                state.chores.map(c => ({chore_id: c.id, person_id: id, dislike: DEFAULT_DISLIKE}))
        );
      }

      state.people.push({id, name});
      state.chores.forEach(c => {
        c.dislike = c.dislike || {};
        c.dislike[id] = DEFAULT_DISLIKE;
      });
      input.value = '';
      render();
    } catch(err){
      setStatus('Could not add person.');
    }
  }

  if(t.id === 'cl-auto-balance'){
    await autoBalance();
    setStatus('Balanced.');
  }

  if(t.id === 'cl-clear-assign'){
    const first = state.people[0];
    state.chores.forEach(c => {
      state.assignments[c.id] = first ? {[first.id]: 100} : {};
    });
    render();
    setStatus('Reset — everything assigned 100% to the first person.');

    try{
      const choreIds = state.chores.map(c => c.id);
      if(choreIds.length){
        await sb.from(TABLES.CHORE_ASSIGNMENTS).delete().in('chore_id', choreIds);
        if(first){
          await sb.from(TABLES.CHORE_ASSIGNMENTS).insert(
                  choreIds.map(cid => ({chore_id: cid, person_id: first.id, pct: 100}))
          );
        }
      }
    } catch(err){
      setStatus('Reset locally, but could not save.');
    }
  }
});

document.addEventListener('keydown', (e) => {
  if(e.key === 'Enter'){
    if(e.target.id === 'cl-new-chore-name') document.getElementById('cl-add-chore').click();
    if(e.target.id === 'cl-new-person-name') document.getElementById('cl-add-person').click();
  }
});

let realtimeChannel = null;
let realtimeDebounceTimer = null;

function setupRealtime(){
  if(realtimeChannel || !sb) return;
  realtimeChannel = sb.channel('chores-realtime-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.PEOPLE }, () => debounceReload())
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.CHORES }, () => debounceReload())
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.CHORE_DISLIKES }, () => debounceReload())
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLES.CHORE_ASSIGNMENTS }, () => debounceReload())
    .subscribe();
}

function debounceReload(){
  clearTimeout(realtimeDebounceTimer);
  realtimeDebounceTimer = setTimeout(() => {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      return;
    }
    load();
  }, 400);
}

window.addEventListener('beforeunload', () => {
  if(realtimeChannel && sb) sb.removeChannel(realtimeChannel);
});

if(window.initAppPage){
  window.initAppPage(load);
} else {
  document.addEventListener('app:ready', load, { once: true });
}