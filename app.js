/* IPA Assist Platform: UI + data layer.
 *
 * Layers (top to bottom):  CONFIG > Store > Validators > Files > Api (+Mock) > Exporter > UI > events
 *
 * Backend contract (used when CONFIG.USE_MOCK = false). All bodies are JSON unless noted.
 *   POST {API_BASE}/chat      { question, context:{mode, form} }
 *        -> { answer: string ("**bold**" allowed), chips?: string[], form?: {model,platform,...} }
 *   POST {API_BASE}/upload    multipart: file, kind ("ppt" | "tsow")
 *        -> { fileName, size, fields:{model?,platform?,criteria?,usecase?,script?}, missing: string[] }
 *   POST {API_BASE}/analysis  { model, platform, criteria, usecase, script }
 *        -> { lookup:{goal, topology:{name,family}, platform:{name,collection,codeName,segment}},
 *             compat:{tsowModel,hfModel,compatible,matches,matchedModels:[],sourceUrl},
 *             scripts:{hf,ov,install,source}, setup:{commands,note} }
 */
(() => {
'use strict';

/* ================= CONFIG ================= */
const CONFIG = { API_BASE: '/api', USE_MOCK: true, TIMEOUT_MS: 15000 };

/* ================= HELPERS ================= */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');          // safe "**bold**" only
const delay = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));

/* ================= STORE (single source of truth) ================= */
const FIELDS = ['model', 'platform', 'criteria', 'usecase', 'script'];
const INPUT_ID = { model:'f-model', platform:'f-platform', criteria:'f-criteria', usecase:'f-usecase', script:'f-script' };
const LABELS = { model:'Model', platform:'Platform', criteria:'Success Criteria', usecase:'Use Case', script:'Script Type' };
const Store = {
  state: { mode:'ask', step:0, tab:'form', rtab:0, busy:false, source:'', result:null,
           form: { model:'', platform:'', criteria:'', usecase:'', script:'' } },
  listeners: new Set(),
  subscribe(fn) { this.listeners.add(fn); },
  emit() { this.listeners.forEach(fn => fn(this.state)); },
  set(patch) { Object.assign(this.state, patch); this.emit(); },
  setForm(patch) {                                   // only known fields, strings only
    for (const k of FIELDS) if (k in patch) this.state.form[k] = String(patch[k] ?? '');
    this.emit();
  },
  form() {                                           // trimmed copy for validation and API calls
    return Object.fromEntries(FIELDS.map(k => [k, this.state.form[k].trim()]));
  },
  reset(mode = 'ask') {
    Object.assign(this.state, { mode, step:0, rtab:0, busy:false, source:'', result:null });
    this.setForm(Object.fromEntries(FIELDS.map(k => [k, ''])));
  }
};

/* ================= VALIDATORS ================= */
const Validators = {
  REQUIRED: ['model', 'platform', 'criteria'], MAX: 300,
  INJECTION: /ignore (all |any )?(previous|prior) instructions|system prompt|<\s*\/?\s*script/i,
  text(t) { return !this.INJECTION.test(t) && t.length <= this.MAX; },
  form(f) {
    const missing = this.REQUIRED.filter(k => !f[k]), issues = [];
    for (const k of FIELDS) {
      if (f[k].length > this.MAX) issues.push(`${LABELS[k]} is longer than ${this.MAX} characters.`);
      if (this.INJECTION.test(f[k])) issues.push(`${LABELS[k]} contains blocked content.`);
    }
    return { ok: !missing.length && !issues.length, missing, issues };
  }
};

/* ================= FILES ================= */
const Files = {
  MAX_BYTES: 20 * 1024 * 1024,
  check(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['ppt', 'pptx', 'doc', 'docx', 'pdf'].includes(ext)) return { ok:false, error:`Unsupported file type .${ext}` };
    if (file.size > this.MAX_BYTES) return { ok:false, error:'File is larger than 20 MB' };
    return { ok:true, kind: ext.startsWith('ppt') ? 'ppt' : 'tsow' };
  }
};

/* ================= API ================= */
const Api = {
  async request(path, { body, formData } = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), CONFIG.TIMEOUT_MS);
    try {
      const res = await fetch(CONFIG.API_BASE + path, {
        method: 'POST', signal: ctl.signal,
        headers: formData ? undefined : { 'Content-Type': 'application/json' },
        body: formData || JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) { throw new Error(e.name === 'AbortError' ? 'Request timed out' : e.message); }
    finally { clearTimeout(timer); }
  },
  chat(question, context) { return CONFIG.USE_MOCK ? Mock.chat(question, context) : this.request('/chat', { body:{ question, context } }); },
  upload(file, kind) {
    if (CONFIG.USE_MOCK) return Mock.upload(file, kind);
    const fd = new FormData(); fd.append('file', file); fd.append('kind', kind);
    return this.request('/upload', { formData: fd });
  },
  async analyse(form) { return normalize(CONFIG.USE_MOCK ? await Mock.analyse(form) : await this.request('/analysis', { body: form })); }
};

/* Fills gaps so the renderer never sees undefined. */
function normalize(r = {}) {
  const d = (v, x = '-') => (v === undefined || v === null || v === '') ? x : v;
  const l = r.lookup || {}, c = r.compat || {}, s = r.scripts || {}, u = r.setup || {};
  return {
    lookup: { goal: d(l.goal, ''), topology: { name: d(l.topology?.name), family: d(l.topology?.family) },
      platform: { name: d(l.platform?.name), collection: d(l.platform?.collection), codeName: d(l.platform?.codeName), segment: d(l.platform?.segment) } },
    compat: { tsowModel: d(c.tsowModel), hfModel: d(c.hfModel), compatible: String(c.compatible ?? 'false'),
      matches: String(c.matches ?? 0), matchedModels: (c.matchedModels || []).join(', ') || '-', sourceUrl: d(c.sourceUrl) },
    scripts: { hf: d(s.hf, ''), ov: d(s.ov, ''), install: d(s.install, ''), source: d(s.source, '') },
    setup: { commands: d(u.commands, ''), note: d(u.note, '') }
  };
}

/* ================= MOCK BACKEND (demo data) ================= */
const Mock = {
  chat(q, ctx) {
    const l = q.toLowerCase();
    if (l.includes('qwen3-vl')) return delay(350, { answer:'Lookup result for **Qwen3-VL-8B-Instruct** (family: Qwen): OpenVINO compatibility **false**, **0** matched models. A related int4 export is listed at huggingface.co/OpenVINO/Qwen3-VL-8B-Instruct-int4-ov.', chips:['Run full analysis'] });
    if (l.includes('analysis')) return delay(350, { answer:'I filled the form with sample values. Click **Submit and Run Analysis**.', form:{ model:'Qwen3-VL-8B-Instruct', platform:'Intel Core Ultra 7', criteria:'20% latency improvement' } });
    if (['ppt', 'tsow'].includes(ctx.mode)) return delay(350, { answer: l.includes('platform') ? 'The platform appears on slide 7, in the hardware table (sample answer).' : 'In the live app this answers from the parsed file. Demo mode returns sample text.' });
    return delay(350, { answer:'Demo mode: this answer would come from the model lookup service. Try \u201cIs Qwen3-VL-8B-Instruct OpenVINO compatible?\u201d for a full sample.' });
  },
  upload(file) {
    return delay(400, { fileName:file.name, size:file.size, missing:['usecase'],
      fields:{ model:'Qwen3-VL-8B-Instruct', platform:'Intel Core Ultra 7', criteria:'20% latency improvement is success, 50% would be fantastic' } });
  },
  analyse(f) {
    const m = f.model || 'Model', p = f.platform || 'Platform', ultra = /ultra 7/i.test(p), hf = /^qwen/i.test(m) ? 'Qwen/' + m : m;
    return delay(900, {
      lookup:{ goal:f.criteria, topology:{ name:m, family:(m.match(/^[A-Za-z]+/) || [''])[0] },
        platform:{ name:p, collection: ultra ? 'Intel\u00ae Core\u2122 Ultra Processors (Series 2)' : 'Not in demo data', codeName: ultra ? 'Lunar Lake' : '-', segment: ultra ? 'Mobile' : '-' } },
      compat:{ tsowModel:m, hfModel:hf, compatible:false, matches:0, matchedModels:[], sourceUrl:'' },
      scripts:{ hf:`from transformers import AutoModelForCausalLM, AutoTokenizer\n\nname = "${hf}"\ntok = AutoTokenizer.from_pretrained(name)\nmodel = AutoModelForCausalLM.from_pretrained(name)\n\ninputs = tok("Describe this image.", return_tensors="pt")\nout = model.generate(**inputs, max_new_tokens=100)\nprint(tok.decode(out[0], skip_special_tokens=True))`,
        ov:`text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)\ninputs = processor(text=[text], images=[image], return_tensors="pt")\n\noutputs = model.generate(**inputs, max_new_tokens=100)\ngenerated = outputs[:, inputs.input_ids.shape[1]:]\nprint(processor.batch_decode(generated, skip_special_tokens=True)[0])`,
        install:'pip install huggingface_hub pillow', source:'huggingface.co/OpenVINO/Qwen3-VL-8B-Instruct-int4-ov' },
      setup:{ commands:'python -m venv ov-env\nov-env\\Scripts\\activate\npip install -U --pre --extra-index-url https://storage.openvinotoolkit.org/simple/wheels/nightly openvino openvino-tokenizers',
        note:'Install the latest GPU and NPU drivers for ' + p + ' before running.' }
    });
  }
};

/* ================= EXPORT ================= */
const Exporter = {
  payload() { return { generatedAt:new Date().toISOString(), input:Store.form(), result:Store.state.result }; },
  json() { return JSON.stringify(this.payload(), null, 2); },
  download(name = 'ipa-analysis.json') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.json()], { type:'application/json' }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  copy(text) { return navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(); }
};

/* ================= UI ================= */
const STEPS = [
  ['model', 'Let\u2019s start: **what model are you working with?** (e.g. ResNet-50, Qwen3-4B, LLaMA-3-8B)'],
  ['platform', 'Which **platform** will it run on? (e.g. Intel Core Ultra 7 265K)'],
  ['criteria', 'What is your **success criteria**? (e.g. latency under 60 ms on video)'],
  ['usecase', 'Which **use case**? Vision, LLM, Speech or Other (or \u201cskip\u201d).'],
  ['script', 'Preferred **script type**? (e.g. HF, OpenVINO, or \u201cskip\u201d)']
];
const TABS = ['Data Lookup Table', 'OpenVINO Compatibility', 'HuggingFace Script', 'OV Script', 'Platform Setup'];

const UI = {
  toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('show'); setTimeout(() => e.classList.remove('show'), 1800); },
  show(v) { ['home', 'chat', 'results'].forEach(id => $('#' + id).hidden = id !== v); $('#back').hidden = v === 'home'; },
  msg(html, cls = 'bot') { const d = document.createElement('div'); d.className = 'm ' + cls; d.innerHTML = html; $('#msgs').append(d); d.scrollIntoView({ block:'end' }); return d; },
  chips(a) { return '<div class="chips">' + a.map(x => `<button class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join('') + '</div>'; },
  bot(text, { chips = [], extra = '' } = {}) { this.msg(fmt(text) + extra + (chips.length ? this.chips(chips) : '')); },
  me(text) { this.msg(esc(text), 'me'); },
  syncInputs() { for (const k of FIELDS) { const el = $('#' + INPUT_ID[k]); if (el.value !== Store.state.form[k]) el.value = Store.state.form[k]; } },
  strip() { const f = Store.form(); $('#strip').innerHTML = 'Collected: ' + FIELDS.map(k => `<span class="pill ${f[k] ? 'on' : ''}">${f[k] ? '\u2713 ' : ''}${LABELS[k]}</span>`).join(''); },
  validation(flag) {
    const r = Validators.form(Store.form()), v = $('#val');
    Validators.REQUIRED.forEach(k => $('#' + INPUT_ID[k]).classList.toggle('bad', flag && r.missing.includes(k)));
    if (r.ok) { v.className = 'val ok2'; v.textContent = 'All checks passed: required fields complete, no blocked content, length OK.'; }
    else {
      const parts = [flag && r.missing.length ? 'Missing required: ' + r.missing.map(k => LABELS[k]).join(', ') + '.' : '', ...r.issues].filter(Boolean);
      v.className = 'val' + (flag || r.issues.length ? ' err' : '');
      v.textContent = parts.join(' ') || 'Fill the required fields to validate.';
    }
    return r.ok;
  },
  setTab(t) {
    Store.set({ tab:t }); $$('#seg button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $('#drop').hidden = t === 'form'; $('#file').accept = t === 'ppt' ? '.ppt,.pptx' : '.doc,.docx,.pdf';
    if (t !== 'form') $('#drop').textContent = t === 'ppt' ? 'Drop or choose a .pptx file' : 'Drop or choose a TSOW file';
  },
  renderResults() {
    const r = Store.state.result, i = Store.state.rtab, f = Store.form();
    const kv = rows => rows.map(x => `<div class="kv"><span>${x[0]}</span><span>${esc(x[1])}</span></div>`).join('');
    const sec = (t, rows) => `<div class="sec"><b>${t}</b>${kv(rows)}</div>`;
    const code = t => `<div class="code"><pre>${esc(t)}</pre><button data-copy>Copy</button></div>`;
    $('#tabs').innerHTML = TABS.map((t, n) => `<button role="tab" data-r="${n}" class="${n === i ? 'on' : ''}" aria-selected="${n === i}">${t}</button>`).join('');
    $('#rtitle').textContent = TABS[i];
    $('#srcBadge').textContent = CONFIG.USE_MOCK ? 'Demo data' : 'Live data';
    $('#rbody').innerHTML = [
      `<div class="alert">Input passed all validation checks.</div><div class="chips" style="justify-content:flex-start"><span class="chip">Hardware: ${esc(r.lookup.platform.name)}</span><span class="chip">Use Case: ${esc(f.usecase || 'Not provided')}</span><span class="chip">Model: ${esc(r.lookup.topology.name)}</span></div><div><b>Goal:</b> ${esc(r.lookup.goal)}</div>`
        + sec('TOPOLOGY', [['Name', r.lookup.topology.name], ['Family', r.lookup.topology.family]])
        + sec('PLATFORM', [['Name', r.lookup.platform.name], ['Collection', r.lookup.platform.collection], ['Code Name', r.lookup.platform.codeName], ['Segment', r.lookup.platform.segment]]),
      sec('OPENVINO COMPATIBILITY', [['TSOW Model', r.compat.tsowModel], ['HF Model', r.compat.hfModel], ['Compatible', r.compat.compatible], ['Matches Found', r.compat.matches], ['Matched Models', r.compat.matchedModels], ['Source URL', r.compat.sourceUrl]]),
      code(r.scripts.hf),
      code(r.scripts.ov) + code(r.scripts.install) + `<div>Source: ${esc(r.scripts.source)}</div>`,
      code(r.setup.commands) + `<div>${esc(r.setup.note)}</div>`
    ][i];
  }
};

/* ================= FLOWS ================= */
function start(flow, q) {
  Store.reset(flow); $('#msgs').innerHTML = '';
  UI.setTab(flow === 'ppt' || flow === 'tsow' ? flow : 'form'); UI.show('chat');
  if (flow === 'guided') { UI.bot('Hi! I\u2019m the Intel AI Query Critique Engine. ' + STEPS[0][1]); $('#cin').placeholder = 'Type your answer'; }
  else if (flow === 'ask') { UI.bot('**IPA Intelligence Chatbot.** Ask me about any AI model: specs, OpenVINO compatibility, driver setup, scripts or validation history.', { chips:['Tell me about Qwen3-4B', 'Is Qwen3-VL-8B-Instruct OpenVINO compatible?'] }); $('#cin').placeholder = 'Ask about any AI model'; }
  else { UI.bot(`Attach your ${flow === 'ppt' ? 'PPT deck' : 'TSOW'} with the button below or the panel on the right. I will extract the inputs.`); $('#cin').placeholder = 'Ask about your file'; }
  if (q) ask(q);
}

async function ask(q) {
  UI.me(q);
  try {
    const res = await Api.chat(q, { mode:Store.state.mode, form:Store.form() });
    if (res.form) Store.setForm(res.form);
    UI.bot(res.answer, { chips: res.chips || [] });
  } catch (e) { UI.bot('Sorry, the request failed: ' + e.message); }
}

function guidedAnswer(a) {
  const key = STEPS[Store.state.step][0];
  Store.setForm({ [key]: /^skip$/i.test(a) ? '' : a }); Store.state.step++;
  setTimeout(() => UI.bot(Store.state.step < STEPS.length ? STEPS[Store.state.step][1] : 'All inputs collected. Click **Submit and Run Analysis** when ready.'), 350);
}

function send(text) {
  text = text.trim(); if (!text) return;
  if (!Validators.text(text)) { UI.me(text.slice(0, 80)); return UI.bot('That message was blocked (too long or contains disallowed content).'); }
  if (Store.state.mode === 'guided' && Store.state.step < STEPS.length) { UI.me(text); guidedAnswer(text); }
  else ask(text);
}

async function onFile(file) {
  if (!file) return;
  const chk = Files.check(file);
  if (!chk.ok) return UI.toast(chk.error);
  UI.setTab(chk.kind); if (Store.state.mode === 'ask' || Store.state.mode === 'guided') Store.set({ mode:chk.kind });
  UI.msg(`<b>${esc(file.name)}</b><br><small>${Math.max(1, Math.round(file.size / 1024))} KB, uploading...</small>`, 'file');
  try {
    const res = await Api.upload(file, chk.kind);
    Store.set({ source:file.name }); Store.setForm(res.fields || {});
    const missing = new Set(res.missing || []), f = Store.form();
    const row = (k, ok) => `<div class="row"><span>${LABELS[k]}</span><span>${esc(f[k] || 'Not provided')}</span><span class="${ok ? 'ok' : 'need'}">${ok ? 'Found' : 'Needs input'}</span></div>`;
    UI.bot('I extracted these inputs' + (CONFIG.USE_MOCK ? ' (sample values in the demo)' : '') + ':',
      { extra: FIELDS.filter(k => k !== 'script').map(k => row(k, !!f[k] && !missing.has(k))).join(''), chips:['Which slide mentions the platform?'] });
  } catch (e) { UI.toast('Upload failed: ' + e.message); }
}

async function run() {
  if (Store.state.busy) return;
  if (!UI.validation(true)) return;
  const b = $('#run'); Store.set({ busy:true }); b.disabled = true; b.textContent = 'Running analysis...';
  try {
    Store.set({ result: await Api.analyse(Store.form()), rtab:0 });
    UI.renderResults(); UI.show('results');
  } catch (e) { UI.toast('Analysis failed: ' + e.message); }
  finally { Store.set({ busy:false }); b.disabled = false; b.textContent = 'Submit and Run Analysis'; }
}

/* ================= EVENTS ================= */
Store.subscribe(() => { UI.syncInputs(); UI.strip(); UI.validation(false); });

document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.flow) start(t.dataset.flow);
  else if (t.dataset.q) { $('#chat').hidden ? start('ask', t.dataset.q) : ask(t.dataset.q); }
  else if (t.dataset.tab) UI.setTab(t.dataset.tab);
  else if (t.dataset.r) { Store.set({ rtab:+t.dataset.r }); UI.renderResults(); }
  else if (t.hasAttribute('data-copy')) Exporter.copy(t.previousElementSibling.textContent).then(() => UI.toast('Copied'), () => UI.toast('Copy not available'));
});
$('#new').onclick = () => { Store.reset(); UI.show('home'); $('#msgs').innerHTML = ''; };
$('#back').onclick = () => $('#results').hidden ? UI.show('home') : UI.show('chat');
$('#fb').onclick = () => UI.toast('Thanks, feedback noted');
$('#fab').onclick = () => { UI.show('chat'); if (Store.state.mode !== 'ask') UI.bot('Ask me anything about these results.'); $('#cin').focus(); };
$('#run').onclick = run;
$('#export').onclick = () => { Exporter.download(); UI.toast('JSON exported'); };
$('#cform').onsubmit = e => { e.preventDefault(); const i = $('#cin'), v = i.value; i.value = ''; send(v); };
document.querySelector('[data-home]').onsubmit = e => { e.preventDefault(); const i = e.target.querySelector('input'), q = i.value.trim(); if (q) { i.value = ''; start('ask', q); } };
$('#file').onchange = e => { onFile(e.target.files[0]); e.target.value = ''; };
const drop = $('#drop');
['dragover', 'dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop') onFile(e.dataTransfer.files[0]); }));
FIELDS.forEach(k => $('#' + INPUT_ID[k]).addEventListener('input', e => Store.setForm({ [k]: e.target.value })));
UI.strip(); UI.validation(false);
})();
