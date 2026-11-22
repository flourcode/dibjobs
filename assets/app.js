/* ==========================================================================
   DIB Jobs - application script
   Sections: config/state, utilities, file reading, UI shell, resume input,
   analysis, results, resume tools, outreach, chat, tracker, find roles, init
   ========================================================================== */
(() => {
    'use strict';

    // ======================================================================
    // CONFIG + STATE
    // ======================================================================
    const API_ENDPOINT = 'https://pchkhu4vitpzuppdmtnrlxx2sy0idjzp.lambda-url.us-east-1.on.aws/';
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 2000;
    const KEYS = {
        resumes: 'dib_jobs_resumes',
        draft: 'dib_jobs_resume_draft',
        tracker: 'dougOMaticTracker',       // legacy name kept so existing users keep their data
        military: 'dib_jobs_military',
        theme: 'dib_jobs_theme'
    };
    const SHARE_URL = 'https://dibjobs.com/';
    const SHARE_TEXT = 'DIB Jobs: drop in your resume and a job description to get a fit score, clearance check, comp intel, and interview prep for defense industry roles.';

    const state = {
        analysis: null,        // current analysis result (+ merged market intel)
        resumeText: '',        // resume text that was analyzed
        jd: '',                // job description text that was analyzed
        chat: [],
        tailored: null,
        pendingOcrFile: null,
        fileName: '',
        fileFlags: null,       // layout facts from the last uploaded file
        lastScores: {},        // job key -> previous score, for "re-score" deltas
        template: 'applied',
        templates: {},
        tracked: [],
        compareIds: new Set(),
        batch: null,           // a finished comparison: several jobs, or several resume versions
        runId: 0,              // bumped whenever the job on screen changes; late replies for an older job are dropped
        trackedId: null,       // tracker entry the job on screen came from (so saving upgrades it)
        postingUrl: '',        // link to the posting on screen, kept even when the text is pasted
        linkedText: '',        // the job text those two belong to; a different job in the box breaks the link
        readingLink: '', readSeq: 0, linkTitle: '',
        linkHelp: null,        // null | 'reading' | 'read' (text came from the link: check it) | 'kept' (link held while the text is pasted)
        loadingTimer: null,
        snackTimer: null,
        draftTimer: null
    };

    // ======================================================================
    // UTILITIES
    // ======================================================================
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
    const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    const track = (event, params) => { if (typeof gtag === 'function') gtag('event', event, params || {}); };
    const isMilitary = () => $('militaryToggle').checked;
    const knownCompany = (c) => (c && !/not specified|unknown/i.test(c)) ? c : '';
    const isUrl = (s) => { const v = String(s || '').trim(); if (!/^https?:\/\/\S+$/i.test(v)) return false; try { return new URL(v).hostname.includes('.'); } catch (e) { return false; } };
    const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

    const store = {
        get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
        getRaw(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } },
        set(key, value) { try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); return true; } catch (e) { return false; } },
        remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
    };

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function copyText(text, message = 'Copied.') {
        const done = () => snackbar(message);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, () => snackbar('Could not copy. Select the text and copy it manually.'));
        } else {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { snackbar('Could not copy.'); }
            ta.remove();
        }
    }

    // One place for every backend call. Throws Error with a user-ready message.
    async function api(payload) {
        let response;
        try {
            // Sent as text/plain so the browser skips the CORS preflight request (the Lambda parses it as JSON).
            response = await fetch(API_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(payload) });
        } catch (e) {
            const err = new Error('Could not reach the analysis service. Check your connection and try again.');
            err.transient = true; throw err;
        }
        let data;
        try { data = await response.json(); } catch (e) {
            const err = new Error('The analysis service is temporarily unavailable. Please try again.');
            err.transient = true; throw err;
        }
        let status = response.status;
        // If the Function URL is in streaming mode but the Lambda's buffered handler is deployed, the real
        // answer arrives wrapped as { statusCode, body }. Unwrap it so the page still works.
        if (data && typeof data.statusCode === 'number' && typeof data.body === 'string') {
            status = data.statusCode;
            try { data = JSON.parse(data.body || '{}'); } catch (e) { data = {}; }
        }
        if (status === 429) {
            throw new Error(data.error || 'Too many requests. Please wait a few minutes and try again.');
        }
        if (status < 200 || status >= 300 || data.error) {
            const err = new Error(/unknown request type/i.test(data.error || '') ? 'This feature is not available yet. Please try again later.' : (data.error || 'Something went wrong. Please try again.'));
            err.transient = [502, 503, 504].includes(status);
            throw err;
        }
        return data;
    }

    // Wraps a button-triggered async task with a busy state.
    async function withBusy(button, busyLabel, task) {
        const label = button.querySelector('span') || button;
        const original = label.textContent;
        const ic = button.querySelector('.icon');
        button.disabled = true; label.textContent = busyLabel;
        let spin;
        if (ic) { spin = document.createElement('span'); spin.className = 'spinner'; ic.replaceWith(spin); }
        try { return await task(); }
        catch (e) { snackbar(e.message || 'Something went wrong. Please try again.', 7000); }
        finally { button.disabled = false; label.textContent = original; if (spin) spin.replaceWith(ic); }
    }

    // File reading (PDF, Word, text) lives in assets/files.js and is shared with the recruiter page.
    const { readDocumentFile, normalizeExtractedText, countWords, MAX_OCR_BYTES, MAX_RESUME_CHARS, MAX_JD_CHARS } = window.DIBFiles;

    // ======================================================================
    // UI SHELL: snackbar, dialog, tabs
    // ======================================================================
    function snackbar(message, duration = 4000) {
        const el = $('snackbar');
        $('snackbarText').textContent = message;
        el.classList.add('show');
        clearTimeout(state.snackTimer);
        state.snackTimer = setTimeout(() => el.classList.remove('show'), duration);
    }

    // Material dialog. With `label` it asks for text and resolves to the string;
    // without it, it is a confirmation and resolves to true. Cancel = null.
    function askDialog({ title, body = '', label = '', value = '', okText = 'OK', danger = false, altText = '' }) {
        return new Promise((resolve) => {
            const dlg = $('promptDialog');
            $('promptTitle').textContent = title;
            $('promptBody').innerHTML = body;
            $('promptBody').hidden = !body;
            $('promptField').hidden = !label;
            $('promptLabel').textContent = label;
            $('promptInput').value = value;
            $('promptInput').required = !!label;
            const ok = $('promptOk');
            ok.textContent = okText;
            ok.classList.toggle('danger', danger);
            $('promptAlt').hidden = !altText; $('promptAlt').textContent = altText;
            dlg.returnValue = 'cancel';
            const onClose = () => {
                dlg.removeEventListener('close', onClose);
                if (dlg.returnValue === 'alt') return resolve('alt');
                if (dlg.returnValue !== 'ok') return resolve(null);
                resolve(label ? $('promptInput').value.trim() : true);
            };
            dlg.addEventListener('close', onClose);
            dlg.showModal();
            if (label) $('promptInput').select();
        });
    }

    function selectTab(tablist, tab) {
        tablist.querySelectorAll('[role="tab"]').forEach(t => {
            const on = t === tab;
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
        });
    }

    const VIEW_ORDER = ['analyze', 'explore', 'tracker'];
    const VIEW_HASH = { analyze: '', explore: '#find', tracker: '#tracker' };
    const HASH_VIEW = { '#check': 'analyze', '#analyze': 'analyze', '#tracker': 'tracker', '#explore': 'explore', '#find': 'explore' };
    const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function animateIn(el, cls) {
        if (!el || reducedMotion()) return;
        el.classList.remove('enter', 'enter-l', 'enter-r');
        void el.offsetWidth;   // restart the animation
        el.classList.add(cls);
        el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
    }

    function currentView() {
        const cur = document.querySelector('#mainTabs [aria-current="page"]');
        return cur ? cur.dataset.view : 'analyze';
    }

    function showView(name) {
        const item = document.querySelector(`#mainTabs [data-view="${name}"]`);
        if (!item) return;
        const from = VIEW_ORDER.indexOf(currentView()), to = VIEW_ORDER.indexOf(name);
        document.querySelectorAll('#mainTabs .nav-item[data-view]').forEach(n => n === item ? n.setAttribute('aria-current', 'page') : n.removeAttribute('aria-current'));
        document.querySelectorAll('main > .view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
        if (from !== to) animateIn($('view-' + name), to > from ? 'enter-l' : 'enter-r');
        window.scrollTo({ top: 0 });
        if (name === 'tracker') renderTracker();
        try { history.replaceState(null, '', VIEW_HASH[name] || location.pathname + location.search); } catch (e) { /* ignore */ }
    }

    function showPanel(name) {
        const tab = document.querySelector(`#resultTabs [data-panel="${name}"]`);
        if (!tab) return;
        const tabs = [...document.querySelectorAll('#resultTabs [role="tab"]')];
        const from = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true'), to = tabs.indexOf(tab);
        selectTab($('resultTabs'), tab);
        document.querySelectorAll('#results [role="tabpanel"]').forEach(p => { p.hidden = p.id !== 'panel-' + name; });
        if (from !== to) animateIn($('panel-' + name), to > from ? 'enter-l' : 'enter-r');
    }

    function updateFab() { /* no floating action in this layout */ }

    function closeMenus(except) {
        document.querySelectorAll('.menu').forEach(m => {
            if (m === except) return;
            m.hidden = true;
            const btn = document.querySelector(`[data-menu="${m.id}"]`);
            if (btn) btn.setAttribute('aria-expanded', 'false');
        });
    }

    function toggleMenu(id) {
        const menu = $(id), btn = document.querySelector(`[data-menu="${id}"]`);
        const show = menu.hidden;
        closeMenus(menu);
        menu.hidden = !show;
        btn.setAttribute('aria-expanded', String(show));
        if (show) { const first = menu.querySelector('.menu-item'); if (first) first.focus({ preventScroll: true }); }
    }

    function initMenus() {
        document.addEventListener('click', (e) => {
            const fb = e.target.closest('#feedback [data-feedback]'); if (fb) return giveFeedback(fb.dataset.feedback);
            const why = e.target.closest('#feedback [data-why]'); if (why) return giveFeedbackReason(why.dataset.why, why.textContent.trim());
            const toggle = e.target.closest('[data-menu]');
            if (toggle) { e.preventDefault(); toggleMenu(toggle.dataset.menu); return; }
            // Choosing an item, or clicking anywhere outside, closes open menus.
            if (e.target.closest('.menu-item') || !e.target.closest('.menu')) closeMenus();
        }, true);
        document.addEventListener('keydown', (e) => {
            const menu = e.target.closest && e.target.closest('.menu');
            if (e.key === 'Escape') {
                const open = document.querySelector('.menu:not([hidden])');
                if (open) { closeMenus(); const btn = document.querySelector(`[data-menu="${open.id}"]`); if (btn) btn.focus(); }
            } else if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                const items = [...menu.querySelectorAll('.menu-item')];
                const i = items.indexOf(document.activeElement);
                items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
            }
        });
    }

    function initTabs() {
        const nav = $('mainTabs'), more = $('navMore'), navToggle = $('navToggle');
        const setNav = (open) => { more.classList.toggle('open', open); navToggle.setAttribute('aria-expanded', String(open)); };
        nav.addEventListener('click', (e) => { const item = e.target.closest('.nav-item[data-view]'); if (item) { showView(item.dataset.view); setNav(false); } });
        navToggle.addEventListener('click', () => setNav(!more.classList.contains('open')));
        document.addEventListener('click', (e) => { if (!e.target.closest('#navToggle, #navMore')) setNav(false); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && more.classList.contains('open')) { setNav(false); navToggle.focus(); } });
        const list = $('resultTabs');
        list.addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t) showPanel(t.dataset.panel); });
        list.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const tabs = [...list.querySelectorAll('[role="tab"]')];
            const i = tabs.indexOf(document.activeElement);
            if (i < 0) return;
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            next.focus(); showPanel(next.dataset.panel);
        });
    }

    // ======================================================================
    // RESUME INPUT: saved versions, file upload, autosave, resume check
    // ======================================================================
    const getSavedResumes = () => store.get(KEYS.resumes, {}) || {};

    // The resume menu lists saved versions; the active one (if the text matches) is named under the title.
    function updateResumeSelector() {
        const resumes = getSavedResumes();
        const names = Object.keys(resumes).sort((a, b) => (resumes[b].savedAt || '').localeCompare(resumes[a].savedAt || ''));
        const current = $('resumeText').value.trim();
        const active = names.find(n => resumes[n].text.trim() === current && current);
        $('savedResumeItems').innerHTML = names.length
            ? '<hr><p class="menu-empty">Saved versions</p>' + names.map(n => `<div class="row" style="flex-wrap:nowrap"><button class="menu-item saved" role="menuitemradio" aria-checked="${n === active}" data-load-resume="${escapeHtml(n)}"><svg class="icon"><use href="#i-doc"/></svg><span class="label">${escapeHtml(n)}</span><svg class="icon tick"><use href="#i-tick"/></svg></button><button class="icon-btn" data-delete-resume="${escapeHtml(n)}" aria-label="Remove ${escapeHtml(n)}" style="margin-right:8px"><svg class="icon"><use href="#i-trash"/></svg></button></div>`).join('')
            : '<p class="menu-empty">Save versions for different kinds of roles. They stay in this browser.</p>';
        const note = $('resumeVersionNote');
        note.hidden = !active;
        note.textContent = active ? `Using saved version "${active}"` : '';
        updateBatchUi();
    }

    async function saveCurrentResume() {
        const text = $('resumeText').value.trim();
        if (text.length < 100) return snackbar('Add your resume first (at least 100 characters).');
        const resumes = getSavedResumes();
        let suggestion = state.fileName || 'My resume';
        if (resumes[suggestion]) suggestion = `${suggestion} ${Object.keys(resumes).length + 1}`;
        const name = await askDialog({ title: 'Save this resume', body: 'Keep versions for different kinds of roles. Saved in this browser only.', label: 'Name', value: suggestion, okText: 'Save' });
        if (!name) return;
        resumes[name.substring(0, 50)] = { text, savedAt: new Date().toISOString() };
        if (!store.set(KEYS.resumes, resumes)) return snackbar('Could not save. Browser storage may be full.');
        updateResumeSelector();
        snackbar(`Saved "${name.substring(0, 50)}".`);
    }

    function loadSavedResume(name) {
        const resumes = getSavedResumes();
        if (!resumes[name]) return;
        $('resumeText').value = resumes[name].text;
        state.fileFlags = null; state.fileName = ''; state.resumeSource = 'saved';
        setFileStatus();
        onResumeChanged();
        setResumeMode(false);
        snackbar(`Loaded "${name}".`);
    }

    async function deleteSavedResume(name) {
        closeMenus();
        const ok = await askDialog({ title: 'Remove saved resume?', body: `"${escapeHtml(name)}" will be removed from this browser.`, okText: 'Remove', danger: true });
        if (!ok) return;
        const resumes = getSavedResumes();
        delete resumes[name];
        store.set(KEYS.resumes, resumes);
        updateResumeSelector();
        snackbar(`Removed "${name}".`);
    }

    function clearResume() {
        $('resumeText').value = '';
        state.resumeText = ''; state.pendingOcrFile = null; state.fileName = ''; state.fileFlags = null; state.resumeSource = '';
        setFileStatus();
        onResumeChanged();
        $('pasteRow').open = false;
        setResumeMode(true);
    }

    // With a resume in hand the card collapses to one line ("Using ... · Change"); the editor is one tap away.
    function setResumeMode(editing) {
        const text = $('resumeText').value.trim();
        const has = text.length >= 100;
        const summary = has && !editing;
        $('resumeSummary').hidden = !summary;
        $('resumeEditor').hidden = summary;
        $('pasteRowLabel').textContent = has ? 'Review or edit the text' : 'Paste text instead';
        if (!summary) return;
        const resumes = getSavedResumes();
        const saved = Object.keys(resumes).find(n => resumes[n].text.trim() === text);
        $('resumeSummaryTitle').textContent = state.resumeSource === 'example' ? 'Using the example resume'
            : state.fileName ? `Using ${state.fileName}` : saved ? `Using "${saved}"` : 'Using your saved resume';
        $('resumeSummaryMeta').textContent = `${countWords(text).toLocaleString()} words${state.resumeSource === 'example' ? ' · not yours, replace it to run your own check' : ''}`;
    }

    function setFileStatus(kind, html) {
        const el = $('resumeFileStatus');
        el.hidden = !html;
        const iconName = { success: 'check', warn: 'minus', error: 'x-circle' }[kind] || 'info';
        el.className = 'banner ' + (kind || '');
        el.innerHTML = html ? icon(iconName) + html : '';
    }

    function setDropBusy(busy, label) {
        $('resumeDrop').classList.toggle('busy', busy);
        $('resumeDropMain').innerHTML = busy ? escapeHtml(label || 'Reading your resume...') : 'Drop your resume here or <u>choose a file</u>';
    }

    async function handleResumeFile(file) {
        if (!file) return;
        showView('analyze'); showInputs();
        state.pendingOcrFile = null;
        setFileStatus();
        setDropBusy(true);
        try {
            const res = await readDocumentFile(file);
            if (res.scanned) {
                state.pendingOcrFile = file;
                const canOcr = file.size <= MAX_OCR_BYTES;
                setFileStatus('warn', `<span class="grow"><strong>${escapeHtml(file.name)}</strong><br>This PDF looks scanned or image-only, so there is no text to read directly. ${canOcr
                    ? 'The AI can read it for you (the file is sent to Google Gemini for this step), or paste your resume text below.'
                    : 'Paste your resume text below, or export a text-based PDF from Word or Google Docs.'}</span>${canOcr ? '<button class="btn text" data-action="ocr">Read with AI</button>' : ''}`);
                return;
            }
            applyResumeText(res.text, file.name, res);
        } catch (e) {
            console.warn('[RESUME FILE]', e.message);
            setFileStatus('error', `<span class="grow"><strong>${escapeHtml(file.name)}</strong><br>${escapeHtml(e.message || 'That file could not be read. Please paste your resume text instead.')}</span>`);
        } finally {
            setDropBusy(false);
            $('resumeFile').value = '';
        }
    }

    function applyResumeText(text, fileName, info = {}) {
        let note = '';
        if (text.length > MAX_RESUME_CHARS) {
            text = text.substring(0, MAX_RESUME_CHARS);
            note = ` Only the first ${MAX_RESUME_CHARS.toLocaleString()} characters are used.`;
        }
        if (info.pages && info.pagesRead && info.pages > info.pagesRead) note += ` Only the first ${info.pagesRead} of ${info.pages} pages were read.`;
        const words = countWords(text);
        $('resumeText').value = text;
        state.fileName = fileName.replace(/\.[^.]+$/, '').substring(0, 50);
        state.fileFlags = Object.assign({ kind: info.kind }, info.flags || {});
        onResumeChanged();
        const pageInfo = info.pages ? `${info.pages} page${info.pages !== 1 ? 's' : ''}, ` : '';
        const thin = words < 150;
        setFileStatus(thin || note ? 'warn' : 'success', `<span class="grow"><strong>${escapeHtml(fileName)}</strong> &middot; ${pageInfo}${words.toLocaleString()} words read${info.viaAI ? ' by AI' : ''}.<br>${thin
            ? 'That is less text than a typical resume. Choose Change to check it and paste anything that is missing.'
            : 'Choose Change if you want to review or edit the text.'}${escapeHtml(note)}</span>`);
        state.resumeSource = 'file';
        setResumeMode(false);
        track('resume_file_loaded', { file_kind: info.kind || 'unknown' });
    }

    // Scanned PDFs: ask the backend (Gemini) to read the file
    async function readResumeWithAI() {
        const file = state.pendingOcrFile;
        if (!file) return;
        setDropBusy(true, 'AI is reading your resume...');
        setFileStatus('warn', `<span class="grow"><strong>${escapeHtml(file.name)}</strong><br>Reading with AI. This can take up to a minute...</span>`);
        try {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('The file could not be read.'));
                reader.readAsDataURL(file);
            });
            const data = await api({ request_type: 'extract_resume', mime_type: 'application/pdf', file_data: String(dataUrl).split(',')[1] });
            if (!data.resume_text) throw new Error('The AI reader returned nothing. Please paste your resume text instead.');
            state.pendingOcrFile = null;
            applyResumeText(normalizeExtractedText(data.resume_text), file.name, { kind: 'pdf-ai', viaAI: true });
        } catch (e) {
            setFileStatus('error', `<span class="grow"><strong>${escapeHtml(file.name)}</strong><br>${escapeHtml(e.message)}</span>`);
        } finally {
            setDropBusy(false);
        }
    }

    async function handleJobFile(file) {
        if (!file) return;
        showView('analyze'); showInputs();
        const box = $('jobDescription');
        const prev = box.placeholder;
        box.placeholder = 'Reading ' + file.name + '...';
        try {
            const res = await readDocumentFile(file);
            if (res.scanned || !res.text) throw new Error('No readable text was found in that file. Please paste the job description text instead.');
            jobReplaced();
            box.value = res.text.substring(0, MAX_JD_CHARS);
            updateCounts();
            snackbar(`Job description loaded from ${file.name}`);
        } catch (e) {
            snackbar(e.message || 'That file could not be read.', 7000);
        } finally {
            box.placeholder = prev;
        }
    }

    function initFileDrop() {
        const drop = $('resumeDrop'), input = $('resumeFile'), jobBox = $('jobDescription'), jobCard = $('jobCard');
        drop.addEventListener('click', () => input.click());
        drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
        input.addEventListener('change', () => handleResumeFile(input.files[0]));
        const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
        let depth = 0;
        const end = () => { depth = 0; document.body.classList.remove('file-dragging'); drop.classList.remove('drop-target'); jobBox.classList.remove('drop-target'); };
        window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; document.body.classList.add('file-dragging'); } });
        window.addEventListener('dragleave', (e) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) end(); } });
        window.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();   // stops the browser from opening the file
            e.dataTransfer.dropEffect = 'copy';
            const overJob = jobCard.contains(e.target);
            jobBox.classList.toggle('drop-target', overJob);
            drop.classList.toggle('drop-target', !overJob);
        });
        window.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            const overJob = jobCard.contains(e.target);
            const file = e.dataTransfer.files && e.dataTransfer.files[0];
            end();
            // Dropped on the job card = job description. Anywhere else = resume.
            if (file) (overJob ? handleJobFile : handleResumeFile)(file);
        });
    }

    function fitJobBox() {
        const el = $('jobDescription');
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight + 4, 280) + 'px';
    }

    function updateCounts() {
        fitJobBox();
        const resume = $('resumeText').value, job = $('jobDescription').value;
        const fmt = (t) => t.trim() ? `${countWords(t).toLocaleString()} words` : '';
        $('resumeCount').textContent = fmt(resume) + (resume.length > MAX_RESUME_CHARS ? ` (only the first ${MAX_RESUME_CHARS.toLocaleString()} characters are analyzed)` : '');
        $('jobCount').textContent = isUrl(job) ? 'Link: it is read first, so you can check the posting before it is scored.' : fmt(job);
        updateBatchUi();
        if ($('resumeText').value.trim().length >= 100) clearFieldError('resume');
        updateHandoffLabel();
    }

    function onResumeChanged() {
        updateCounts();
        updateResumeSelector();
        renderResumeCheck();
        clearTimeout(state.draftTimer);
        state.draftTimer = setTimeout(() => {
            const text = $('resumeText').value;
            if (text.trim()) {
                if (store.set(KEYS.draft, text.substring(0, MAX_RESUME_CHARS))) $('resumeSavedNote').textContent = 'Remembered in this browser';
            } else {
                store.remove(KEYS.draft);
                $('resumeSavedNote').textContent = '';
            }
        }, 400);
    }

    function loadInitialResume() {
        const resumes = getSavedResumes();
        const draft = store.getRaw(KEYS.draft);
        if (draft.trim()) {
            $('resumeText').value = draft;
            $('resumeSavedNote').textContent = 'Remembered in this browser';
            updateResumeSelector();
            setResumeMode(false);
            return;
        }
        const names = Object.keys(resumes).sort((a, b) => (resumes[b].savedAt || '').localeCompare(resumes[a].savedAt || ''));
        if (names[0]) $('resumeText').value = resumes[names[0]].text;
        updateResumeSelector();
        setResumeMode(false);
    }

    // Local, instant checks on the resume itself (no AI involved).
    function runResumeCheck(text, flags) {
        const f = flags || {};
        const words = countWords(text);
        const items = [];
        const add = (ok, msg) => items.push({ ok, msg });
        if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) add(false, 'This looks like it contains a Social Security number. Remove it before sharing your resume anywhere.');
        const hasEmail = /[\w.+-]+@[\w-]+\.[\w.]+/.test(text), hasPhone = /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(text);
        if (f.headerContact) add(false, 'Your contact details sit in the Word header. Some applicant tracking systems skip headers, so move them into the body.');
        else add(hasEmail && hasPhone, hasEmail && hasPhone ? 'Email and phone found.' : `No ${!hasEmail && !hasPhone ? 'email or phone' : !hasEmail ? 'email' : 'phone number'} found. If it is in a header or text box, move it into the body.`);
        add(words >= 350 && words <= 1100, words < 350 ? `Short at ${words} words. Competitive resumes for these roles usually run 450 to 900.`
            : words > 1100 ? `Long at ${words.toLocaleString()} words. Hiring managers skim, so aim for two pages.` : `Good length (${words} words).`);
        const years = (text.match(/\b(19|20)\d{2}\b/g) || []).length;
        add(years >= 2, years >= 2 ? 'Employment dates found.' : 'No employment dates found. Recruiters and tracking systems both expect them.');
        const numbers = (text.match(/\$\s?\d[\d,.]*\s?[MKB]?\b|\d+(\.\d+)?%|\b\d+\+?\s?(million|billion)\b/gi) || []).length;
        add(numbers >= 4, numbers >= 4 ? `${numbers} quantified results. Numbers are what get sales and BD resumes read.` : `Only ${numbers} quantified result${numbers === 1 ? '' : 's'}. Add quota attainment, deal sizes, pipeline, or program values.`);
        const hasClearance = /clearance|ts\/sci|top secret|\bsecret\b|public trust|polygraph/i.test(text);
        add(hasClearance, hasClearance ? 'Clearance is stated.' : 'No clearance mentioned. If you hold or held one, state the level and status near the top.');
        const hasSections = /experience|employment/i.test(text) && /education/i.test(text);
        add(hasSections, hasSections ? 'Standard sections found (experience, education).' : 'Standard section headings (Experience, Education) were not found. Tracking systems look for them.');
        if (f.multiColumn) add(false, 'This looks like a multi-column layout. We read it in order, but many applicant tracking systems do not. A single-column version is safer for online applications.');
        else if (f.tables) add(false, 'This file uses tables. Tracking systems can scramble table content, so plain paragraphs and bullets are safer.');
        else if (f.kind === 'pdf' || f.kind === 'docx') add(true, 'Simple single-column layout.');
        if (f.pages > 2) add(false, `${f.pages} pages. Two is the norm outside of federal-government-style resumes.`);
        return items;
    }

    function renderResumeCheck() {
        const text = $('resumeText').value.trim();
        const wrap = $('resumeCheck');
        if (text.length < 200) { wrap.hidden = true; return; }
        const items = runResumeCheck(text, state.fileFlags);
        const flagged = items.filter(i => !i.ok);
        wrap.hidden = false;
        $('resumeCheckSummary').textContent = flagged.length ? `Resume check: ${flagged.length} thing${flagged.length > 1 ? 's' : ''} to fix` : 'Resume check: looks good';
        wrap.querySelector('summary .icon use').setAttribute('href', flagged.length ? '#i-minus' : '#i-check');
        wrap.classList.toggle('flagged', flagged.length > 0);
        $('resumeCheckList').innerHTML = [...flagged, ...items.filter(i => i.ok)]
            .map(i => `<li class="${i.ok ? 'pass' : 'flag'}">${icon(i.ok ? 'check' : 'minus')}<span>${escapeHtml(i.msg)}</span></li>`).join('');
    }

    // ======================================================================
    // ANALYSIS (two calls: fit analysis, then market intel in the background)
    // ======================================================================
    // A missing or unusable input is reported at that input, and focus goes there. Clears when the field changes.
    function fieldError(which, message) {
        showInlineError('');
        $('jobError').textContent = which === 'job' ? message : ''; $('jobError').hidden = which !== 'job';
        $('resumeError').textContent = which === 'resume' ? message : ''; $('resumeError').hidden = which !== 'resume';
        $('jobDescription').setAttribute('aria-invalid', String(which === 'job'));
        if (which === 'job') $('jobDescription').focus();
        if (which === 'resume') { setResumeMode(true); $('resumeDrop').focus(); }
        if (which) $(which === 'job' ? 'jobCard' : 'resumeCard').scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
    }
    const clearFieldError = (which) => { const el = $(which + 'Error'); if (!el.hidden) { el.hidden = true; el.textContent = ''; if (which === 'job') $('jobDescription').setAttribute('aria-invalid', 'false'); } };

    function showInlineError(message) {
        const el = $('inlineError');
        el.textContent = message || '';
        el.hidden = !message;
    }

    // The inputs never move; the answer column swaps between empty, loading and ready.
    function setResultState(mode) {
        $('resultEmpty').hidden = mode !== 'empty';
        $('loading').hidden = mode !== 'loading';
        $('verdictWrap').hidden = mode !== 'ready';
        $('batchWrap').hidden = mode !== 'batch';
        $('peekInline').hidden = mode !== 'empty';
        $('results').hidden = mode !== 'ready';
        const calc = document.querySelector('.calc');
        calc.classList.toggle('has-result', mode !== 'empty');
        calc.classList.remove('editing');      // on phones the form folds to one line under a result until "Change" is pressed
        const a = state.analysis;
        $('inputsFoldText').textContent = mode === 'batch' ? 'Your comparison' : state.isExample ? 'The sample job and resume' : (a && a.job_title) ? `${a.job_title}${a.company && !/not specified|unknown/i.test(a.company) ? ' at ' + a.company : ''}` : 'Your job and resume';
        if (mode === 'empty') {
            $('emptyPlain').hidden = false;
            $('examplePreview').hidden = false;
            $('exampleLink').hidden = false;
            $('peekRows').innerHTML = requirementRows(keyRequirements(EXAMPLE_ANALYSIS).filter((r, i) => i === 0 || i === 3));
            $('peekInlineRow').innerHTML = requirementRows(keyRequirements(EXAMPLE_ANALYSIS).slice(0, 1));
            document.body.classList.remove('example-compact');
            if (isFirstVisit()) showExamplePreview();
        }
    }
    function showInputs() { /* inputs are always visible in this layout */ }

    // One check is one request with no progress to report, so the bar only shows that work is under way.
    // Comparisons set a real "2 of 4" count and width themselves (see runBatch).
    function startLoading() {
        setResultState('loading');
        setLoadingProgress(null);
        $('loadingStep').textContent = 'Checking your fit...';
        revealResult();
        clearInterval(state.loadingTimer);
    }
    function setLoadingProgress(percent) {
        const bar = $('loadingProgress');
        bar.parentElement.classList.toggle('indeterminate', percent === null);
        bar.style.width = percent === null ? '' : percent + '%';
        if (percent === null) bar.parentElement.removeAttribute('aria-valuenow'); else bar.parentElement.setAttribute('aria-valuenow', String(percent));
    }

    // Scrolling follows the visitor's motion setting, and only happens when the target is not already in view.
    const scrollBehavior = () => (reducedMotion() ? 'auto' : 'smooth');
    function revealResult() {
        const r = $('resultCol').getBoundingClientRect();
        if (r.top < 0 || r.top > window.innerHeight * 0.5) $('resultCol').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }

    function stopLoading() {
        clearInterval(state.loadingTimer);
        $('loading').hidden = true;
    }

    const jobKey = (jd) => jd.replace(/\s+/g, ' ').trim().substring(0, 160) + '|' + jd.length;

    // Anything that swaps the job on screen calls this first, so a slow reply for the old job is ignored.
    function resetAnalyzeUi() {
        stopReadingLink();
        state.runId++;
        state.batch = null;
        $('compareVersionsBtn').disabled = false;
        stopLoading();
        $('analyzeBtn').disabled = false;
        $('btnText').textContent = idleLabel();
    }

    const textHead = (t) => String(t || '').replace(/\s+/g, ' ').trim().substring(0, 80).toLowerCase();

    // The job box was replaced by hand: forget which posting or tracker entry it used to be.
    function jobReplaced() {
        if (state.linkHelp === 'kept' || state.linkHelp === 'read') return;      // the link stays with the job while its text is checked, fixed or pasted in
        state.postingUrl = ''; state.trackedId = null; state.linkedText = '';
        if (state.linkHelp) { state.linkHelp = null; renderLinkHelp(); }
    }

    // The banner under the job box: a link being read, a link that was read (check it), or a link kept for the tracker.
    function renderLinkHelp() {
        const mode = state.linkHelp, box = $('jobLinkHelp');
        box.hidden = !mode || !isUrl(state.postingUrl);
        if (box.hidden) return;
        box.className = 'banner ' + (mode === 'read' ? 'warn' : 'info');
        const title = mode === 'read' && state.linkTitle ? `<strong>${escapeHtml(state.linkTitle)}</strong>. ` : '';
        $('jobLinkMsg').innerHTML = mode === 'reading' ? 'Reading the posting from this link...'
            : mode === 'read' ? `Read from the link: ${title}Check that this is the right posting, then run the check.`
            : 'Link kept for your tracker:';
        $('jobLinkAnchor').textContent = state.postingUrl;
        $('jobLinkAnchor').href = state.postingUrl;
        $('dropLinkBtn').hidden = mode === 'reading';
    }
    function dropLink() { stopReadingLink(); state.postingUrl = ''; state.linkHelp = null; state.linkTitle = ''; renderLinkHelp(); $('jobDescription').focus(); }

    // The link could not be read, or did not look like one posting: keep it for the tracker and ask for the text.
    const LINK_MSG = 'We couldn\'t read that link. Open the posting, copy the whole job description, and paste it here.';
    function linkToPaste(url, message) {
        state.postingUrl = url.trim(); state.linkHelp = 'kept'; state.linkedText = ''; state.linkTitle = '';
        $('jobDescription').value = '';
        showInlineError(''); updateCounts(); renderLinkHelp();
        fieldError('job', message || LINK_MSG);
    }

    // A link is read first and its text put in the job box for the visitor to check. It is never scored unseen:
    // job sites sometimes return a sign-in page or a different job, and that must not become a wrong answer.
    async function readLink(url, opts = {}) {
        url = url.trim();
        if (state.readingLink === url) return;
        const read = ++state.readSeq, box = $('jobDescription'), btn = $('analyzeBtn');
        state.readingLink = url; state.postingUrl = url; state.linkHelp = 'reading'; state.linkedText = ''; state.linkTitle = '';
        state.exampleDismissed = true;
        box.value = url; box.readOnly = true;
        fieldError(null); showInlineError(''); updateCounts(); renderLinkHelp();
        btn.disabled = true; $('btnText').textContent = 'Reading the posting...';
        let result = null, failure = '';
        try { result = await api({ request_type: 'read_posting', url }); }
        catch (e) { failure = e.transient || /not available yet/i.test(e.message) ? LINK_MSG : e.message; }
        if (read !== state.readSeq) return;                       // a newer link, or a new job, took over
        state.readingLink = ''; box.readOnly = false;
        btn.disabled = false; $('btnText').textContent = idleLabel();
        if (!result || !result.text) { linkToPaste(url, failure || LINK_MSG); if (opts.trackedId != null) state.trackedId = opts.trackedId; return; }
        box.value = result.text; box.scrollTop = 0;
        state.linkHelp = 'read'; state.linkedText = result.text; state.linkTitle = tidy(result.title || '', 140);
        if (opts.trackedId != null) state.trackedId = opts.trackedId;
        updateCounts(); renderLinkHelp();
        $('jobCard').scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
        box.focus({ preventScroll: true }); box.setSelectionRange(0, 0);
        if (result.truncated) snackbar(`That posting is long: the first ${MAX_JD_CHARS.toLocaleString()} characters were kept.`, 6000);
        track('posting_link_read');
    }
    const stopReadingLink = () => { if (state.readingLink) { state.readSeq++; state.readingLink = ''; $('jobDescription').readOnly = false; $('analyzeBtn').disabled = false; $('btnText').textContent = idleLabel(); } };

    async function analyzeJob() {
        const jd = $('jobDescription').value.trim();
        const resume = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        fieldError(null);
        // Step 1 is the job, so that is asked for first.
        if (state.readingLink) return;
        if (!jd) return fieldError('job', 'Paste the job description, or a link to the posting.');
        if (isUrl(jd)) return readLink(jd);
        if (!resume) return fieldError('resume', state.pendingOcrFile ? 'Your PDF had no readable text. Use "Read with AI" above, or paste your resume text.' : 'Add your resume: drop in a PDF or Word file, or paste the text.');
        if (resume.length < 100) return fieldError('resume', 'That resume is too short to check. Add more detail.');
        if (state.resumeSource === 'example' && resume === state.exampleResume && jd !== state.exampleJd) return fieldError('resume', 'That is the example resume, not yours. Add your own resume to check a real job.');

        resetAnalyzeUi();
        const run = state.runId, stale = () => run !== state.runId;
        // If the box now holds a different job than the one a link or tracker entry was attached to, drop that attachment.
        if (state.linkedText && textHead(jd) !== textHead(state.linkedText)) jobReplaced();
        renderLinkHelp();
        const btn = $('analyzeBtn');
        btn.disabled = true;
        $('btnText').textContent = 'Checking...';
        startLoading();
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                if (attempt > 1) { $('btnText').textContent = `Retrying (${attempt} of ${MAX_RETRIES})...`; await sleep(RETRY_DELAY_MS); if (stale()) return; }
                const data = await api({ request_type: 'resume_match', job_description: jd, resume_text: resume, military_transition: isMilitary() });
                if (stale()) return;          // the user moved on to another job while this was running
                // If a link was given, the backend returns the text it fetched:
                // show it and use it for every follow-up call.
                state.jd = jd;
                if (data.job_description_text) {
                    state.jd = data.job_description_text;
                    $('jobDescription').value = state.jd;
                    delete data.job_description_text;
                    updateCounts();
                }
                state.linkHelp = null; renderLinkHelp();
                state.linkedText = state.jd;
                state.resumeText = resume;
                if (state.resumeSource === 'example' && resume !== state.exampleResume) state.resumeSource = '';
                setResumeMode(false);
                verifyKeywords(data, resume);
                const key = jobKey(state.jd);
                const previous = state.lastScores[key];
                state.lastScores[key] = data.score;
                state.analysis = data;
                state.isExample = false;
                resetGenerated();
                stopLoading();
                renderResults(data, previous);
                // A job opened from the tracker is already the user's saved record: fill it in.
                if (state.trackedId != null && findJob(state.trackedId)) saveToTracker({ quiet: true });
                fetchMarketIntel();
                track('analysis_complete', { score: data.score, military: isMilitary() });
                lastError = null;
                break;
            } catch (e) {
                if (stale()) return;
                lastError = e;
                if (!e.transient) break;
            }
        }
        btn.disabled = false;
        $('btnText').textContent = idleLabel();
        if (lastError) {
            stopLoading();
            setResultState(state.analysis ? 'ready' : 'empty');
            showInlineError(lastError.message);
            $('analyzeBar').scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
        }
    }

    // ======================================================================
    // COMPARE: several jobs for one resume, or several resume versions for one job.
    // Each pairing is one ordinary fit check; the results are kept in memory
    // and ranked, and any one of them opens as a normal full result.
    // ======================================================================
    const EXTRA_JOB_IDS = ['extraJob1', 'extraJob2', 'extraJob3'];
    const MAX_VERSIONS = 5;
    const extraJobs = () => EXTRA_JOB_IDS.map(id => $(id).value.trim()).filter(Boolean);
    const idleLabel = () => { const n = extraJobs().length; return n ? `Compare ${n + 1} jobs` : 'Check this job'; };

    // The user's resume versions: saved ones (newest first), plus what is in the box if it is not one of them.
    function resumeVersions() {
        const saved = getSavedResumes();
        const list = Object.keys(saved).sort((a, b) => (saved[b].savedAt || '').localeCompare(saved[a].savedAt || ''))
            .map(name => ({ name, text: (saved[name].text || '').trim().substring(0, MAX_RESUME_CHARS) })).filter(v => v.text.length >= 100);
        const current = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        if (current.length >= 100 && state.resumeSource !== 'example' && !list.some(v => v.text === current)) list.unshift({ name: 'Resume in the box (not saved)', text: current });
        return list.slice(0, MAX_VERSIONS);
    }

    function updateBatchUi() {
        const n = extraJobs().length;
        $('moreJobsState').textContent = n ? `${n} added` : 'optional';
        if (!$('analyzeBtn').disabled) $('btnText').textContent = idleLabel();
        const versions = resumeVersions().length, btn = $('compareVersionsBtn');
        btn.hidden = versions < 2;
        $('compareVersionsText').textContent = `Compare my ${versions} resume versions for this job`;
    }

    function runCheck() { return extraJobs().length ? compareJobs() : analyzeJob(); }

    function compareJobs() {
        const resume = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        fieldError(null);
        if (!$('jobDescription').value.trim()) return fieldError('job', 'Add the first job here, then the others below it.');
        if (resume.length < 100) return fieldError('resume', 'Add your resume: drop in a PDF or Word file, or paste the text.');
        if (state.resumeSource === 'example') return fieldError('resume', 'That is the example resume, not yours. Add your own resume first.');
        const first = $('jobDescription').value.trim();
        if (!first) return fieldError('job', 'Add the first job here, then the others below it.');
        const linkAt = [first, ...extraJobs()].findIndex(isUrl);
        if (linkAt === 0) return readLink(first);
        if (linkAt > 0) return fieldError('job', 'One of the extra jobs is a link. Paste its job description text there instead: only the first box reads links.');
        const seen = new Set(), jobs = [];
        [first, ...extraJobs()].forEach(jd => { const key = isUrl(jd) ? normalizeUrl(jd) : jobKey(jd); if (!seen.has(key)) { seen.add(key); jobs.push(jd); } });
        if (jobs.length < 2) return fieldError('job', 'Those are the same job. Add a different posting to compare.');
        return runBatch('jobs', jobs.map((jd, i) => ({ jd, resumeText: resume, slot: i })));
    }

    function compareVersions() {
        fieldError(null);
        const jd = $('jobDescription').value.trim();
        if (!jd) return fieldError('job', 'Add the job here first, then compare your resume versions against it.');
        if (isUrl(jd)) return readLink(jd);
        const versions = resumeVersions();
        if (versions.length < 2) return fieldError('resume', 'Save at least two versions of your resume to compare them.');
        return runBatch('versions', versions.map(v => ({ jd, resumeText: v.text, resumeName: v.name })));
    }

    async function batchCall(item) {
        for (let attempt = 1; ; attempt++) {
            try { return await api({ request_type: 'resume_match', job_description: item.jd, resume_text: item.resumeText, military_transition: isMilitary() }); }
            catch (e) { if (!e.transient || attempt >= MAX_RETRIES) throw e; await sleep(RETRY_DELAY_MS); }
        }
    }

    async function runBatch(kind, items) {
        // A link pasted earlier was kept for the tracker: it belongs to the job in the first box.
        const keptLink = (state.linkHelp === 'kept' || state.linkHelp === 'read') && isUrl(state.postingUrl) ? state.postingUrl : '';
        if (keptLink) (kind === 'versions' ? items : items.slice(0, 1)).forEach(item => { item.url = keptLink; });
        resetAnalyzeUi();
        const run = state.runId, stale = () => run !== state.runId;
        state.batch = { kind, items };
        state.analysis = null; state.isExample = false; state.previewOnly = false;
        state.trackedId = null; state.postingUrl = ''; state.linkHelp = null; state.linkedText = '';
        resetGenerated(); renderLinkHelp();
        document.body.classList.remove('example-compact');
        $('analyzeBtn').disabled = true; $('compareVersionsBtn').disabled = true;
        setResultState('loading');
        clearInterval(state.loadingTimer);
        $('resultCol').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            $('btnText').textContent = `Checking ${i + 1} of ${items.length}...`;
            $('loadingStep').textContent = kind === 'jobs' ? `Checking job ${i + 1} of ${items.length} against your resume...` : `Checking "${item.resumeName}" (${i + 1} of ${items.length})...`;
            setLoadingProgress(Math.round(8 + (i / items.length) * 88));
            try {
                const data = await batchCall(item);
                if (stale()) return;
                verifyKeywords(data, item.resumeText);
                item.analysis = data;
            } catch (e) {
                if (stale()) return;
                item.error = e.message || 'This one could not be checked.';
            }
        }
        $('analyzeBtn').disabled = false; $('compareVersionsBtn').disabled = false;
        $('btnText').textContent = idleLabel();
        stopLoading();
        if (!items.some(it => it.analysis)) {
            state.batch = null;
            setResultState('empty');
            showInlineError(items[0].error || 'The comparison could not be run. Try again.');
            return $('analyzeBar').scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
        }
        // Rank by fit; anything that failed goes last.
        state.batch.ranked = items.filter(it => it.analysis).sort((a, b) => (b.analysis.score || 0) - (a.analysis.score || 0)).concat(items.filter(it => !it.analysis));
        restoreBatchInputs();
        renderBatch();
        track('compare_complete', { kind, count: items.length });
    }

    // After a jobs comparison the first box shows job 1 again (as text, if it was a link).
    function restoreBatchInputs() {
        const b = state.batch;
        if (!b) return;
        const first = b.kind === 'jobs' ? b.items.find(it => it.slot === 0) : b.items[0];
        if (first && first.jd) { $('jobDescription').value = first.jd; updateCounts(); }
    }

    const batchRole = (a) => (a.job_title || 'Role') + (knownCompany(a.company) ? ' at ' + knownCompany(a.company) : '');
    const batchCall4 = (a) => { const rec = deriveRecommendation(a, a.score || 0); return { rec, meta: ACTIONS_META[rec.action] || ACTIONS_META.fix_first, label: (rec.label || (ACTIONS_META[rec.action] || {}).label || '').replace(/\.$/, '') }; };

    function renderBatch() {
        const b = state.batch;
        if (!b) return;
        const ok = b.ranked.filter(it => it.analysis), top = ok[0], second = ok[1];
        const isJobs = b.kind === 'jobs';
        const lead = second ? Math.round(top.analysis.score) - Math.round(second.analysis.score) : null;
        const topCall = batchCall4(top.analysis);
        $('batchVerdict').dataset.tone = topCall.meta.tone;
        $('batchKind').textContent = isJobs ? `${ok.length} jobs, ranked for your resume` : `${ok.length} resume versions, ranked for ${batchRole(top.analysis)}`;
        $('batchTitle').textContent = isJobs ? `Start with ${batchRole(top.analysis)}.` : `Send "${top.resumeName}".`;
        let why;
        if (lead === null) why = isJobs ? 'Only one of these could be checked.' : 'Only one version could be checked.';
        else if (lead <= 2) why = isJobs ? `It is close: the top two are within ${lead === 0 ? 'a point' : lead + (lead === 1 ? ' point' : ' points')} of each other, so let pay, location and the hiring team decide.`
            : `It is close: the top two versions are within ${lead === 0 ? 'a point' : lead + (lead === 1 ? ' point' : ' points')}. Open each to see which requirements one covers that the other does not.`;
        else why = isJobs ? `It leads the next job by ${lead} points of resume fit. Open any job for the full answer.` : `It leads the next version by ${lead} points for this job. Open it to see the full answer.`;
        $('batchWhy').textContent = why;
        $('batchList').innerHTML = b.ranked.map((it, i) => {
            const idx = b.items.indexOf(it);
            if (!it.analysis) return `<div class="batch-row failed"><span class="batch-rank">${icon('minus')}</span><span class="batch-text"><span class="title-sm">${escapeHtml(isJobs ? `Job ${it.slot + 1} could not be checked` : it.resumeName)}</span><span class="body-sm">${escapeHtml(it.error)}</span></span></div>`;
            const a = it.analysis, call = batchCall4(a), { matches: strengths, gaps } = splitAnalysis(a);
            const kws = Array.isArray(a.keywords) ? a.keywords : [], kwPct = kws.length ? Math.round(kws.filter(k => k.in_resume).length / kws.length * 100) : null;
            const firstGap = gaps[0] ? gaps[0].replace(/^Gap:\s*/i, '').split(/\s*(?:→|->)\s*/)[0] : '';
            const sub = isJobs
                ? [call.label, firstGap ? 'Biggest gap: ' + firstGap : 'No major gaps']
                : [call.label, `${strengths.length} ${strengths.length === 1 ? 'match' : 'matches'}, ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'}`, kwPct === null ? '' : `${kwPct}% of keywords`];
            return `<button type="button" class="batch-row" data-batch-open="${idx}"><span class="batch-rank">${i + 1}</span><span class="batch-text"><span class="title-sm">${escapeHtml(isJobs ? batchRole(a) : it.resumeName)}</span><span class="body-sm">${escapeHtml(sub.filter(Boolean).join(' · '))}</span></span><span class="score-pill ${scoreBand(a.score)}" title="Resume fit">${Math.round(a.score) || 0}</span>${icon('chevron')}<span class="sr">Open the full result</span></button>`;
        }).join('');
        $('batchOpenTop').dataset.batchOpen = String(b.items.indexOf(top));
        $('batchOpenTopText').textContent = isJobs ? 'Open the top job' : 'Use the top version';
        const saveAll = $('batchSaveAll');
        saveAll.hidden = !isJobs;
        saveAll.disabled = !!b.savedAll;
        $('batchSaveAllText').textContent = b.savedAll ? 'Saved to tracker' : `Save all ${ok.length} to tracker`;
        setResultState('batch');
    }

    function openBatchItem(index) {
        const b = state.batch, it = b && b.items[index];
        if (!it || !it.analysis) return;
        $('jobDescription').value = it.jd;
        state.jd = it.jd; state.postingUrl = it.url || ''; state.linkedText = it.jd; state.linkHelp = null;
        state.trackedId = it.trackedId != null && findJob(it.trackedId) ? it.trackedId : null;
        if (b.kind === 'versions' && $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS) !== it.resumeText) {
            $('resumeText').value = it.resumeText;
            state.fileFlags = null; state.fileName = ''; state.resumeSource = 'saved';
            setFileStatus(); onResumeChanged(); setResumeMode(false);
        }
        state.resumeText = it.resumeText;
        state.analysis = it.analysis; state.isExample = false;
        resetGenerated(); updateCounts(); renderLinkHelp();
        renderResults(it.analysis);
        if (state.trackedId != null) setSaveButton(true, 'In your tracker');
        if (!it.analysis.salary_intel && !it.intelAsked) { it.intelAsked = true; fetchMarketIntel(); }
        $('resultCol').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }

    function backToBatch() {
        if (!state.batch) return;
        state.analysis = null; state.trackedId = null; state.postingUrl = ''; state.linkedText = '';
        resetGenerated();
        restoreBatchInputs();
        renderBatch();
        $('resultCol').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }

    // Saves every checked job with its analysis, through the same path as the Save button.
    function saveBatchJobs() {
        const b = state.batch;
        if (!b || b.kind !== 'jobs') return;
        const keep = { analysis: state.analysis, jd: state.jd, postingUrl: state.postingUrl, trackedId: state.trackedId, linkedText: state.linkedText };
        let saved = 0, failed = false;
        for (const it of b.items) {
            if (!it.analysis) continue;
            Object.assign(state, { analysis: it.analysis, jd: it.jd, postingUrl: it.url || '', trackedId: null });
            if (saveToTracker({ silent: true }) === true) { saved++; it.trackedId = state.trackedId; } else { failed = true; break; }
        }
        Object.assign(state, keep);
        if (failed) return;                      // saveToTracker has already said why
        b.savedAll = true;
        renderBatch();
        snackbar(`${saved} jobs saved to your tracker with their scores.`);
    }

    async function fetchMarketIntel() {
        const requestedFor = state.analysis;
        try {
            const intel = await api({ request_type: 'market_intel', job_description: state.jd, job_title: requestedFor.job_title, company: requestedFor.company });
            if (state.analysis !== requestedFor) return;   // user moved on to another job
            Object.assign(requestedFor, { salary_intel: intel.salary_intel, competition: intel.competition, company_intel: intel.company_intel, timeline: intel.timeline });
            if (state.tracked.some(j => j.analysis === requestedFor)) persistTracker();   // already saved: keep the pay data with it
            renderIntel(requestedFor);
            buildTemplates(requestedFor);
        } catch (e) {
            if (state.analysis !== requestedFor) return;
            $('salaryRange').textContent = 'Unavailable';
            $('salaryEstimate').textContent = 'n/a';
            $('competitionLevel').textContent = 'n/a';
            $('competitionDesc').textContent = 'Market intel could not be loaded for this job. Your fit analysis is unaffected.';
        }
    }

    // The AI decides keyword matches; this corrects the obvious misses where
    // the exact term is sitting in the resume text.
    function verifyKeywords(data, resume) {
        if (!Array.isArray(data.keywords) || !resume) return;
        const norm = (s) => s.toLowerCase().replace(/[^a-z0-9+#./&-]+/g, ' ').trim();
        const hay = ' ' + norm(resume) + ' ';
        data.keywords.forEach(k => {
            if (!k || typeof k.term !== 'string' || k.in_resume) return;
            const needle = norm(k.term);
            if (needle.length >= 2 && hay.includes(' ' + needle + ' ')) k.in_resume = true;
        });
    }

    function splitAnalysis(data) {
        const lines = Array.isArray(data.analysis) ? data.analysis.filter(x => typeof x === 'string') : [];
        const isGap = (x) => /^\s*(gap|risk|missing)\b/i.test(x) || (!/^\s*(match|strength)\b/i.test(x) && /gap|risk|missing/i.test(x));
        const clean = (x) => x.replace(/^\s*(match|strength|gap|risk|missing)\s*:\s*/i, '').trim();
        return { gaps: lines.filter(isGap).map(clean), matches: lines.filter(x => !isGap(x)).map(clean) };
    }

    // ======================================================================
    // RESULTS
    // ======================================================================
    const scoreBand = (score) => score >= 75 ? 'high' : score >= 55 ? 'mid' : 'low';

    function setSaveButton(saved, label) {
        const btn = $('saveToTrackerBtn');
        btn.disabled = saved;
        btn.querySelector('span').textContent = label || 'Save to tracker';
        btn.querySelector('use').setAttribute('href', saved ? '#i-bookmark-fill' : '#i-bookmark');
    }

    function resetGenerated() {
        state.tailored = null; state.tailorScore = null; state.tailorKeywords = null; state.tailorPairs = null; state.tailorUnmatched = 0; state.chat = [];
        $('tailoredWrap').hidden = true;
        syncTailorUi();
        $('linkedinList').innerHTML = '';
        $('emailWrap').hidden = true;
        $('chat').innerHTML = '';
        $('recruiterQuestion').value = '';
    }

    function listItems(container, lines, kind) {
        container.innerHTML = lines.length ? lines.map(line => {
            const [head, ...rest] = line.split(/\s*(?:→|->|=>)\s*/);
            return `<div class="list-item"><svg class="icon lead ${kind}" aria-hidden="true"><use href="#i-${kind === 'ok' ? 'check' : 'minus'}"/></svg><div><div class="headline-text">${escapeHtml(head)}</div>${rest.length ? `<div class="support-text">${escapeHtml(rest.join(' '))}</div>` : ''}</div></div>`;
        }).join('') : `<div class="list-item"><div class="support-text">${kind === 'ok' ? 'No clear strengths were identified.' : 'No significant gaps were identified.'}</div></div>`;
    }

    function renderResults(data, previousScore) {
        setResultState('ready');
        showPanel('overview');
        $('backToBatch').hidden = !state.batch;

        // Verdict: the number first, then the call, then why
        const score = Math.max(0, Math.min(100, Math.round(Number(data.score) || 0)));
        $('scoreNum').textContent = score;       // shown at once, with the call and the evidence beside it
        $('exampleTag').hidden = !state.isExample;
        $('exampleNote').hidden = !state.isExample;
        $('exampleLink').hidden = state.isExample;
        document.body.classList.toggle('example-compact', !!(state.isExample && state.previewOnly));
        const company = knownCompany(data.company);
        $('roleLine').textContent = (data.job_title || 'Role') + (company ? ' at ' + company : '');
        renderRecommendation(data, score);
        syncTailorUi();
        const delta = $('scoreDelta');
        if (typeof previousScore === 'number') {
            const d = score - previousScore;
            delta.hidden = false;
            delta.className = 'chip sm';
            delta.textContent = d === 0 ? 'No change from last run' : `${d > 0 ? '+' : ''}${d} from last run`;
        } else delta.hidden = true;
        setSaveButton(false);
        $('printMeta').textContent = new Date().toLocaleDateString();
        animateIn($('verdict'), 'enter');

        // Overview
        const { gaps, matches } = splitAnalysis(data);
        $('strengthsCount').textContent = matches.length;
        $('gapsCount').textContent = gaps.length;
        listItems($('strengthsList'), matches, 'ok');
        listItems($('gapsList'), gaps, 'gap');
        renderFitSignals(data);
        renderIntel(data);
        renderLinks(data);

        // Resume
        renderKeywords(data);
        $('resumeOutput').textContent = data.tailored_summary || '';
        renderBulletRewrites(data);
        const mil = Array.isArray(data.military_translation) ? data.military_translation.filter(m => m && m.military && m.civilian) : [];
        $('militaryBlock').hidden = !mil.length;
        $('militaryList').innerHTML = mil.map(m => `<tr><td>${escapeHtml(m.military)}</td><td>${escapeHtml(m.civilian)}</td></tr>`).join('');

        // Interview
        const qs = Array.isArray(data.interview_questions) ? data.interview_questions : [];
        $('interviewQuestionsSection').hidden = !qs.length;
        $('interviewQuestionsList').innerHTML = qs.map((q, i) => `<details class="disclosure qa"${i === 0 ? ' open' : ''}><summary><span>${escapeHtml(q.question)}</span>${icon('chevron').replace('class="icon"', 'class="icon chev"')}</summary><div class="disclosure-body"><p class="label-md muted">SUGGESTED ANSWER</p><p class="body-md">${escapeHtml(q.suggested_answer)}</p></div></details>`).join('');
        const gs = Array.isArray(data.gap_strategies) ? data.gap_strategies : [];
        $('gapStrategiesSection').hidden = !gs.length;
        $('gapStrategiesList').innerHTML = gs.map(s => `<div class="rewrite"><div class="before"><span class="tag">Gap</span>${escapeHtml(s.gap)}</div><div class="after"><span class="tag">Strategy</span>${escapeHtml(s.strategy)}${s.talking_points ? `<div class="why">Say: "${escapeHtml(s.talking_points)}"</div>` : ''}</div></div>`).join('');
        const ask = Array.isArray(data.questions_to_ask) ? data.questions_to_ask.filter(q => q && q.question) : [];
        $('questionsToAskSection').hidden = !ask.length;
        $('questionsToAskList').innerHTML = ask.map(q => `<div class="list-item"><div><div class="headline-text">${escapeHtml(q.question)}</div>${q.why ? `<div class="support-text">${escapeHtml(q.why)}</div>` : ''}</div></div>`).join('');

        // Outreach
        buildTemplates(data);

        ['strengthsList', 'gapsList', 'interviewQuestionsList', 'questionsToAskList'].forEach(id => $(id).classList.add('stagger'));
        if (!state.isExample) revealResult();
    }

    // The decision the job seeker came for: is this role worth my time, and what do I do next?
    // Uses the AI's call when present; otherwise a rule of thumb from the score and clearance.
    const ACTIONS_META = {
        apply:               { tone: 'good',    label: 'Apply now.',                     cta: ['spark', 'Tailor my resume to this job'] },
        fix_first:           { tone: 'caution', label: 'Tailor your resume first.',      cta: ['spark', 'Tailor my resume to this job'] },
        confirm_requirement: { tone: 'caution', label: 'Confirm a requirement first.',   cta: ['copy', 'Copy recruiter question'] },
        skip:                { tone: 'bad',     label: 'Prioritize other roles.',        cta: ['next', 'Explore other roles'] }
    };

    function deriveRecommendation(data, score) {
        const r = data.recommendation;
        if (r && ACTIONS_META[r.action] && r.headline) return r;
        const { gaps } = splitAnalysis(data);
        const c = data.clearance || {};
        const clearanceGap = c.status === 'gap';
        const action = score < 50 ? 'skip' : clearanceGap ? 'confirm_requirement' : score >= 75 ? 'apply' : 'fix_first';
        const headline = {
            apply: 'You are a strong fit. Apply now, and lead with your best-matching results.',
            fix_first: 'Worth pursuing, but close the biggest gaps in your resume before you apply.',
            confirm_requirement: `The rest of your record fits, but the posting requires ${c.required}. Ask whether that is firm before you spend time tailoring.`,
            skip: 'This role is a reach on paper. Put your time into closer matches.'
        }[action];
        const reasons = [];
        gaps.slice(0, 2).forEach(g => reasons.push(g.split(/\s*(?:→|->)\s*/)[0] + '.'));
        return { action, headline, reasons, next_step: '', label: action === 'confirm_requirement' ? 'Confirm the clearance first.' : '' };
    }

    // A message the candidate can send as-is. The AI writes it for "confirm" verdicts; this is the fallback.
    function recruiterQuestion(data, r) {
        if (r.recruiter_question && r.recruiter_question.trim()) return r.recruiter_question.trim();
        const role = data.job_title || 'this';
        const c = data.clearance || {};
        if (c.status === 'gap') {
            // Say what the candidate holds only when the resume states it. A resume that is silent on
            // clearance is not a statement that they have none, so the question is asked without it.
            const stated = c.candidate && !/not (stated|shown|listed|specified|mentioned)|^none|unknown|unclear|^n\/?a$/i.test(c.candidate.trim());
            return stated
                ? `Hi [Name], I'm interested in the ${role} role. The posting lists ${c.required}, and my resume shows ${c.candidate}. Is ${c.required} required on day one, or would you consider a candidate at my level? Thank you.`
                : `Hi [Name], I'm interested in the ${role} role. The posting lists ${c.required}. Is that required on day one, or is there flexibility for the right candidate? Thank you.`;
        }
        return `Hi [Name], I'm interested in the ${role} role. Before I apply, could you tell me which of the listed requirements are firm and which are flexible? Thank you.`;
    }

    // The comparison at the heart of the result: what the posting asks for, next to what the resume shows.
    // One status vocabulary across the site: Met, Partly, Confirm, Not shown (the recruiter page uses the same four).
    const REQ_STATUS = { met: ['status-ok', 'Met'], partial: ['warn', 'Partly'], missing: ['bad', 'Not shown'], verify: ['warn', 'Confirm'] };
    function keyRequirements(data) {
        const clean = (x) => (typeof x === 'string' ? x.trim() : '');
        let rows = (Array.isArray(data.requirements) ? data.requirements : []).map(r => r && ({
            requirement: clean(r.requirement), shows: clean(r.resume_shows),
            type: /^pref/i.test(r.type) ? 'preferred' : /^req/i.test(r.type) ? 'required' : '',
            status: REQ_STATUS[r.status] ? r.status : 'verify',
            knockout: r.screen_out === true
        })).filter(r => r && r.requirement);
        if (!rows.length) {
            // Older answers have no requirement list: build one from the clearance check and the fit signals.
            const c = data.clearance || {};
            if (c.required && !/^none/i.test(c.required) && c.status !== 'not_required') rows.push({ requirement: c.required, shows: c.candidate || 'Not stated', type: 'required', status: { meets: 'met', gap: 'missing' }[c.status] || 'verify' });
            (Array.isArray(data.fit_signals) ? data.fit_signals : []).forEach(f => {
                if (!f || !f.signal || /clearance/i.test(f.signal)) return;
                rows.push({ requirement: [f.signal, f.role_expects].filter(Boolean).join(': '), shows: clean(f.resume_shows) || 'Not shown', type: '', status: { strong: 'met', partial: 'partial', missing: 'missing' }[f.status] || 'verify' });
            });
        }
        // Screen-out checks lead: a recruiter rejects on these before reading anything else.
        const knock = rows.filter(r => r.knockout).slice(0, 4);
        return knock.length ? [...knock, ...rows.filter(r => !r.knockout).slice(0, Math.max(2, 5 - knock.length))] : rows.slice(0, 4);
    }
    // The requirement list in the answer: screen-out checks first with a one-line tally, then the rest.
    function requirementList(rows) {
        if (!rows.length) return '';
        const knock = rows.filter(r => r.knockout), rest = rows.filter(r => !r.knockout);
        if (!knock.length) return `<p class="req-head">The posting asks for</p>${requirementRows(rows)}`;
        const open = knock.filter(r => r.status !== 'met');
        const tally = !open.length ? (knock.length === 1 ? 'Your resume shows it.' : `Your resume shows all ${knock.length}.`)
            : `${open.length} of ${knock.length} ${open.length === 1 ? 'is' : 'are'} not clear on your resume. Fix or confirm ${open.length === 1 ? 'it' : 'them'} before you apply.`;
        return `<p class="req-head">Recruiters screen on ${knock.length === 1 ? 'this' : 'these'} first</p><p class="req-tally${open.length ? ' open' : ''}" id="knockoutTally">${escapeHtml(tally)}</p>${requirementRows(knock)}`
            + (rest.length ? `<p class="req-head rest">Other requirements</p>${requirementRows(rest)}` : '');
    }
    const requirementRows = (rows) => rows.map(r => `<div class="req"><div class="req-main"><span class="req-what">${r.type ? `<span class="req-tag">${r.type === 'required' ? 'Required' : 'Preferred'}</span>` : ''}<b>${escapeHtml(r.requirement)}</b></span><span class="req-shows">Your resume: ${escapeHtml(r.shows || 'Not shown')}</span></div><span class="chip sm ${REQ_STATUS[r.status][0]}">${REQ_STATUS[r.status][1]}</span></div>`).join('');

    // "Was this verdict right?": one tap, recorded as a count only (the vote, the score and the chosen reason).
    function resetFeedback() {
        $('feedback').hidden = state.isExample;
        $('feedbackAsk').textContent = 'Was this verdict right?';
        $('feedbackWhy').hidden = true;
        document.querySelectorAll('#feedback [data-feedback]').forEach(b => { b.hidden = false; b.setAttribute('aria-pressed', 'false'); });
        document.querySelectorAll('#feedback [data-why]').forEach(b => { b.hidden = false; });
    }
    function giveFeedback(vote) {
        const a = state.analysis; if (!a) return;
        document.querySelectorAll('#feedback [data-feedback]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.feedback === vote)); });
        $('feedbackWhy').hidden = vote !== 'down';
        $('feedbackAsk').textContent = vote === 'up' ? 'Thanks. Good to know it held up.' : 'Thanks. That helps fix the scoring.';
        track('verdict_feedback', { vote, score: a.score, action: state.primaryAction || '' });
    }
    function giveFeedbackReason(why, text) {
        const a = state.analysis; if (!a) return;
        document.querySelectorAll('#feedback [data-why]').forEach(b => { b.hidden = b.dataset.why !== why; });
        $('feedbackAsk').textContent = `Thanks. Noted: ${text.toLowerCase()}.`;
        track('verdict_feedback_reason', { reason: why, score: a.score });
    }

    function renderRecommendation(data, score) {
        resetFeedback();
        const r = deriveRecommendation(data, score);
        const meta = ACTIONS_META[r.action];
        state.primaryAction = r.action;
        state.recruiterQuestion = recruiterQuestion(data, r);
        $('recAction').textContent = (typeof r.label === 'string' && r.label.trim()) || meta.label;
        $('verdict').dataset.tone = meta.tone;
        $('recHeadline').textContent = r.headline;

        // Evidence for the deciding requirement: clearance, when it is what stands in the way
        const c = data.clearance || {};
        const showEvidence = (c.status === 'gap' || c.status === 'meets') && !!c.required;
        const reqs = keyRequirements(data);
        $('recEvidence').hidden = !reqs.length;
        $('recEvidence').innerHTML = requirementList(reqs);

        const reasons = (Array.isArray(r.reasons) ? r.reasons : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 3);
        $('recReasons').innerHTML = reasons.map(x => `<li>${escapeHtml(x)}</li>`).join('');
        const showQuestion = r.action === 'confirm_requirement';
        $('recQuestionBox').hidden = !showQuestion;
        $('recQuestion').textContent = showQuestion ? state.recruiterQuestion : '';
        $('recNext').hidden = !r.next_step || showQuestion;
        $('recNext').innerHTML = r.next_step ? `${icon('next')}<span>Next step: ${escapeHtml(r.next_step)}</span>` : '';
        $('verdictChip').textContent = data.verdict || '';
        $('verdictChip').hidden = !data.verdict;
    }

    // One primary button, tied to the verdict.
    function runPrimaryAction() {
        if (!state.analysis) return;
        switch (state.primaryAction) {
            case 'confirm_requirement': copyText(state.recruiterQuestion, 'Question copied. Paste it into a message to the recruiter.'); break;
            case 'fix_first': case 'apply': viewTailored(); break;
            default: showView('explore');
        }
        track('primary_action', { action: state.primaryAction });
    }

    function goToEmail() {
        showPanel('outreach');
        $('emailBtn').scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
        if ($('emailWrap').hidden) writeIntroEmail($('emailBtn'));
    }

    function renderFitSignals(data) {
        const rows = Array.isArray(data.fit_signals) ? data.fit_signals.filter(s => s && s.signal) : [];
        if (!$('fitSignalsBody')) return;      // the requirement list in the answer now carries this comparison
        $('fitSignalsBlock').hidden = !rows.length;
        const chip = { strong: ['status-ok', 'Strong'], partial: ['warn', 'Partial'], missing: ['bad', 'Missing'] };
        $('fitSignalsBody').innerHTML = rows.map(s => {
            const [cls, text] = chip[s.status] || chip.partial;
            return `<tr><th scope="row">${escapeHtml(s.signal)}</th><td data-label="Role expects">${escapeHtml(s.role_expects || 'Not stated')}</td><td data-label="Your resume">${escapeHtml(s.resume_shows || 'Not shown')}</td><td class="status-cell"><span class="chip sm ${cls}">${text}</span></td></tr>`;
        }).join('');
    }

    function renderKeywords(data) {
        const keywords = (Array.isArray(data.keywords) ? data.keywords : []).filter(k => k && k.term);
        const matched = keywords.filter(k => k.in_resume).length;
        $('keywordsPercent').textContent = keywords.length ? Math.round(matched / keywords.length * 100) + '%' : 'n/a';
        $('keywordsCountLabel').textContent = keywords.length ? `${matched} in your resume, ${keywords.length - matched} missing` : '';
        $('keywordCloud').innerHTML = keywords.length ? keywords.map(k => {
            const critical = k.importance === 'critical';
            return `<span class="chip ${k.in_resume ? 'ok' : 'miss'}" title="${k.in_resume ? 'In your resume' : 'Not in your resume'}${critical ? ' (critical)' : ''}">${k.in_resume ? icon('check') : ''}${escapeHtml(k.term)}${critical ? '<span class="star" aria-label="critical">&#9733;</span>' : ''}</span>`;
        }).join('') : '<span class="body-md muted">No keywords were extracted.</span>';
    }

    function renderBulletRewrites(data) {
        const bullets = Array.isArray(data.bullet_rewrites) ? data.bullet_rewrites.filter(b => b && b.improved) : [];
        $('bulletRewritesSection').hidden = !bullets.length;
        $('bulletRewritesList').innerHTML = bullets.map((b, i) => `<div class="rewrite">
            ${b.original ? `<div class="before"><span class="tag">Current</span>${escapeHtml(b.original)}</div>` : ''}
            <div class="after"><span class="tag">Stronger</span><span id="bullet-${i}">${escapeHtml(b.improved)}</span>${b.why ? `<div class="why">${escapeHtml(b.why)}</div>` : ''}</div>
            <div class="foot"><span></span><button class="btn text" data-copy="#bullet-${i}">${icon('copy')}Copy</button></div></div>`).join('');
    }

    function renderIntel(data) {
        const sal = data.salary_intel;
        const k = (n) => '$' + Math.round(n) + 'K';
        $('compBar').hidden = true;
        $('compLegend').innerHTML = '';
        $('salaryNotes').textContent = '';
        $('compQuestionsSection').hidden = true;
        if (sal && Number(sal.low) > 0 && Number(sal.high) >= Number(sal.low)) {
            // A posting that gives one range sometimes comes back as both base and on-target pay: show it once.
            const oneRange = Number(sal.base_low) === Number(sal.low) && Number(sal.base_high) === Number(sal.high);
            const variable = !!sal.is_variable_comp && !oneRange;
            const mid = Number(sal.mid) || (sal.low + sal.high) / 2;
            const src = (v) => v === 'posting' ? 'From the posting' : 'AI estimate';
            const hasBase = variable && Number(sal.base_low) > 0 && Number(sal.base_high) >= Number(sal.base_low);
            $('compLabel').textContent = `${variable ? 'ON-TARGET EARNINGS' : 'PAY'} · ${src(sal.pay_source).toUpperCase()}`;
            $('salaryEstimateLabel').innerHTML = `${variable ? 'On-target earnings' : 'Pay'}<small>${src(sal.pay_source)}</small>`;
            $('salaryRange').textContent = `${k(sal.low)} to ${k(sal.high)}`;
            $('salaryEstimate').textContent = `${k(sal.low)} to ${k(sal.high)}`;
            $('baseRow').hidden = !hasBase;
            if (hasBase) { $('baseEstimateLabel').innerHTML = `Base salary<small>${src(sal.base_source || 'estimate')}</small>`; $('baseEstimate').textContent = `${k(sal.base_low)} to ${k(sal.base_high)}`; }
            const min = (hasBase ? Math.min(sal.base_low, sal.low) : sal.low) * 0.92, max = sal.high * 1.04;
            const pct = (v) => Math.max(0, Math.min(100, (v - min) / (max - min) * 100));
            $('compBar').hidden = false;
            $('compOte').style.left = pct(sal.low) + '%'; $('compOte').style.width = (pct(sal.high) - pct(sal.low)) + '%';
            $('compBase').hidden = !hasBase;
            if (hasBase) { $('compBase').style.left = pct(sal.base_low) + '%'; $('compBase').style.width = (pct(sal.base_high) - pct(sal.base_low)) + '%'; }
            $('compMarker').style.left = pct(mid) + '%';
            $('compMarker').dataset.label = 'Target ' + k(mid);
            $('compLegend').innerHTML = (hasBase ? `<span><i style="background:var(--secondary);opacity:.55"></i>Base ${k(sal.base_low)} to ${k(sal.base_high)}</span>` : '')
                + `<span><i style="background:var(--primary)"></i>${variable ? 'OTE' : 'Range'}</span>` + (variable && sal.pay_mix ? `<span>Mix ${escapeHtml(sal.pay_mix)}</span>` : '');
            $('salaryNotes').textContent = sal.notes || '';
            const cq = Array.isArray(sal.comp_questions) ? sal.comp_questions.filter(q => typeof q === 'string' && q) : [];
            $('compQuestionsSection').hidden = !cq.length;
            $('compQuestionsList').innerHTML = cq.map(q => `<li>${escapeHtml(q)}</li>`).join('');
        } else {
            $('compLabel').textContent = 'PAY';
            $('salaryRange').textContent = 'Loading...';
            $('salaryEstimateLabel').textContent = 'Pay';
            $('salaryEstimate').textContent = '...';
            $('baseRow').hidden = true;
        }
        const tl = data.timeline || {};
        const wk = (v) => v === undefined || v === null || v === '' ? '...' : (/wk|week|day|month/i.test(String(v)) ? String(v) : `${v} wks`);
        $('screenTime').textContent = wk(tl.screen_weeks);
        $('interviewTime').textContent = wk(tl.interview_weeks);
        $('offerTime').textContent = wk(tl.offer_weeks);
        $('timelineNotes').textContent = tl.notes || '';
        $('competitionLevel').textContent = data.competition ? (data.competition.level || 'n/a') : '...';
        $('competitionDesc').textContent = data.competition ? (data.competition.reasoning || '') : '';
    }

    function renderLinks(data) {
        const company = knownCompany(data.company);
        $('researchBlock').hidden = !company;
        $('peopleBlock').hidden = !company;
        if (!company) return;
        const enc = encodeURIComponent(company);
        const link = (href, label) => `<a class="chip" href="${href}" target="_blank" rel="noopener">${icon('open')}${label}</a>`;
        const people = (q) => `https://www.linkedin.com/search/results/people/?keywords=${enc}%20AND%20(${encodeURIComponent(q).replace(/%20OR%20/g, '%20OR%20')})`;
        $('researchCompany').textContent = company;
        $('networkCompany').textContent = company;
        $('researchLinks').innerHTML = link(`https://www.glassdoor.com/Search/results.htm?keyword=${enc}`, 'Glassdoor')
            + link(`https://www.google.com/search?q=${enc}+contract+award+news`, 'Contract news')
            + link(`https://www.google.com/search?q=${enc}+site%3Arepvue.com+OR+site%3Alevels.fyi`, 'Pay reports')
            + link(`https://www.linkedin.com/search/results/people/?keywords=${enc}`, 'People on LinkedIn');
        $('networkLinks').innerHTML = link(people('recruiter OR talent OR HR'), 'Recruiters')
            + link(people('director OR VP OR executive'), 'Leaders')
            + link(people('army OR navy OR air force OR marine OR veteran'), 'Veterans');
    }

    // ======================================================================
    // RESUME TOOLS: tailored resume, Word (.docx) export
    // ======================================================================
    async function buildTailoredResume(button) {
        if (!state.analysis || state.tailoring) return;
        state.tailoring = true; syncTailorUi();
        try {
            await withBusy(button, 'Writing your resume...', async () => {
                const forJob = state.analysis;
                const data = await api({ request_type: 'tailor_resume', job_description: state.jd, resume_text: state.resumeText, analysis_data: slimAnalysis(), military_transition: isMilitary() });
                if (state.analysis !== forJob) return;
                state.tailored = data.resume;
                state.tailorPairs = tailoredPairs(state.resumeText, data.resume);
                state.tailorKeywords = keywordShift(forJob, state.resumeText, tailoredToText(data.resume));   // instant
                state.tailorScore = { before: Math.round(forJob.score || 0), pending: true };
                renderTailored(data.resume);
                scoreTailored(forJob);          // starts at once, not awaited: the resume is usable while its score is checked
                track('tailored_resume_built');
            });
        } finally { state.tailoring = false; syncTailorUi(); }
    }

    // Check the tailored version against the same job, so the user sees whether it actually fits better.
    async function scoreTailored(forJob) {
        const before = Math.round(forJob.score || 0);
        state.tailorScore = { before, pending: true };
        syncTailorUi();
        try {
            const data = await api({ request_type: 'resume_match', job_description: state.jd, resume_text: tailoredToText(state.tailored).substring(0, MAX_RESUME_CHARS), military_transition: isMilitary() });
            if (state.analysis !== forJob) return;
            state.tailorScore = typeof data.score === 'number' ? { before, after: Math.round(data.score) } : null;
        } catch (e) {
            if (state.analysis !== forJob) return;
            state.tailorScore = null;      // the resume is still good to use; only the comparison is missing
        }
        syncTailorUi();
    }

    // How many of the posting's keywords each version covers. Worked out in the browser the moment the
    // resume arrives, so it is instant and gives the same answer every time (the AI score does not).
    const SCORE_NOISE = 2;      // AI scores move a point or two between identical runs; inside this band is "the same"
    function keywordShift(analysis, originalText, tailoredText) {
        const kws = (Array.isArray(analysis.keywords) ? analysis.keywords : []).filter(k => k && typeof k.term === 'string');
        if (!kws.length) return null;
        const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9+#./&-]+/g, ' ').trim();
        const h0 = ' ' + norm(originalText) + ' ', h1 = ' ' + norm(tailoredText) + ' ';
        const has = (hay, term) => { const n = norm(term); return n.length >= 2 && hay.includes(' ' + n + ' '); };
        let was = 0, now = 0; const added = [], lost = [];
        kws.forEach(k => {
            const before = !!k.in_resume;
            // Counted as covered if the words are there, or if the original covered it in other words and still does.
            const after = has(h1, k.term) || (before && !has(h0, k.term));
            if (before) was++;
            if (after) now++;
            if (after && !before) added.push(k.term);
            if (before && !after) lost.push(k.term);
        });
        return { total: kws.length, was, now, added, lost };
    }

    // Lines in "what changed" that describe the AI's own instructions rather than the resume are dropped.
    const META_NOTE = /\b(json|markdown|plain[- ]text|no[- ]invention|instruct\w*|as (requested|required|directed)|hard rules?|rules|compliance|output|formatting requirements?|without (alteration|changes?|modification)|(retained|kept|preserved|left) (all|every|the exact|exact))\b/i;
    const tailorChangesList = (r) => arr(r && r.changes).filter(x => !META_NOTE.test(x));

    // Pairs each rewritten bullet with the original line it came from, so the change can be shown side by side.
    // Finds, for each rewritten bullet, the original line it shares the most words with.
    function sourceMatcher(originalText) {
        const words = (x) => new Set((String(x).toLowerCase().match(/[a-z0-9$%+.]+/g) || []).filter(w => w.length > 2));
        const lines = String(originalText).split('\n').map(l => l.replace(/^[\s\u2022\-*\u2013\u00b7]+/, '').trim()).filter(l => l.length >= 20).map(l => ({ text: l, set: words(l) }));
        return (bullet) => {
            const set = words(bullet); let best = { sim: 0, before: '' };
            lines.forEach(o => { let shared = 0; set.forEach(w => { if (o.set.has(w)) shared++; }); const sim = shared / ((set.size + o.set.size - shared) || 1); if (sim > best.sim) best = { sim, before: o.text }; });
            return best;
        };
    }
    const SAME_LINE = 0.9, SOURCE_FOUND = 0.3;

    // The two most reworded bullets that clearly come from a line in the original, for the before-and-after card.
    function tailoredPairs(originalText, tailored) {
        const match = sourceMatcher(originalText), out = [];
        (Array.isArray(tailored.experience) ? tailored.experience : []).forEach(job => arr(job.bullets).forEach(bullet => {
            const m = match(bullet);
            if (m.sim >= 0.4 && m.sim < SAME_LINE) out.push({ before: m.before, after: bullet, sim: m.sim });
        }));
        return out.sort((x, y) => x.sim - y.sim).slice(0, 2);
    }

    const pairHtml = (p) => `<div class="rewrite"><div class="before"><span class="tag">Before</span>${escapeHtml(p.before)}</div><div class="after"><span class="tag">After</span><span>${escapeHtml(p.after)}</span></div></div>`;

    // One place that keeps the action row, the before-and-after card and the score line in step.
    // Tailoring leads whenever applying makes sense: first "Tailor my resume", then "Download", then the email.
    function syncTailorUi() {
        const a = state.analysis, built = !!state.tailored, t = state.tailorScore, k = state.tailorKeywords;
        const act = state.primaryAction, tailorLeads = act === 'apply' || act === 'fix_first';
        const meta = ACTIONS_META[act] || ACTIONS_META.fix_first;
        const cta = !tailorLeads ? meta.cta : state.tailoring ? ['spark', 'Writing your resume...'] : built ? ['doc', 'Review tailored resume'] : ['spark', 'Tailor my resume to this job'];
        $('primaryActionText').textContent = cta[1];
        $('primaryActionBtn').querySelector('use').setAttribute('href', '#i-' + cta[0]);
        $('primaryActionBtn').disabled = tailorLeads && !!state.tailoring;
        $('tailorActionBtn').hidden = !a || tailorLeads;
        $('tailorActionText').textContent = built ? 'View tailored resume' : 'Tailor my resume to this job';
        $('emailActionBtn').hidden = !a || act !== 'apply';
        $('useTailoredBtn').hidden = !!state.isExample;
        const tailorBtn = $('tailorBtn');
        if (!tailorBtn.disabled) { tailorBtn.classList.toggle('primary', !built); tailorBtn.querySelector('span').textContent = built ? 'Rewrite it again' : 'Tailor my resume to this job'; }

        // One headline (the score), one short summary, and a warning only when something needs checking.
        const lines = []; let shift = '', caution = '', headline = '';
        if (k) {
            if (k.now > k.was) { lines.push(`Covers ${k.now} of ${k.total} keywords from the posting, up from ${k.was}.`); shift = `${k.was} → ${k.now} keywords`; }
            else if (k.now < k.was) lines.push(`Covers ${k.now} of ${k.total} keywords from the posting, down from ${k.was}. Dropped: ${k.lost.join(', ')}.`);
            if (k.added.length) caution = `New in this version: ${k.added.join(', ')}. Make sure each is true for you before you send it.`;
        }
        if (built && state.tailorUnmatched) caution = `${state.tailorUnmatched} highlighted ${state.tailorUnmatched === 1 ? 'line has' : 'lines have'} no close match in your original resume. Check ${state.tailorUnmatched === 1 ? 'it is' : 'they are'} true before you send it. ` + caution;
        if (t && t.pending) headline = 'Checking the fit score...';
        else if (t) {
            const d = t.after - t.before;
            if (d > SCORE_NOISE) { headline = `Fit score went from ${t.before} to ${t.after}.`; shift = `${t.before} → ${t.after}`; }
            else if (d < -SCORE_NOISE) headline = `Fit score came back lower: ${t.after}, against ${t.before} for your original. Read both before you choose.`;
            else headline = `Fit score is about the same: ${t.after}, against ${t.before} for your original.`;
        }
        if (headline) lines.unshift(headline);
        const summary = built ? tailorChangesList(state.tailored).slice(0, 2).join(' ') : '';

        // The card under the action row: one rewritten line before tailoring, the real before-and-after once it is done.
        const card = $('tailorTeaser');
        const sample = a && Array.isArray(a.bullet_rewrites) ? a.bullet_rewrites.filter(b => b && b.original && b.improved).map(b => ({ before: b.original, after: b.improved })) : [];
        let pairs = [];
        if (built) pairs = (state.isExample ? sample : (state.tailorPairs || [])).slice(0, 1);
        else if (a && act !== 'skip') pairs = sample.slice(0, 1);
        card.hidden = !a || (!built && !pairs.length);
        if (!card.hidden) {
            $('tailorTeaserTitle').textContent = built ? (state.isExample ? 'A resume tailored to this job' : 'Your resume, tailored to this job') : 'One line from your resume, rewritten for this job';
            $('tailorPairs').innerHTML = pairs.map(pairHtml).join('');
            $('tailorTeaserText').textContent = built ? (lines.join(' ') || tailorChangesList(state.tailored)[0] || 'Reordered and reworded for this role, using only facts already in your resume.')
                : 'Tailoring does this for your whole resume, using only what is already in it, and gives you a Word file.';
            $('tailorTeaserScore').hidden = !built || !shift;
            $('tailorTeaserScore').textContent = shift;
            $('tailorViewBtn').hidden = !built;
        }
        const line = $('tailorScoreLine');
        line.hidden = !built || !(lines.length || caution || summary);
        line.className = 'banner tailor-summary ' + (shift ? 'success' : 'info');
        line.innerHTML = line.hidden ? '' : `${shift ? `<span class="score-shift">${escapeHtml(shift)}</span>` : icon('info')}<span class="grow">${lines.length ? `<strong>${escapeHtml(lines[0])}</strong>` : ''}${lines.slice(1).map(x => `<span>${escapeHtml(x)}</span>`).join('')}${summary ? `<span>${escapeHtml(summary)}</span>` : ''}${caution ? `<span class="tailor-caution" id="tailorCaution">${escapeHtml(caution)}</span>` : ''}</span>`;
    }

    function viewTailored() {
        showPanel('resume');
        $('tailorBlock').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        if (!state.tailored) buildTailoredResume($('tailorBtn'));
        track('tailored_resume_opened');
    }

    // Send only what the backend prompts use, not the whole result object.
    function slimAnalysis() {
        const a = state.analysis || {};
        return { score: a.score, job_title: a.job_title, company: a.company, analysis: a.analysis, clearance: a.clearance, salary_intel: a.salary_intel, competition: a.competition, company_intel: a.company_intel };
    }

    const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];

    function renderTailored(r, quiet) {
        const match = sourceMatcher(state.resumeText || ''); let unmatched = 0;
        const section = (title, html) => html ? `<h4>${title}</h4>${html}` : '';
        const lines = (list) => arr(list).map(x => `<p>${escapeHtml(x)}</p>`).join('');
        const jobs = (Array.isArray(r.experience) ? r.experience : []).map(j => `<div class="job"><b>${escapeHtml(j.title || '')}</b>${j.company ? ', ' + escapeHtml(j.company) : ''}${j.location ? ' &middot; ' + escapeHtml(j.location) : ''}${j.dates ? ' &middot; ' + escapeHtml(j.dates) : ''}<ul>${arr(j.bullets).map(b => {
            // Nothing but the resume is written into this preview, so selecting and copying it gives a clean resume.
            // A line with no close match in the original is only highlighted; the reason is in the summary above.
            const flagged = match(b).sim < SOURCE_FOUND;
            if (flagged) unmatched++;
            return `<li${flagged ? ' class="check" aria-describedby="tailorCaution"' : ''}>${escapeHtml(b)}</li>`; }).join('')}</ul></div>`).join('');
        $('tailoredPreview').innerHTML = `<h3>${escapeHtml(r.name || '')}</h3>
            ${r.headline ? `<p><b>${escapeHtml(r.headline)}</b></p>` : ''}${r.contact ? `<p class="muted">${escapeHtml(r.contact)}</p>` : ''}
            ${r.clearance ? `<p><b>Clearance:</b> ${escapeHtml(r.clearance)}</p>` : ''}
            ${section('Summary', r.summary ? `<p>${escapeHtml(r.summary)}</p>` : '')}
            ${section('Core skills', arr(r.skills).length ? `<p>${arr(r.skills).map(escapeHtml).join(' &middot; ')}</p>` : '')}
            ${section('Experience', jobs)}${section('Education', lines(r.education))}${section('Certifications', lines(r.certifications))}${section('Additional', lines(r.additional))}`;
        state.tailorUnmatched = unmatched;
        $('tailoredWrap').hidden = false;
        syncTailorUi();
        if (!quiet) $('tailoredWrap').scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
    }

    function tailoredToText(r) {
        const out = [r.name, r.headline, r.contact, r.clearance ? 'Clearance: ' + r.clearance : ''].filter(Boolean);
        const block = (title, body) => { if (body && body.length) out.push('', title.toUpperCase(), ...[].concat(body)); };
        block('Summary', r.summary);
        block('Core skills', arr(r.skills).join(', '));
        if (Array.isArray(r.experience) && r.experience.length) {
            out.push('', 'EXPERIENCE');
            r.experience.forEach(j => {
                out.push('', [j.title, j.company, j.location, j.dates].filter(Boolean).join(' | '));
                arr(j.bullets).forEach(b => out.push('- ' + b));
            });
        }
        block('Education', arr(r.education));
        block('Certifications', arr(r.certifications));
        block('Additional', arr(r.additional));
        return out.join('\n');
    }

    // ---- Minimal .docx writer (a .docx is a zip of XML files) ----
    const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc32 = (bytes) => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

    function zipStore(files) {   // files: [{ name, text }] ; stored without compression
        const enc = new TextEncoder();
        const chunks = [], central = [];
        let offset = 0;
        files.forEach(f => {
            const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
            local.setUint16(8, 0, true); local.setUint16(10, 0, true); local.setUint16(12, 0x21, true);
            local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
            local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
            chunks.push(new Uint8Array(local.buffer), name, data);
            const cd = new DataView(new ArrayBuffer(46));
            cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
            cd.setUint16(10, 0, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true);
            cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
            cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
            central.push(new Uint8Array(cd.buffer), name);
            offset += 30 + name.length + data.length;
        });
        const cdSize = central.reduce((n, c) => n + c.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
        end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
        return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }

    function buildDocx(r) {
        const run = (text, o = {}) => `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${o.bold ? '<w:b/>' : ''}${o.caps ? '<w:caps/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}<w:sz w:val="${o.size || 21}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
        const tab = '<w:r><w:tab/></w:r>';
        const para = (inner, o = {}) => `<w:p><w:pPr>${o.keep ? '<w:keepNext/>' : ''}${o.border ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="808080"/></w:pBdr>' : ''}${o.tabs || ''}<w:spacing w:before="${o.before || 0}" w:after="${o.after ?? 60}"/>${o.indent ? '<w:ind w:left="288" w:hanging="288"/>' : ''}${o.center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${inner}</w:p>`;
        const heading = (t) => para(run(t, { bold: true, caps: true, size: 22, color: '1F3A5F' }), { border: true, before: 200, after: 80, keep: true });
        const body = [];
        body.push(para(run(r.name || '', { bold: true, size: 36 }), { center: true, after: 20 }));
        if (r.headline) body.push(para(run(r.headline, { bold: true, size: 22, color: '1F3A5F' }), { center: true, after: 20 }));
        if (r.contact) body.push(para(run(r.contact, { size: 20 }), { center: true, after: 20 }));
        if (r.clearance) body.push(para(run('Clearance: ', { bold: true, size: 20 }) + run(r.clearance, { size: 20 }), { center: true }));
        if (r.summary) body.push(heading('Summary'), para(run(r.summary)));
        if (arr(r.skills).length) body.push(heading('Core Skills'), para(run(arr(r.skills).join('  |  '))));
        const jobs = Array.isArray(r.experience) ? r.experience : [];
        if (jobs.length) {
            body.push(heading('Experience'));
            jobs.forEach(j => {
                const left = run(j.title || '', { bold: true }) + (j.company ? run(', ' + j.company) : '') + (j.location ? run(' | ' + j.location) : '');
                body.push(para(left + (j.dates ? tab + run(j.dates) : ''), { tabs: '<w:tabs><w:tab w:val="right" w:pos="10080"/></w:tabs>', before: 120, after: 40, keep: true }));
                arr(j.bullets).forEach(b => body.push(para(run('•') + tab + run(b), { indent: true, tabs: '<w:tabs><w:tab w:val="left" w:pos="288"/></w:tabs>', after: 30 })));
            });
        }
        [['Education', r.education], ['Certifications', r.certifications], ['Additional', r.additional]].forEach(([title, list]) => {
            if (arr(list).length) { body.push(heading(title)); arr(list).forEach(x => body.push(para(run(x), { after: 30 }))); }
        });
        const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
        return zipStore([
            { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
            { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
            { name: 'word/document.xml', text: documentXml }
        ]);
    }

    function downloadTailoredDocx() {
        if (!state.tailored) return;
        const a = state.analysis || {};
        const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 40);
        const name = [safe(state.tailored.name) || 'Resume', safe(knownCompany(a.company)), safe(a.job_title)].filter(Boolean).join(' - ');
        downloadBlob(buildDocx(state.tailored), name + '.docx');
        track('tailored_resume_downloaded');
    }

    function useTailoredAsResume() {
        if (!state.tailored) return;
        $('resumeText').value = tailoredToText(state.tailored);
        state.fileFlags = null;
        setFileStatus('success', '<span class="grow">Now using the tailored version. Use "Save" to keep it as a named resume.</span>');
        onResumeChanged();
        analyzeJob();
    }

    // ======================================================================
    // OUTREACH: LinkedIn notes, intro email, follow-up templates
    // ======================================================================
    async function writeLinkedInNotes(button) {
        if (!state.analysis) return;
        await withBusy(button, 'Writing...', async () => {
            const forJob = state.analysis;
            const data = await api({ request_type: 'generate_linkedin_messages', job_description: state.jd, resume_text: state.resumeText, analysis_data: slimAnalysis() });
            if (state.analysis !== forJob) return;
            $('linkedinList').innerHTML = data.messages.filter(m => m && m.text).map((m, i) => {
                const limit = /accept|follow/i.test(m.audience || '') ? 600 : 200;
                const over = m.text.length > limit;
                return `<div class="rewrite" style="margin-top:${i ? 0 : 16}px"><div class="after"><span class="tag">${escapeHtml(m.audience || 'Note')}</span><span id="li-${i}">${escapeHtml(m.text)}</span></div>
                    <div class="foot"><span${over ? ' style="color:var(--error)"' : ''}>${m.text.length} of ${limit} characters${over ? ': trim before sending' : ''}</span><button class="btn text" data-copy="#li-${i}">${icon('copy')}Copy</button></div></div>`;
            }).join('');
            track('linkedin_notes_written');
        });
    }

    async function writeIntroEmail(button) {
        if (!state.analysis) return;
        await withBusy(button, 'Writing...', async () => {
            const forJob = state.analysis;
            const data = await api({ request_type: 'generate_intro_email', job_description: state.jd, resume_text: state.resumeText, analysis_data: slimAnalysis() });
            if (state.analysis !== forJob) return;
            if (!data.intro_email) throw new Error('No email came back. Please try again.');
            $('emailDisplay').textContent = data.intro_email.trim();
            $('emailWrap').hidden = false;
        });
    }

    function buildTemplates(data) {
        const company = knownCompany(data.company) || '[Company]';
        const role = data.job_title || '[Role]';
        const sal = data.salary_intel;
        const target = sal && sal.mid ? `$${Math.round(sal.mid)}K to $${Math.round(sal.high)}K${sal.is_variable_comp ? ' on-target' : ''}` : '[target range]';
        const { matches } = splitAnalysis(data);
        const highlights = matches.slice(0, 2).map(m => m.split(/\s*(?:→|->)\s*/)[0].trim().replace(/\.$/, '')).filter(Boolean).join(' and ') || 'relevant federal market experience';
        const lower = highlights.charAt(0).toLowerCase() + highlights.slice(1);
        state.templates = {
            applied: `Subject: ${role} application\n\nHi [Name],\n\nI applied for the ${role} role at ${company} and wanted to put a name to the resume.\n\nThe short version: ${lower}. I think that maps closely to what you are hiring for.\n\nDo you have 15 minutes this week for a quick call?\n\nBest,\n[Your name]\n[Phone]`,
            interview: `Subject: Thank you - ${role}\n\nHi [Name],\n\nThank you for the time today. I came away more interested in the ${role} role, especially [specific thing you discussed].\n\nOne thing I should have said more clearly: [one sentence tied to their biggest need].\n\nHappy to provide anything else that helps. What does the timeline look like from here?\n\nBest,\n[Your name]\n[Phone]`,
            followup: `Subject: ${role} - checking in\n\nHi [Name],\n\nChecking in on the ${role} role at ${company}. I am still very interested, and I am in conversations elsewhere, so I wanted to see where things stand.\n\nIs there an updated timeline you can share?\n\nBest,\n[Your name]\n[Phone]`,
            negotiate: `Subject: RE: ${role} offer\n\nHi [Name],\n\nThank you for the offer. I am excited about joining ${company}.\n\nBased on the scope of the role and what I bring, I was expecting something in the range of ${target}. Is there flexibility to get closer to that?\n\nI would also like to understand [quota and ramp / sign-on / equity / start date] before I sign.\n\nI want to make this work and I am confident we can land on something that fits.\n\nBest,\n[Your name]\n[Phone]`
        };
        showTemplate(state.template);
    }

    function showTemplate(type) {
        state.template = type;
        $('templateText').textContent = state.templates[type] || '';
        document.querySelectorAll('#templateChips .chip').forEach(c => c.classList.toggle('tonal', c.dataset.template === type));
    }

    // ======================================================================
    // ASK A RECRUITER (chat)
    // ======================================================================
    function addMessage(role, text) {
        const el = document.createElement('div');
        el.className = 'msg ' + role;
        if (role === 'assistant') {
            el.innerHTML = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
                .split(/\n\n+/).filter(p => p.trim()).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
        } else el.textContent = text;
        $('chat').appendChild(el);
        el.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
        return el;
    }

    async function askRecruiter(preset) {
        const input = $('recruiterQuestion');
        const question = (preset || input.value).trim();
        if (!question) return snackbar('Type a question first.');
        if (!state.analysis) return snackbar('Check a job first.');
        if (!state.resumeText) state.resumeText = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        if (!state.resumeText) return snackbar('Add your resume on Check a job first.');
        addMessage('user', question);
        state.chat.push({ role: 'user', content: question });
        input.value = '';
        const thinking = addMessage('thinking assistant', 'Thinking...');
        const btn = $('askBtn');
        btn.disabled = true;
        const forJob = state.analysis;
        try {
            const data = await api({ request_type: 'ask_expert', question, job_description: state.jd, resume_text: state.resumeText, analysis_data: slimAnalysis(), chat_history: state.chat.slice(-10) });
            thinking.remove();
            if (state.analysis !== forJob) return;
            addMessage('assistant', data.response || '');
            state.chat.push({ role: 'assistant', content: data.response || '' });
        } catch (e) {
            thinking.remove();
            if (state.analysis !== forJob) return;
            state.chat.pop();
            snackbar(e.message, 7000);
        } finally {
            btn.disabled = false;
        }
    }

    // ======================================================================
    // SHARE + REPORT
    // ======================================================================
    function shareTool() {
        track('share', { method: navigator.share ? 'native' : 'linkedin' });
        if (navigator.share) navigator.share({ title: 'DIB Jobs', text: SHARE_TEXT, url: SHARE_URL }).catch(() => {});
        else window.open('https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(SHARE_URL), '_blank', 'noopener');
    }

    function downloadReport() {
        const a = state.analysis;
        if (!a) return;
        const company = knownCompany(a.company);
        $('printHeader').textContent = `${a.job_title || 'Role'}${company ? ' at ' + company : ''}`;
        $('printMeta').innerHTML = `${escapeHtml(new Date().toLocaleDateString())}<br>dibjobs.com`;
        $('strengthsFold').open = true;      // the printed report shows every strength
        const prev = document.title;
        document.title = `DIB Jobs report - ${a.job_title || 'Role'}${company ? ' - ' + company : ''}`.replace(/[\\/:*?"<>|]/g, ' ');
        const restore = () => { document.title = prev; window.removeEventListener('afterprint', restore); };
        window.addEventListener('afterprint', restore);
        track('download_report');
        snackbar('Choose "Save as PDF" in the print dialog.');
        setTimeout(() => window.print(), 200);
    }

    // ======================================================================
    // TRACKER: saved jobs, follow-ups, compare, patterns, backup
    // ======================================================================
    const STATUSES = [['saved', 'Saved'], ['applied', 'Applied'], ['interviewing', 'Interviewing'], ['offered', 'Offer'], ['rejected', 'Closed']];
    const persistTracker = () => store.set(KEYS.tracker, state.tracked);
    const isOverdue = (j) => !!j.nextDate && j.nextDate < todayISO() && !['offered', 'rejected'].includes(j.status);
    const findJob = (id) => state.tracked.find(j => String(j.id) === String(id));

    // A job is "unchecked" when it was saved from Find Jobs and has never been scored.
    const isUnchecked = (j) => !j.analysis && j.score == null;
    const TRACKING_PARAMS = /^(utm_.+|gclid|fbclid|msclkid|dclid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|trk|trackingid|refid|ref|src|source|gh_src|lever-source|lever-origin)$/i;

    // Used only to tell whether two links are the same posting. The original link is what gets opened.
    function normalizeUrl(link) {
        try {
            const u = new URL(String(link).trim());
            const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
            return u.hostname.toLowerCase().replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + (keep.length ? '?' + new URLSearchParams(keep).toString() : '');
        } catch (e) { return String(link || '').trim(); }
    }
    const sameUrl = (a, b) => isUrl(a) && isUrl(b) && normalizeUrl(a) === normalizeUrl(b);
    const STORAGE_FULL = 'Could not save. Browser storage is full: remove an old job from the tracker and try again.';

    function saveToTracker(opts = {}) {
        const a = state.analysis;
        if (!a) return;
        if (state.isExample) return snackbar('That\'s the example. Check a job of your own, then save it.');
        const company = knownCompany(a.company) || 'Unknown company', role = a.job_title || 'Unknown role';
        const link = isUrl(state.postingUrl) ? state.postingUrl.trim() : '';
        const jd = state.jd.substring(0, MAX_JD_CHARS);
        // 1. the entry this job was opened from, 2. the same posting link, 3. the same saved text,
        // 4. same company and title (older entries), but never across two different posting links.
        let existing = state.trackedId != null ? findJob(state.trackedId) : null;
        if (!existing && link) existing = state.tracked.find(j => sameUrl(j.url, link));
        if (!existing) existing = state.tracked.find(j => isUnchecked(j) && j.jd && jobKey(j.jd) === jobKey(jd));
        if (!existing) {
            // Same company and title, and no link to tell them apart. If the posting text is clearly
            // different it may be a second requisition, so the user decides rather than the tracker guessing.
            const twin = state.tracked.find(j => j.company === company && j.role === role && !(link && isUrl(j.url) && !sameUrl(j.url, link)));
            const differs = twin && twin.jd && jd && textHead(twin.jd) !== textHead(jd);
            if (twin && differs && !opts.dup) {
                if (opts.silent || opts.quiet) opts = Object.assign({}, opts, { dup: 'separate' });
                else {
                    askDialog({ title: 'You already saved a job with this title', okText: 'Update existing job', altText: 'Save as a separate job',
                        body: `<p>Your tracker has <strong>${escapeHtml(role)}</strong> at <strong>${escapeHtml(company)}</strong>, saved ${escapeHtml(twin.date || 'earlier')}, and the posting text is different. Is this the same job, or a second opening with the same title?</p>` })
                        .then(choice => { if (choice) saveToTracker(Object.assign({}, opts, { dup: choice === 'alt' ? 'separate' : 'update' })); });
                    return;
                }
            }
            if (twin && !(differs && opts.dup === 'separate')) existing = twin;
        }
        const index = existing ? state.tracked.indexOf(existing) : -1;
        const before = existing ? Object.assign({}, existing) : null;
        let entry = existing;
        if (existing) {
            const wasBare = !existing.analysis;
            Object.assign(existing, { score: a.score || 0, analysis: a, jd });
            if (wasBare) {
                if (existing.autoLabel || !existing.role) existing.role = role;
                if (!existing.company) existing.company = company;
                delete existing.autoLabel;
            }
            if (!existing.url && link) existing.url = link;
        } else {
            entry = { id: newJobId(), company, role, score: a.score || 0, status: 'saved', date: new Date().toLocaleDateString(), jd, analysis: a, url: link, notes: '', nextAction: '', nextDate: '' };
            state.tracked.unshift(entry);
        }
        if (!persistTracker()) {
            if (existing) state.tracked[index] = before; else state.tracked.shift();
            return snackbar(STORAGE_FULL, 7000);
        }
        state.trackedId = entry.id; state.linkedText = state.jd;
        setSaveButton(true, existing ? 'Updated in tracker' : 'Saved to tracker');
        updateTrackerBadge();
        if (opts.silent) { /* the caller reports once for the whole batch */ }
        else if (!opts.quiet) snackbar(existing ? 'Tracker entry updated with this analysis.' : 'Saved. Open Tracker to set a follow-up date.');
        else snackbar('Your saved job now has this fit check.');
        track('job_saved');
        return true;
    }

    function newJobId() { let id = Date.now(); while (findJob(id)) id++; return id; }

    function updateTrackerBadge() {
        const badge = $('trackerBadge');
        const overdue = state.tracked.filter(isOverdue).length;
        badge.hidden = state.tracked.length === 0;
        badge.textContent = overdue || state.tracked.length;
        badge.classList.toggle('neutral', !overdue);
        badge.title = overdue ? `${overdue} follow-up${overdue > 1 ? 's' : ''} overdue` : `${state.tracked.length} saved`;
    }

    const statusLabel = (v) => (STATUSES.find(x => x[0] === v) || ['', v])[1];
    function dueLabel(date) {
        const days = Math.round((new Date(date + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
        return days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`;
    }

    function renderTracker() {
        const jobs = state.tracked;
        const overdue = jobs.filter(isOverdue).length;
        $('trackerEmpty').hidden = jobs.length > 0;
        $('savedBlock').hidden = jobs.length === 0;
        $('exportCsvBtn').hidden = jobs.length === 0;
        $('trackerCount').textContent = jobs.length ? `${jobs.length} job${jobs.length !== 1 ? 's' : ''} saved in this browser${overdue ? ` · ${overdue} follow-up${overdue > 1 ? 's' : ''} overdue` : ''}` : 'Saved in this browser only.';
        [...state.compareIds].forEach(id => { if (!findJob(id)) state.compareIds.delete(id); });
        if (jobs.filter(j => j.analysis).length < 2) state.compareMode = false;

        // Needs follow-up: anything due within two days, or overdue, on a job that is still live
        const soon = new Date(Date.now() + 2 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        const due = jobs.filter(j => j.nextDate && j.nextDate <= soon && !['offered', 'rejected'].includes(j.status)).sort((a, b) => a.nextDate.localeCompare(b.nextDate));
        $('followUps').hidden = due.length === 0;
        $('followUpList').innerHTML = due.map(j => `<div class="row-item follow-row" data-id="${j.id}">
            <span class="grow"><button class="link-btn" data-open>${escapeHtml(j.role)}</button><span class="job-sub">${escapeHtml(j.company)} · ${escapeHtml(statusLabel(j.status))} · ${escapeHtml(j.nextAction || 'Follow up')}</span></span>
            <span class="due${isOverdue(j) ? ' late' : ''}">${dueLabel(j.nextDate)}</span></div>`).join('');

        $('savedHeading').textContent = due.length ? 'All saved jobs' : 'Saved jobs';
        $('compareHint').hidden = !state.compareMode;
        $('trackerList').innerHTML = jobs.map(j => {
            const od = isOverdue(j);
            const bare = isUnchecked(j), canCheck = !j.analysis && (j.jd || isUrl(j.url));
            const sub = [j.company, j.nextDate ? `${od ? 'Overdue: ' : 'Next: '}${j.nextAction || 'follow up'} (${j.nextDate})` : `saved ${j.date || ''}`].filter(Boolean).join(' · ');
            return `<div class="job-card${od ? ' overdue' : ''}" data-id="${j.id}">
                <div class="job-row${state.compareMode ? ' selecting' : ''}">
                    ${state.compareMode ? (j.analysis ? `<input type="checkbox" class="checkbox" data-compare aria-label="Select ${escapeHtml(j.role)} to compare"${state.compareIds.has(String(j.id)) ? ' checked' : ''}>` : '<span class="checkbox-gap"></span>') : ''}
                    <div class="jr-title"><button class="link-btn job-title" data-open>${escapeHtml(j.role)}</button><div class="job-sub">${escapeHtml(sub)}</div></div>
                    ${bare ? '<span class="score-pill none">Not checked</span>' : `<span class="score-pill ${scoreBand(j.score)}" title="Resume fit">${Math.round(j.score) || 0}</span>`}
                    <button class="icon-btn" data-toggle-details aria-expanded="false" aria-label="Follow-up and notes for ${escapeHtml(j.role)}">${icon('chevron')}</button>
                    <div class="status-cell"><select class="select sm" data-field="status" aria-label="Status of ${escapeHtml(j.role)}">${STATUSES.map(([v, l]) => `<option value="${v}"${j.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
                </div>
                <div class="details stack" hidden>
                    <div class="details-grid">
                        <label class="field sm"><span class="field-label">Next step</span><input type="text" data-field="nextAction" maxlength="120" placeholder="e.g. Follow up with recruiter" value="${escapeHtml(j.nextAction || '')}"></label>
                        <label class="field sm"><span class="field-label">Due</span><input type="date" data-field="nextDate" value="${escapeHtml(j.nextDate || '')}"></label>
                    </div>
                    <label class="field sm"><span class="field-label">Link to posting</span><input type="url" data-field="url" maxlength="500" placeholder="https://" value="${escapeHtml(j.url || '')}"></label>
                    <label class="field sm"><span class="field-label">Notes</span><textarea data-field="notes" maxlength="2000" placeholder="Who you talked to, what they said, referral names">${escapeHtml(j.notes || '')}</textarea></label>
                    <div class="row end">
                        ${isUrl(j.url) ? `<a class="btn text" href="${escapeHtml(j.url)}" target="_blank" rel="noopener noreferrer">${icon('open')}Open posting</a>` : ''}
                        <button class="btn text danger" data-remove>Remove</button>
                        ${j.analysis ? '<button class="btn" data-open>Open analysis</button>' : canCheck ? '<button class="btn" data-open>Continue to fit check</button>' : ''}
                    </div>
                </div>
            </div>`;
        }).join('');
        updateCompareButton();
        renderInsights();
        updateTrackerBadge();
        if ($('compareSection').hidden === false) renderCompare();
    }

    // Compare is a mode: checkboxes only appear once someone asks to compare.
    function updateCompareButton() {
        const n = state.compareIds.size, btn = $('compareBtn');
        btn.hidden = state.tracked.filter(j => j.analysis).length < 2;
        $('compareCancelBtn').hidden = !state.compareMode;
        btn.classList.toggle('primary', !!state.compareMode && n >= 2 && n <= 3);
        btn.disabled = !!state.compareMode && (n < 2 || n > 3);
        btn.querySelector('span').textContent = !state.compareMode ? 'Compare' : n > 3 ? 'Pick up to 3' : n >= 2 ? `Show comparison (${n})` : 'Pick 2 or 3';
    }

    function onCompareClick() {
        if (!state.compareMode) { state.compareMode = true; renderTracker(); $('savedBlock').scrollIntoView({ behavior: scrollBehavior(), block: 'start' }); return; }
        renderCompare();
        $('compareSection').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }

    function cancelCompare() {
        state.compareMode = false; state.compareIds.clear();
        $('compareSection').hidden = true;
        renderTracker();
    }

    function initTrackerEvents() {
        const list = $('trackerList');
        $('followUpList').addEventListener('click', (e) => { const row = e.target.closest('[data-id]'); const job = row && findJob(row.dataset.id); if (job && e.target.closest('[data-open]')) openTrackedJob(job); });
        list.addEventListener('click', async (e) => {
            const card = e.target.closest('.job-card');
            if (!card) return;
            const job = findJob(card.dataset.id);
            if (!job) return;
            const toggle = e.target.closest('[data-toggle-details]');
            if (toggle) {
                const details = card.querySelector('.details');
                details.hidden = !details.hidden;
                toggle.setAttribute('aria-expanded', String(!details.hidden));
                toggle.style.transform = details.hidden ? '' : 'rotate(180deg)';
            } else if (e.target.closest('[data-open]')) {
                openTrackedJob(job);
            } else if (e.target.closest('[data-remove]')) {
                const ok = await askDialog({ title: 'Remove this job?', body: `${escapeHtml(job.role)} at ${escapeHtml(job.company)} and its notes will be removed from this browser.`, okText: 'Remove', danger: true });
                if (!ok) return;
                state.tracked = state.tracked.filter(j => j !== job);
                state.compareIds.delete(String(job.id));
                persistTracker(); renderTracker();
            }
        });
        list.addEventListener('change', (e) => {
            const card = e.target.closest('.job-card');
            const job = card && findJob(card.dataset.id);
            if (!job) return;
            if (e.target.matches('[data-compare]')) {
                e.target.checked ? state.compareIds.add(String(job.id)) : state.compareIds.delete(String(job.id));
                updateCompareButton();
                return;
            }
            const field = e.target.dataset.field;
            if (!field) return;
            job[field] = e.target.value;
            persistTracker();
            const open = card.querySelector('.details').hidden === false;
            renderTracker();
            if (open) { const again = list.querySelector(`.job-card[data-id="${job.id}"] [data-toggle-details]`); if (again) again.click(); }
        });
    }

    function openTrackedJob(job) {
        if (!job.analysis) {
            // Saved but never checked: hand it to Check a job. Nothing is analyzed until the user asks.
            const text = job.jd || (isUrl(job.url) ? job.url.trim() : '');
            if (!text) return snackbar('This entry has no posting saved. Add a link in its details first.');
            return prepareJob(text, { trackedId: job.id, url: job.url });
        }
        resetAnalyzeUi();
        dropExampleResume();
        $('jobDescription').value = job.jd || '';
        state.jd = job.jd || '';
        state.resumeText = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        state.analysis = job.analysis;
        state.isExample = false;
        state.trackedId = job.id; state.postingUrl = isUrl(job.url) ? job.url.trim() : ''; state.linkHelp = null; state.linkedText = job.jd || '';
        resetGenerated();
        showInlineError(''); updateCounts(); renderLinkHelp();
        showView('analyze');
        renderResults(job.analysis);
        setSaveButton(true, 'In your tracker');
    }

    const topLine = (analysis, kind) => { const s = splitAnalysis(analysis || {}); const l = (kind === 'gap' ? s.gaps : s.matches)[0]; return l ? l.split(/\s*(?:→|->)\s*/)[0] : 'n/a'; };

    function renderCompare() {
        const jobs = [...state.compareIds].map(findJob).filter(j => j && j.analysis).slice(0, 3);
        if (jobs.length < 2) { $('compareSection').hidden = true; return; }
        const best = Math.max(...jobs.map(j => j.score || 0));
        const pay = (a) => a.salary_intel && a.salary_intel.low ? `$${Math.round(a.salary_intel.low)}K to $${Math.round(a.salary_intel.high)}K${a.salary_intel.is_variable_comp ? ' OTE' : ''}` : 'n/a';
        const kw = (a) => { const k = (a.keywords || []).filter(x => x && x.term); return k.length ? Math.round(k.filter(x => x.in_resume).length / k.length * 100) + '%' : 'n/a'; };
        const clr = (a) => a.clearance && a.clearance.required ? `${a.clearance.required} (${{ meets: 'you meet it', gap: 'gap', not_required: 'none needed', unclear: 'unclear' }[a.clearance.status] || 'unclear'})` : 'n/a';
        const rows = [
            ['Fit score', j => `<strong>${Math.round(j.score) || 0}</strong>`, j => (j.score || 0) === best],
            ['Verdict', j => escapeHtml(j.analysis?.verdict || 'n/a')],
            ['Clearance', j => escapeHtml(clr(j.analysis || {}))],
            ['Estimated pay', j => escapeHtml(pay(j.analysis || {}))],
            ['Keywords matched', j => kw(j.analysis || {})],
            ['Top strength', j => escapeHtml(topLine(j.analysis, 'match'))],
            ['Biggest gap', j => escapeHtml(topLine(j.analysis, 'gap'))],
            ['Competition', j => escapeHtml(j.analysis?.competition?.level || 'n/a')],
            ['Status', j => escapeHtml((STATUSES.find(s => s[0] === j.status) || ['', j.status])[1])],
            ['Next step', j => escapeHtml(j.nextAction ? `${j.nextAction}${j.nextDate ? ' (' + j.nextDate + ')' : ''}` : 'None set')]
        ];
        $('compareTable').innerHTML = `<thead><tr><th></th>${jobs.map(j => `<th>${escapeHtml(j.role)}<br><span class="body-sm muted">${escapeHtml(j.company)}</span></th>`).join('')}</tr></thead><tbody>${
            rows.map(([label, cell, isBest]) => `<tr><th scope="row">${label}</th>${jobs.map(j => `<td${isBest && isBest(j) ? ' class="best"' : ''}>${cell(j)}</td>`).join('')}</tr>`).join('')}</tbody>`;
        $('compareSection').hidden = false;
    }

    // What keeps coming up across saved jobs (computed locally, no AI call).
    function renderInsights() {
        const jobs = state.tracked.filter(j => j.analysis);
        const card = $('insightsCard');
        if (jobs.length < 2) { card.hidden = true; return; }
        const tally = (pick) => {
            const counts = new Map();
            jobs.forEach(j => new Set(pick(j.analysis).map(t => String(t).trim()).filter(Boolean).map(t => t.toLowerCase())).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
            return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8);
        };
        const display = (term) => { for (const j of jobs) { const hit = [...(j.analysis.keywords || []), ...(j.analysis.fit_signals || []).map(s => ({ term: s.signal }))].find(k => k && String(k.term).toLowerCase() === term); if (hit) return hit.term; } return term; };
        const missingKw = tally(a => (a.keywords || []).filter(k => k && !k.in_resume).map(k => k.term));
        const weakSignals = tally(a => (a.fit_signals || []).filter(s => s && s.status === 'missing').map(s => s.signal));
        const clearanceGaps = jobs.filter(j => j.analysis.clearance && j.analysis.clearance.status === 'gap').length;
        const avg = Math.round(jobs.reduce((n, j) => n + (j.score || 0), 0) / jobs.length);
        const bestJob = jobs.reduce((a, b) => (b.score || 0) > (a.score || 0) ? b : a);
        const parts = [`<p class="body-md">Average fit across ${jobs.length} jobs: <strong>${avg}</strong>. Best fit: <strong>${escapeHtml(bestJob.role)}</strong> at ${escapeHtml(bestJob.company)} (${Math.round(bestJob.score)}).</p>`];
        const chipRow = (label, list) => `<p class="label-lg" style="margin-top:8px">${label}</p><div class="chips">${list.map(([t, n]) => `<span class="chip sm">${escapeHtml(display(t))} &middot; ${n} of ${jobs.length}</span>`).join('')}</div>`;
        if (missingKw.length) parts.push(chipRow('Keywords you keep missing', missingKw));
        if (weakSignals.length) parts.push(chipRow('Screens you keep failing', weakSignals));
        if (clearanceGaps) parts.push(`<p class="body-md" style="margin-top:8px">Clearance is a gap on <strong>${clearanceGaps} of ${jobs.length}</strong> of these jobs. Target roles at your current level, or ones that sponsor an upgrade.</p>`);
        if (missingKw.length || weakSignals.length) parts.push('<p class="body-sm" style="margin-top:8px">If these are true for you, add them to your resume. If they are not, they are what to go get.</p>');
        $('insightsBody').innerHTML = parts.join('');
        card.hidden = false;
    }

    function exportTrackerCSV() {
        if (!state.tracked.length) return;
        const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
        const rows = [['Company', 'Role', 'Fit score', 'Status', 'Date saved', 'Next step', 'Due', 'Link', 'Notes', 'Verdict', 'Pay low ($K)', 'Pay high ($K)', 'Clearance required']];
        state.tracked.forEach(j => { const a = j.analysis || {}; rows.push([j.company, j.role, isUnchecked(j) ? '' : j.score, j.status, j.date, j.nextAction, j.nextDate, j.url, j.notes, a.verdict, a.salary_intel?.low, a.salary_intel?.high, a.clearance?.required]); });
        downloadBlob(new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), `dib-jobs-tracker-${todayISO()}.csv`);
    }

    function backupData() {
        const data = { app: 'dibjobs', version: 1, exportedAt: new Date().toISOString(), resumes: getSavedResumes(), draft: store.getRaw(KEYS.draft), tracker: state.tracked };
        downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `dib-jobs-backup-${todayISO()}.json`);
        snackbar('Backup downloaded. It contains your resumes, so store it somewhere private.', 6000);
    }

    async function restoreData(file) {
        if (!file) return;
        try {
            if (file.size > 20 * 1024 * 1024) throw new Error('too large');
            const data = JSON.parse(await file.text());
            if (data.app !== 'dibjobs' || !Array.isArray(data.tracker) || typeof data.resumes !== 'object') throw new Error('not a backup');
            const jobs = data.tracker.filter(j => j && typeof j === 'object' && j.role).map(j => Object.assign({}, j, { id: Number(j.id) || Date.now() + Math.random(), score: (j.score == null && !j.analysis) ? null : Number(j.score) || 0, status: STATUSES.some(s => s[0] === j.status) ? j.status : 'saved' }));
            const resumes = {};
            Object.entries(data.resumes || {}).forEach(([n, r]) => { if (r && typeof r.text === 'string') resumes[String(n).substring(0, 50)] = { text: r.text, savedAt: r.savedAt || '' }; });
            const ok = await askDialog({ title: 'Restore this backup?', body: `Backup from ${escapeHtml(new Date(data.exportedAt).toLocaleDateString())} with ${jobs.length} tracked job${jobs.length !== 1 ? 's' : ''} and ${Object.keys(resumes).length} saved resume${Object.keys(resumes).length !== 1 ? 's' : ''}.<br><br>This replaces what is in this browser now.`, okText: 'Restore' });
            if (!ok) return;
            state.tracked = jobs;
            if (!persistTracker() || !store.set(KEYS.resumes, resumes)) throw new Error('storage');
            if (typeof data.draft === 'string' && data.draft.trim()) { store.set(KEYS.draft, data.draft); $('resumeText').value = data.draft; }
            state.compareIds.clear();
            updateResumeSelector(); onResumeChanged(); renderTracker();
            snackbar('Backup restored.');
        } catch (e) {
            snackbar(e.message === 'storage' ? 'Could not restore: browser storage is full.' : 'That file is not a DIB Jobs backup.', 6000);
        } finally {
            $('restoreFile').value = '';
        }
    }

    // ======================================================================
    // FIND JOBS
    // Discovery runs entirely in this browser. The page only builds ordinary search
    // links (LinkedIn, ClearanceJobs, Indeed, Google): it never fetches results, and no
    // AI or backend call is made. Only the title, location and clearance keyword go out.
    // ======================================================================
    const GOOGLE_SEARCH = 'https://www.google.com/search';
    const DEFAULT_TITLE = 'federal sales';
    const EMPLOYER_SITES = [['Greenhouse', 'job-boards.greenhouse.io'], ['Lever', 'jobs.lever.co'], ['Ashby', 'jobs.ashbyhq.com'], ['Workday', 'myworkdayjobs.com']];
    const CLEARANCE_HINTS = ['public trust', 'secret clearance', 'top secret', 'TS/SCI', 'polygraph'];
    // [name shown, LinkedIn company page]. Each page address was checked before it was added: a wrong one is a dead link.
    const COMPANY_BOARDS = [
        ['Defense primes and integrators', [['Lockheed Martin', 'lockheed-martin'], ['RTX (Raytheon)', 'rtx'], ['GDIT', 'gdit'], ['Northrop Grumman', 'northrop-grumman-corporation'], ['Boeing', 'boeing'], ['Leidos', 'leidos'], ['BAE Systems', 'bae-systems'], ['L3Harris', 'l3harris-technologies'], ['Booz Allen', 'booz-allen-hamilton'], ['SAIC', 'saicinc'], ['CACI', 'caci-international-inc'], ['ManTech', 'mantech'], ['Peraton', 'peraton'], ['Agile Defense', 'agiledefense']]],
        ['Space and new defense tech', [['SpaceX', 'spacex'], ['Anduril', 'anduril'], ['Shield AI', 'shield-ai'], ['Blue Origin', 'blue-origin'], ['Rocket Lab', 'rocket-lab-limited'], ['Sierra Space', 'sierraspace'], ['Skydio', 'skydio'], ['Saronic', 'saronic-technologies'], ['Epirus', 'epirus'], ['Planet', 'planet-labs']]],
        ['AI and data', [['Anthropic', 'anthropicresearch'], ['OpenAI', 'openai'], ['Scale AI', 'scaleai'], ['Palantir', 'palantir-technologies'], ['NVIDIA', 'nvidia'], ['C3 AI', 'c3-ai-enterprise-ai'], ['Cohere', 'cohere-ai'], ['xAI', 'xai'], ['Databricks', 'databricks'], ['Snowflake', 'snowflake-computing']]],
        ['Cloud service providers', [['Amazon / AWS', 'amazon-web-services'], ['Microsoft / Azure', 'microsoft'], ['Google Cloud', 'google-cloud'], ['Oracle Cloud', 'oracle'], ['IBM Cloud', 'ibm']]],
        ['SaaS and cybersecurity', [['Salesforce', 'salesforce'], ['ServiceNow', 'servicenow'], ['Atlassian', 'atlassian'], ['Palo Alto Networks', 'palo-alto-networks'], ['CrowdStrike', 'crowdstrike'], ['Zscaler', 'zscaler'], ['Tenable', 'tenableinc'], ['Okta', 'okta-inc-'], ['Splunk', 'splunk'], ['Cloudflare', 'cloudflare'], ['Wiz', 'wizsecurity'], ['SentinelOne', 'sentinelone'], ['Elastic', 'elastic-co']]],
        ['OEMs and infrastructure', [['Dell Technologies', 'delltechnologies'], ['HPE', 'hewlett-packard-enterprise'], ['Cisco', 'cisco'], ['NetApp', 'netapp'], ['Pure Storage', 'purestorage'], ['Red Hat', 'red-hat'], ['Nutanix', 'nutanix']]],
        ['Consulting and systems integrators', [['Accenture Federal', 'accenturefederalservices'], ['Deloitte', 'deloitte'], ['PwC', 'pwc'], ['EY', 'ernstandyoung'], ['KPMG', 'kpmg-us'], ['Capgemini', 'capgemini']]],
        ['VARs and resellers', [['Carahsoft', 'carahsoft'], ['WWT', 'world-wide-technology'], ['Iron Bow', 'iron-bow-technologies'], ['Presidio', 'presidio-'], ['DXC Technology', 'dxctechnology'], ['CGI Federal', 'cgi'], ['Red River', 'red-river-technology'], ['ThunderCat', 'thundercat-technology']]]
    ];


    const READY_SEARCHES = [
        ['Federal account executive', 'Direct selling to agencies for software, cloud and cyber vendors', 'federal account executive'],
        ['Capture manager', 'Running pursuits for primes and integrators', 'capture manager'],
        ['Defense business development', 'Opening doors and shaping deals across DoD and the IC', 'defense business development'],
        ['Federal sales director', 'Leading a public sector team or region', 'federal sales director'],
        ['Channel and partner sales', 'Selling through primes, VARs and distributors', 'federal partner sales manager'],
        ['Public sector account manager', 'Growing existing agency accounts', 'public sector account manager']
    ];

    const tidy = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().substring(0, max);

    function searchCriteria() {
        const clearance = $('searchClearance').value;
        const title = tidy($('searchTitle').value, 80);
        return { title: title || DEFAULT_TITLE, typed: !!title, location: tidy($('searchLocation').value, 60), clearance: CLEARANCE_HINTS.includes(clearance) ? clearance : '' };
    }

    // Google:  capture manager Virginia "secret clearance" jobs   (or site:jobs.lever.co ... for one hiring system)
    // The title is left unquoted on purpose: strict phrases hide relevant postings.
    function buildQuery(c, site) {
        const parts = [];
        if (site) parts.push('site:' + site);
        parts.push(c.title);
        if (c.location) parts.push(c.location);
        if (c.clearance) parts.push('"' + c.clearance + '"');
        if (!site && !/\bjobs?\b/i.test(c.title)) parts.push('jobs');
        return parts.join(' ');
    }
    const withParams = (base, params) => { const url = new URL(base); url.search = new URLSearchParams(params).toString(); return url.href; };
    const googleUrl = (query) => withParams(GOOGLE_SEARCH, { q: query });
    const keywordsOf = (c) => c.title + (c.clearance ? ' "' + c.clearance + '"' : '');

    // LinkedIn job search, postings from the past week. "Remote" becomes LinkedIn's remote filter.
    function linkedInUrl(c) {
        const params = { keywords: keywordsOf(c), f_TPR: 'r604800' };
        const place = c.location.replace(/\bremote\b/ig, '').replace(/^[\s,]+|[\s,]+$/g, '');
        if (/\bremote\b/i.test(c.location)) params.f_WT = '2';
        if (place) params.location = place;
        return withParams('https://www.linkedin.com/jobs/search/', params);
    }
    const clearanceJobsUrl = (c) => withParams('https://www.clearancejobs.com/jobs', { keywords: [c.title, c.location].filter(Boolean).join(' ') });
    const indeedUrl = (c) => withParams('https://www.indeed.com/jobs', c.location ? { q: keywordsOf(c), l: c.location } : { q: keywordsOf(c) });

    const outLink = (href, label, cls) => `<a class="${cls || 'chip'}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}<span class="sr"> (opens in a new tab)</span></a>`;
    const boardLinks = (c, cls) => outLink(clearanceJobsUrl(c), 'ClearanceJobs', cls) + outLink(indeedUrl(c), 'Indeed', cls) + outLink(googleUrl(buildQuery(c)), 'Google', cls);

    function updateSearchUi() {
        const c = searchCriteria();
        $('queryPreview').textContent = [c.title, c.location, c.clearance ? `"${c.clearance}"` : ''].filter(Boolean).join(' · ');
        $('queryHint').textContent = c.typed ? '' : '  (the default: type a title to change it)';
        $('boardLinks').innerHTML = boardLinks(c);
        $('employerLinks').innerHTML = EMPLOYER_SITES.map(([name, site]) => outLink(googleUrl(buildQuery(c, site)), name)).join('');
    }

    function renderStaticSearches() {
        $('readySearches').innerHTML = READY_SEARCHES.map(([title, blurb, query]) => { const c = { title: query, location: '', clearance: '' };
            return `<div class="tool-card"><span class="title-md">${title}</span><span class="body-sm">${blurb}</span><div class="chips">${outLink(linkedInUrl(c), 'LinkedIn, past week', 'chip sm')}${boardLinks(c, 'chip sm')}</div></div>`; }).join('');
        $('companyBoards').innerHTML = COMPANY_BOARDS.map(([group, companies]) => `<div class="board-group"><p class="label-lg muted" style="margin:20px 0 8px">${group}</p><div class="chips">${
            companies.map(([name, slug]) => outLink(`https://www.linkedin.com/company/${slug}/jobs/`, name)).join('')}</div></div>`).join('');
        const total = COMPANY_BOARDS.reduce((n, g) => n + g[1].length, 0);
        $('browseEmployersLink').textContent = `Browse ${total} defense employers`;
    }

    // Typing a name narrows the employer list; groups with no match drop out.
    function filterEmployers() {
        const q = $('employerFilter').value.trim().toLowerCase();
        let shown = 0;
        document.querySelectorAll('#companyBoards .board-group').forEach(group => {
            let any = false;
            group.querySelectorAll('a').forEach(a => { const hit = !q || a.textContent.toLowerCase().includes(q) || group.querySelector('p').textContent.toLowerCase().includes(q); a.hidden = !hit; if (hit) { any = true; shown++; } });
            group.hidden = !any;
        });
        $('employerNone').hidden = shown > 0;
        $('employerCount').textContent = q ? `${shown} ${shown === 1 ? 'employer' : 'employers'}` : '';
    }

    // Enter or the blue button: LinkedIn, straight from the user's action so it opens as a normal new tab.
    function runSearch(e) {
        e.preventDefault();
        window.open(linkedInUrl(searchCriteria()), '_blank', 'noopener,noreferrer');
        track('search_linkedin');
    }

    function fillTitle(title) {
        $('searchTitle').value = title;
        updateSearchUi();
        $('searchTitle').focus();
    }

    // ---- Search terms from the resume: a plain lookup table, matched in the browser ----
    const TERM_MAP = [
        { titles: ['Federal partner sales', 'Public sector alliances', 'Federal channel account manager'],
          signals: [/\bchannel\b/i, /\balliances?\b/i, /partner (sales|ecosystem|manager|program|network)/i, /systems? integrators?/i, /\b(resellers?|distributors?|VARs?)\b/] },
        { titles: ['Capture manager', 'Federal business development'],
          signals: [/\bcapture\b/i, /\brecompetes?\b/i, /\bproposals?\b/i, /\bIDIQ\b/, /\b(RFPs?|GWACs?|pursuits?)\b/, /business development/i] },
        { titles: ['Federal account executive', 'Defense sales director'],
          signals: [/federal (accounts?|sales)/i, /\bquota\b/i, /\b(DoD|Department of Defense)\b/, /account executive/i, /\bterritory\b/i, /President'?s Club/i] },
        { titles: ['Federal sales director', 'Public sector sales leader'],
          signals: [/\b(VP|vice president|director),? (of )?(federal |public sector )?sales\b/i, /sales (director|leader|manager)\b/i, /(led|managed|built|hired) (a |the )?(team|\d+)/i, /\bregional\b/i] },
        { titles: ['Federal solutions engineer', 'Public sector solutions architect'],
          signals: [/solutions? (engineer|architect|consultant)/i, /\bpre-?sales\b/i, /\bdemos?\b/i, /proofs? of concept|\bPOCs?\b/i, /sales engineer/i] },
        { titles: ['Public sector account manager', 'Federal customer success manager'],
          signals: [/customer success/i, /\brenewals?\b/i, /account manage(r|ment)/i, /\b(upsell|expansion|retention|adoption)\b/i] },
        { titles: ['Federal program manager', 'Defense program manager'],
          signals: [/program manage(r|ment)/i, /\bPMP\b/, /\b(CDRLs?|period of performance|program of record|earned value)\b/i, /cost,? schedule/i] },
        { titles: ['Proposal manager', 'Federal contracts manager'],
          signals: [/proposal (manager|management|writer)/i, /contracts? (manager|administrat)/i, /\bFAR\b/, /\b(color team|Shipley|compliance matrix)\b/i] }
    ];

    // The user's own resume, never the built-in example.
    function realResumeText() {
        const current = $('resumeText').value.trim();
        if (state.resumeSource !== 'example' && current !== (state.exampleResume || null)) return current;
        const draft = store.getRaw(KEYS.draft).trim();
        if (draft && draft !== state.exampleResume) return draft;
        const saved = getSavedResumes();
        const newest = Object.keys(saved).sort((a, b) => (saved[b].savedAt || '').localeCompare(saved[a].savedAt || ''))[0];
        return newest ? saved[newest].text.trim() : '';
    }

    function termsFromResume(text) {
        const groups = TERM_MAP.map(g => ({ titles: g.titles, hits: g.signals.filter(re => re.test(text)).length })).filter(g => g.hits >= 2).sort((a, b) => b.hits - a.hits).slice(0, 3);
        const out = [];
        for (let i = 0; out.length < 3 && i < 3; i++) groups.forEach(g => { if (g.titles[i] && out.length < 3 && !out.includes(g.titles[i])) out.push(g.titles[i]); });
        return out;
    }

    function suggestSearchTerms() {
        const box = $('suggestBox');
        const resume = realResumeText();
        const exampleOnly = !resume && state.resumeSource === 'example';
        box.hidden = false;
        if (resume.length < 100) {
            box.innerHTML = `<p class="body-md">${exampleOnly ? 'The example resume doesn\'t count. ' : ''}Add your resume and this will suggest search terms from it. The matching happens in your browser.</p>
                <div class="row" style="margin-top:8px"><button type="button" class="btn" data-action="add-resume">Add my resume</button></div>`;
            return;
        }
        const terms = termsFromResume(resume);
        box.innerHTML = terms.length
            ? `<p class="body-md">From your resume. Pick one to fill in the title, then edit it or search.</p><div class="chips">${terms.map(t => `<button type="button" class="chip" data-fill-title="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div><p class="body-sm muted" style="margin-top:8px">Matched in your browser. Your resume was not sent anywhere.</p>`
            : '<p class="body-md">Your resume doesn\'t point clearly at one role family. Start from one of the role chips above and edit it.</p>';
        track('search_terms_suggested');
    }

    // ---- Found a posting? ----
    function handoffError(message) {
        const el = $('handoffError');
        el.textContent = message || '';
        el.hidden = !message;
    }

    // Returns { kind: 'url' | 'text', value, truncated } or shows why the input can't be used.
    function readPosting() {
        const raw = $('handoffInput').value.trim();
        handoffError('');
        const fail = (message) => { handoffError(message); $('handoffInput').focus(); return null; };
        if (!raw) return fail('Paste a link to the posting, or the job description, first.');
        if (!/\s/.test(raw)) {
            if (!isUrl(raw)) return fail('That looks like a link, but it isn\'t complete. Use the full address, starting with https://');
            return { kind: 'url', value: raw };
        }
        if (raw.length < 40 || countWords(raw) < 8) return fail('That\'s too short to be a job description. Paste the full posting text, or its link.');
        return { kind: 'text', value: raw.substring(0, MAX_JD_CHARS), truncated: raw.length > MAX_JD_CHARS };
    }

    // The hand-off button opens the form; the check itself still needs one more press, because that is
    // the moment resume text is sent for analysis. The label says which of the two situations applies.
    const hasRealResume = () => $('resumeText').value.trim().length >= 100 && state.resumeSource !== 'example';
    function updateHandoffLabel() {
        const el = $('handoffCheckText');
        if (el) el.textContent = hasRealResume() ? 'Continue to fit check' : 'Add a resume to check fit';
    }

    // Put a real posting on Check a job. Nothing is analyzed until the user chooses "Check this job".
    function prepareJob(text, opts = {}) {
        resetAnalyzeUi();
        dropExampleResume();
        const linkOnly = isUrl(text);
        state.exampleDismissed = true;      // a real job is on its way in: the sample stays out of it
        $('jobDescription').value = linkOnly ? '' : text;
        state.analysis = null; state.jd = ''; state.isExample = false;
        state.trackedId = opts.trackedId ?? null;
        state.postingUrl = linkOnly ? text.trim() : isUrl(opts.url) ? opts.url.trim() : '';
        state.linkHelp = null; state.linkedText = linkOnly ? '' : text;
        resetGenerated();
        setResultState('empty');
        showInlineError(''); updateCounts(); renderLinkHelp();
        showView('analyze');
        if (linkOnly) { readLink(text, { trackedId: state.trackedId }); return; }
        const ready = $('resumeText').value.trim().length >= 100;
        if (!ready) setResumeMode(true);
        (ready ? $('analyzeBtn') : $('resumeDrop')).focus();
    }

    function handoffCheck() {
        const posting = readPosting();
        if (!posting) return;
        closeSaveForm();
        prepareJob(posting.value);
        if (posting.truncated) snackbar(`That posting is long: the first ${MAX_JD_CHARS.toLocaleString()} characters will be checked.`, 6000);
        track('posting_handoff');
    }

    function openSaveForm() {
        const posting = readPosting();
        if (!posting) return;
        if (posting.kind === 'text' && !$('saveTitle').value) {
            const first = (posting.value.split('\n').find(l => l.trim()) || '').trim();
            if (first.length >= 3 && first.length <= 90) $('saveTitle').value = first;
        }
        $('saveForm').hidden = false;
        $('handoffActions').hidden = true;
        $('saveTitle').focus();
    }

    function closeSaveForm() {
        $('saveForm').hidden = true;
        $('handoffActions').hidden = false;
    }

    function savePostingForLater(e) {
        e.preventDefault();
        const posting = readPosting();
        if (!posting) return;
        const title = tidy($('saveTitle').value, 120), company = tidy($('saveCompany').value, 80);
        const dup = posting.kind === 'url' ? state.tracked.find(j => sameUrl(j.url, posting.value)) : state.tracked.find(j => j.jd && jobKey(j.jd) === jobKey(posting.value));
        if (dup) return handoffError(`That posting is already in your tracker as "${dup.role}".`);
        let fallback = 'Saved posting';
        if (posting.kind === 'url') { try { fallback = 'Posting at ' + new URL(posting.value).hostname.replace(/^www\./, ''); } catch (err) { /* keep default */ } }
        else { const first = (posting.value.split('\n').find(l => l.trim()) || '').trim(); if (first) fallback = first.length > 60 ? first.substring(0, 57) + '...' : first; }
        const entry = { id: newJobId(), company, role: title || fallback, status: 'saved', date: new Date().toLocaleDateString(),
            url: posting.kind === 'url' ? posting.value : '', jd: posting.kind === 'text' ? posting.value : '',
            score: null, analysis: null, notes: '', nextAction: '', nextDate: '' };
        if (!title) entry.autoLabel = true;      // replaced by the real title once the job is checked
        state.tracked.unshift(entry);
        if (!persistTracker()) {                 // keep everything the user typed
            state.tracked.shift();
            handoffError(STORAGE_FULL);
            return snackbar(STORAGE_FULL, 7000);
        }
        $('handoffInput').value = ''; $('saveTitle').value = ''; $('saveCompany').value = '';
        closeSaveForm();
        updateTrackerBadge();
        snackbar('Saved to your tracker as "Not checked".');
        track('posting_saved');
    }

    function initFindJobs() {
        updateSearchUi(); renderStaticSearches();
        $('searchForm').addEventListener('submit', runSearch);
        ['searchTitle', 'searchLocation'].forEach(id => $(id).addEventListener('input', updateSearchUi));
        $('searchClearance').addEventListener('change', updateSearchUi);
        $('view-explore').addEventListener('click', (e) => { const chip = e.target.closest('[data-fill-title]'); if (chip) fillTitle(chip.dataset.fillTitle); });
        $('saveForm').addEventListener('submit', savePostingForLater);
        $('employerFilter').addEventListener('input', filterEmployers);
        $('handoffInput').addEventListener('input', () => handoffError(''));
    }

    // ======================================================================
    // SAMPLE DATA
    // ======================================================================
    // The made-up resume and posting behind the example.
    const SAMPLE_RESUME = `JOHN DOE
Arlington, VA | johndoe@email.com | (703) 555-1234

CLEARANCE: Active TS/SCI

SUMMARY
Senior Federal Sales Executive with 15+ years driving revenue growth across Department of Defense and Intelligence Community accounts. Proven track record of closing $500M+ in federal IT contracts. Deep relationships with DoD CIOs, program executives, and acquisition leaders. Expert in navigating complex federal procurement cycles and building strategic partner ecosystems.

EXPERIENCE

Account Manager | Major Cybersecurity Provider | 2019-Present
- Lead DoD sales territory generating $180M+ annual revenue
- Closed $95M multi-year enterprise license agreement with Army customer
- Built partner ecosystem of 25+ defense contractors driving 40% of pipeline
- Achieved 145% of quota in FY23, 138% in FY22, President's Club both years
- Manage relationships with DISA, Army, Navy, and Air Force accounts
- Coordinate with solutions architects on technical requirements and ATO support

Senior Account Executive, Defense | Enterprise Software Company | 2015-2019
- Grew DoD territory from $12M to $67M in annual recurring revenue
- Led capture of $45M IDIQ contract with Navy customer
- Developed strategic account plans for top 15 DoD accounts
- Partnered with Lockheed Martin, Northrop Grumman, and GDIT on joint pursuits
- Consistently exceeded quota: 112%, 128%, 135%, 141% over four years

Federal Account Manager | Defense Contractor | 2010-2015
- Managed $35M book of business across Army and Intel Community accounts
- Supported $200M program capture as sales lead
- Built relationships with contracting officers and program managers
- Transitioned 8 accounts from on-premise to cloud solutions

Sales Representative | Technology Reseller | 2007-2010
- Developed new business in federal civilian and DoD markets
- Achieved Rookie of the Year, promoted twice in three years

EDUCATION
B.S. Business Administration, Penn State University

CERTIFICATIONS
- AWS AI Practitioner
- Salesforce Certified Administrator
- MEDDIC Sales Methodology Certified

SKILLS
Federal Sales, Strategic Partnerships, Account Planning, Contract Negotiations, IDIQ/GWAC, FAR/DFARS, Executive Relationships, Pipeline Management, Salesforce, Quota Achievement`;
    const SAMPLE_JD = `Principal DoD Sales Representative
Amazon Web Services (AWS) - Arlington, VA

About the Role:
AWS is seeking an experienced Principal DoD Sales Representative to drive adoption of cloud services across Department of Defense customers. You will be responsible for developing and executing sales strategies for a portfolio of DoD accounts, working closely with solutions architects, partners, and AWS leadership to accelerate cloud adoption.

Basic Qualifications:
- 10+ years of enterprise sales experience, with 7+ years selling to DoD customers
- Active Top Secret/SCI clearance
- Track record of exceeding sales quotas of $50M+ annually
- Experience selling cloud, SaaS, or enterprise software solutions
- Bachelor's degree required

Preferred Qualifications:
- Experience selling cloud infrastructure (AWS, Azure, GCP)
- Established relationships with DoD CIOs and program executives
- Experience with DoD procurement vehicles (IDIQ, BPA, GWACs)
- Understanding of FedRAMP, IL4/IL5/IL6 requirements
- MBA or advanced degree
- AWS certifications
- Experience working with defense prime contractors and system integrators
- MEDDIC or similar sales methodology experience

Responsibilities:
- Own full sales cycle for assigned DoD accounts
- Develop account strategies and territory plans to exceed revenue targets
- Build and maintain executive relationships with DoD customers
- Collaborate with solutions architects on technical requirements
- Coordinate with partners to drive joint opportunities
- Provide accurate forecasting and pipeline management
- Support ATO and security accreditation processes
- Represent AWS at DoD industry events and conferences

Compensation: $200,000 - $280,000 OTE (base + variable)
Location: Arlington, VA (customer site visits required)

Amazon is an Equal Opportunity Employer.`;

    function loadSampleData(silent) {
        $('resumeText').value = SAMPLE_RESUME;
        $('jobDescription').value = SAMPLE_JD;
        state.fileFlags = null; state.fileName = ''; state.resumeSource = 'example'; state.exampleResume = $('resumeText').value.trim(); state.exampleJd = $('jobDescription').value.trim();
        setFileStatus('info', silent
            ? '<span class="grow"><strong>This is the example.</strong> Choose More, then Start a new job, and add your own posting and resume.</span>'
            : '<span class="grow">Sample resume and job loaded. Your own saved resume is untouched and comes back when you reload.</span>');
        updateCounts();          // the sample is intentionally not remembered
        $('resumeSavedNote').textContent = '';
        renderResumeCheck();
        showInlineError('');
        if (!silent) snackbar('Sample loaded. Choose "Check this job" to run it.');
    }

    // A worked example, shown on a first visit so the page answers "what do I get?" before asking for anything.
    // It is a fixed, pre-written result for the sample resume and job above (no AI call is made to show it).
    const EXAMPLE_ANALYSIS = {
        job_title: 'Principal DoD Sales Representative', company: 'Amazon Web Services (AWS)',
        job_summary: 'Own the full sales cycle for a portfolio of DoD cloud accounts.',
        score: 83, verdict: 'Strong match',
        analysis: [
            'Match: DoD quota attainment → 145% of quota in FY23 and 138% in FY22 on a $180M territory',
            'Match: Clearance → The role requires an active TS/SCI; the resume shows an active TS/SCI',
            'Match: Large federal deals → Closed a $95M multi-year Army agreement and led a $45M Navy IDIQ capture',
            'Match: Partner selling → Built a 25-partner ecosystem driving 40% of pipeline',
            'Match: Procurement vehicles → IDIQ/GWAC and FAR/DFARS experience across Army, Navy, Air Force and DISA',
            'Match: Sales methodology → MEDDIC certified',
            'Gap: Cloud infrastructure → Experience is cybersecurity and enterprise software, not AWS, Azure or GCP',
            'Gap: Advanced degree → MBA preferred; the resume shows a B.S.'
        ],
        tailored_summary: 'Senior federal sales executive with 15+ years selling enterprise software and cybersecurity to the Department of Defense and Intelligence Community. Carries a $180M DoD territory at 145% of quota, with a $95M Army enterprise agreement and a $45M Navy IDIQ among recent wins. Active TS/SCI. Builds partner ecosystems with defense primes and systems integrators and works alongside solutions architects through ATO.',
        interview_questions: [
            { question: 'Walk me through the largest DoD deal you have closed.', suggested_answer: 'Use the $95M multi-year Army enterprise license agreement: how you found the requirement, who you sold to, how partners were involved, and how long it took.' },
            { question: 'You have sold security and software. How will you sell cloud infrastructure?', suggested_answer: 'Point to the 8 accounts you moved from on-premise to cloud and the ATO work with solutions architects, then be direct that consumption selling is new and say how you will ramp.' },
            { question: 'How do you work with partners without channel conflict?', suggested_answer: 'Describe the 25-partner ecosystem that drives 40% of your pipeline and the joint pursuits with Lockheed Martin, Northrop Grumman and GDIT.' }
        ],
        gap_strategies: [
            { gap: 'Cloud infrastructure selling', strategy: 'Tie your software and security wins to cloud adoption, and name the AWS certification you already have.', talking_points: 'Eight of my accounts moved to cloud on my watch, and I worked the ATO side with our architects.' },
            { gap: 'No MBA', strategy: 'It is listed as preferred, not required. Let the quota record carry it and do not raise it yourself.', talking_points: 'If asked: fifteen years of DoD selling and four straight years over quota.' }
        ],
        keywords: [
            { term: 'DoD', in_resume: true, importance: 'critical' }, { term: 'Quota attainment', in_resume: true, importance: 'critical' },
            { term: 'TS/SCI', in_resume: true, importance: 'critical' },
            { term: 'IDIQ', in_resume: true, importance: 'important' }, { term: 'GWAC', in_resume: true, importance: 'important' },
            { term: 'ATO', in_resume: true, importance: 'important' }, { term: 'MEDDIC', in_resume: true, importance: 'important' },
            { term: 'FedRAMP', in_resume: false, importance: 'important' }, { term: 'IL5', in_resume: false, importance: 'important' },
            { term: 'Cloud infrastructure', in_resume: false, importance: 'important' }, { term: 'Cloud migration', in_resume: false, importance: 'important' }
        ],
        clearance: { required: 'Active TS/SCI', candidate: 'Active TS/SCI', status: 'meets', note: 'The posting lists it as a basic qualification.' },
        requirements: [
            { requirement: 'Active TS/SCI clearance', type: 'required', resume_shows: 'Active TS/SCI', status: 'met', screen_out: true },
            { requirement: '7+ years selling to the DoD', type: 'required', resume_shows: '15+ years across DoD and the Intelligence Community', status: 'met', screen_out: true },
            { requirement: '$50M+ annual quota', type: 'required', resume_shows: '$180M territory at 145% of quota', status: 'met' },
            { requirement: 'Cloud infrastructure sales', type: 'preferred', resume_shows: 'Cybersecurity and software; moved 8 accounts to cloud', status: 'partial' },
            { requirement: 'MBA', type: 'preferred', resume_shows: 'B.S. Business Administration', status: 'missing' }
        ],
        bullet_rewrites: [
            { original: 'Lead DoD sales territory generating $180M+ annual revenue', improved: 'Own a $180M+ DoD territory across DISA, Army, Navy and Air Force, finishing FY23 at 145% of quota', why: 'Puts quota attainment, the first thing this role screens on, in the opening bullet.' },
            { original: 'Transitioned 8 accounts from on-premise to cloud solutions', improved: 'Led cloud migration for 8 Army and Intelligence Community accounts, moving them from on-premise to cloud solutions', why: 'Uses the posting\'s own term for work you already did, and names the customers.' }
        ],
        fit_signals: [
            { signal: 'Annual quota', role_expects: '$50M+', resume_shows: '$180M territory at 145%', status: 'strong' },
            { signal: 'Years selling to DoD', role_expects: '7+', resume_shows: '15+', status: 'strong' },
            { signal: 'Clearance', role_expects: 'Active TS/SCI', resume_shows: 'Active TS/SCI', status: 'strong' },
            { signal: 'Product sold', role_expects: 'Cloud infrastructure', resume_shows: 'Cybersecurity and enterprise software', status: 'partial' }
        ],
        questions_to_ask: [
            { question: 'How many reps on this team hit quota last year?', why: 'If few did, the number is a wish, not a plan.' },
            { question: 'Why is this seat open?', why: 'A promotion is good news. A string of departures is not.' },
            { question: 'Which accounts would I inherit, and what is already in the pipeline?', why: 'It tells you how much of the first-year number you have to build from nothing.' }
        ],
        recommendation: { action: 'apply', label: 'Apply now.', decisive_requirement: 'Active TS/SCI',
            headline: 'Your DoD sales record and your clearance both clear the bar. Move your cloud work to the top of your resume, then send it.',
            reasons: ['Your $180M territory at 145% is well past the $50M quota they ask for.', 'Your cloud experience is real but buried in an older role. Ten minutes of tailoring fixes that.'],
            next_step: 'Tailor the two bullets under Your resume, then write to the hiring team.',
            recruiter_question: "Hi [Name], I'm interested in the Principal DoD Sales Representative role. I hold an active TS/SCI and carry a $180M DoD territory at 145% of quota. Is the team still interviewing, and who is the hiring manager? Thank you." },
        salary_intel: { low: 200, mid: 240, high: 280, pay_source: 'posting', base_source: 'estimate', is_variable_comp: true, base_low: 130, base_high: 160, pay_mix: '55/45', comp_questions: ['What is the quota, and how was it set?', 'How long is the ramp, and is it guaranteed?', 'Are there accelerators past 100%, and is there a cap?', 'Which accounts are in the territory today?'], notes: 'The on-target range is from the posting. The base range is an estimate.' },
        competition: { level: 'Moderate', reasoning: 'The TS/SCI requirement narrows the pool, but strong DoD sellers will apply.' },
        company_intel: { known: true, type: 'Cloud service provider', size: 'Large', reputation: 'Strong in federal' },
        timeline: { screen_weeks: '1-2', interview_weeks: '3-5', offer_weeks: '6-8', notes: 'Expect a multi-interview loop.' }
    };

    // The example's tailored resume. Every fact in it comes from SAMPLE_RESUME; only the order and wording change.
    const EXAMPLE_TAILORED = {
        name: 'JOHN DOE',
        headline: 'Principal DoD Sales Executive | Enterprise Software, Cybersecurity and Cloud Adoption',
        contact: 'Arlington, VA | johndoe@email.com | (703) 555-1234',
        clearance: 'Active TS/SCI',
        summary: 'Senior federal sales executive with 15+ years selling to the Department of Defense and Intelligence Community. Carries a $180M+ DoD territory at 145% of quota across DISA, Army, Navy and Air Force. Led cloud migration for 8 Army and Intelligence Community accounts and works with solutions architects through ATO. Builds partner ecosystems with defense primes and systems integrators.',
        skills: ['DoD and Intelligence Community sales', 'Quota attainment', 'Cloud adoption and ATO support', 'IDIQ/GWAC', 'FAR/DFARS', 'Partner ecosystems', 'Strategic account planning', 'MEDDIC', 'Contract negotiations', 'Salesforce'],
        experience: [
            { title: 'Account Manager', company: 'Major Cybersecurity Provider', location: '', dates: '2019-Present', bullets: [
                'Own a $180M+ DoD territory across DISA, Army, Navy and Air Force, finishing FY23 at 145% of quota and FY22 at 138% (President\'s Club both years)',
                'Closed a $95M multi-year enterprise license agreement with an Army customer',
                'Built a partner ecosystem of 25+ defense contractors that drives 40% of pipeline',
                'Work with solutions architects on technical requirements and ATO support' ] },
            { title: 'Senior Account Executive, Defense', company: 'Enterprise Software Company', location: '', dates: '2015-2019', bullets: [
                'Grew a DoD territory from $12M to $67M in annual recurring revenue',
                'Led capture of a $45M IDIQ contract with a Navy customer',
                'Exceeded quota four years running: 112%, 128%, 135%, 141%',
                'Built strategic account plans for the top 15 DoD accounts and ran joint pursuits with Lockheed Martin, Northrop Grumman and GDIT' ] },
            { title: 'Federal Account Manager', company: 'Defense Contractor', location: '', dates: '2010-2015', bullets: [
                'Led cloud migration for 8 Army and Intelligence Community accounts, moving them from on-premise to cloud solutions',
                'Managed a $35M book of business across Army and Intelligence Community accounts',
                'Sales lead on a $200M program capture, working with contracting officers and program managers' ] },
            { title: 'Sales Representative', company: 'Technology Reseller', location: '', dates: '2007-2010', bullets: [
                'Developed new business in federal civilian and DoD markets; Rookie of the Year, promoted twice in three years' ] }
        ],
        education: ['B.S. Business Administration, Penn State University'],
        certifications: ['AWS AI Practitioner', 'MEDDIC Sales Methodology Certified', 'Salesforce Certified Administrator'],
        additional: [],
        changes: [
            'Brought the cloud work forward and called it what the posting calls it, cloud migration. It is the same 8 accounts from your 2010-2015 role.',
            'Opened the current role with the quota numbers this posting screens on.',
            'Reworded skills to match the posting\'s terms. Nothing was added that is not in the original.'
        ]
    };

    // First visit: show the example answer straight away, with the job and resume boxes left empty and ready.
    const NARROW = window.matchMedia('(max-width: 879px)');
    const isFirstVisit = () => !NARROW.matches && !state.exampleDismissed && !$('resumeText').value.trim() && !$('jobDescription').value.trim() && !state.tracked.length && !Object.keys(getSavedResumes()).length;
    function showExamplePreview() {
        state.analysis = EXAMPLE_ANALYSIS;
        state.isExample = true; state.previewOnly = true;
        state.resumeText = SAMPLE_RESUME; state.jd = SAMPLE_JD;      // so the example's own tools (Ask AI, tailoring) have something to work on
        resetGenerated();
        renderResults(EXAMPLE_ANALYSIS);
        showExampleTailored();
    }
    // The example arrives with its tailored resume already written, so the before and after are visible at once.
    function showExampleTailored() {
        state.tailored = EXAMPLE_TAILORED;
        state.tailorScore = null;               // the example makes no fit-score claim: only what can be counted
        state.tailorPairs = null;
        state.tailorKeywords = keywordShift(EXAMPLE_ANALYSIS, SAMPLE_RESUME, tailoredToText(EXAMPLE_TAILORED));
        renderTailored(EXAMPLE_TAILORED, true);
    }
    function expandExample() {
        state.previewOnly = false;
        document.body.classList.remove('example-compact');
        $('verdict').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        track('example_viewed');
    }

    // "See a sample result": shows the example answer only. The job and resume boxes are never touched.
    function showExample() {
        resetAnalyzeUi();
        state.trackedId = null; state.postingUrl = ''; state.linkHelp = null; state.linkedText = ''; renderLinkHelp();
        showInlineError('');
        showExamplePreview();
        state.previewOnly = false;
        document.body.classList.remove('example-compact');
        $('resultCol').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        track('example_viewed');
    }

    // "Check my own job": put the example away and hand the form back.
    function exitExample() {
        resetAnalyzeUi();
        state.exampleDismissed = true;           // do not bring it back on its own during this visit
        state.analysis = null; state.isExample = false; state.previewOnly = false; state.jd = '';
        state.resumeText = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        resetGenerated();
        setResultState('empty');
        $('inputs').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        $('jobDescription').focus({ preventScroll: true });
    }

    // The example resume is never carried into a real job.
    function dropExampleResume() {
        if (state.resumeSource !== 'example') return;
        $('resumeText').value = ''; state.resumeSource = ''; state.resumeText = '';
        setFileStatus();
        const draft = store.getRaw(KEYS.draft);
        if (draft.trim() && draft.trim() !== state.exampleResume) $('resumeText').value = draft;
        else { const r = getSavedResumes(); const n = Object.keys(r).sort((a, b) => (r[b].savedAt || '').localeCompare(r[a].savedAt || ''))[0]; if (n) $('resumeText').value = r[n].text; }
        updateResumeSelector(); renderResumeCheck(); setResumeMode(false);
    }

    function newJob() {
        resetAnalyzeUi();
        $('jobDescription').value = '';
        dropExampleResume();
        state.analysis = null; state.jd = ''; state.isExample = false;
        state.trackedId = null; state.postingUrl = ''; state.linkHelp = null; state.linkedText = '';
        resetGenerated();
        setResultState('empty');
        showInlineError(''); updateCounts(); renderLinkHelp();
        $('jobDescription').focus();
    }

    // ======================================================================
    // INIT + EVENT WIRING
    // ======================================================================
    const ACTIONS = {
        'analyze': () => runCheck(),
        'compare-versions': () => compareVersions(),
        'back-to-batch': () => backToBatch(),
        'batch-save-all': () => saveBatchJobs(),
        'example': () => showExample(),
        'change-resume': () => { setResumeMode(true); $('pasteRow').open = true; },
        'primary-action': () => runPrimaryAction(),
        'copy-recruiter-question': () => state.recruiterQuestion ? copyText(state.recruiterQuestion, 'Question copied. Paste it into a message to the recruiter.') : snackbar('Check a job first.'),
        'save-resume': () => saveCurrentResume(),
        'clear-resume': () => clearResume(),
        'ocr': () => readResumeWithAI(),
        'new-job': () => newJob(),
        'edit-inputs': () => { document.querySelector('.calc').classList.add('editing'); $('jobCard').scrollIntoView({ behavior: scrollBehavior(), block: 'start' }); $('jobDescription').focus({ preventScroll: true }); },
        'save-job': () => saveToTracker(),
        'download-report': () => downloadReport(),
        'share': () => shareTool(),
        'drop-link': () => dropLink(),
        'copy-link': () => { copyText(SHARE_URL, 'Link copied. Paste it anywhere.'); track('share', { method: 'copy_link' }); },
        'tailor': (b) => buildTailoredResume(b),
        'view-tailored': () => viewTailored(),
        'go-email': () => goToEmail(),
        'download-docx': () => downloadTailoredDocx(),
        'copy-tailored': () => state.tailored && copyText(tailoredToText(state.tailored), 'Resume text copied.'),
        'use-tailored': () => useTailoredAsResume(),
        'copy-missing-keywords': () => { const k = ((state.analysis || {}).keywords || []).filter(x => x && !x.in_resume).map(x => x.term); k.length ? copyText(k.join(', '), 'Missing keywords copied.') : snackbar('Nothing missing: every keyword is in your resume.'); },
        'linkedin': (b) => writeLinkedInNotes(b),
        'email': (b) => writeIntroEmail(b),
        'ask': () => askRecruiter(),
        'clear-chat': () => { state.chat = []; $('chat').innerHTML = ''; },
        'compare': () => onCompareClick(),
        'compare-cancel': () => cancelCompare(),
        'close-compare': () => cancelCompare(),
        'export-csv': () => exportTrackerCSV(),
        'backup': () => backupData(),
        'restore': () => $('restoreFile').click(),
        'example-expand': () => expandExample(),
        'exit-example': () => exitExample(),
        'suggest-terms': () => suggestSearchTerms(),
        'add-resume': () => { showView('analyze'); setResumeMode(true); $('resumeDrop').focus(); },
        'handoff-check': () => handoffCheck(),
        'handoff-save': () => openSaveForm(),
        'handoff-save-cancel': () => closeSaveForm(),
        'dismiss-snackbar': () => $('snackbar').classList.remove('show')
    };

    function init() {
        state.tracked = (store.get(KEYS.tracker, []) || []).filter(j => j && typeof j === 'object');
        $('militaryToggle').checked = store.getRaw(KEYS.military) === '1';
        $('militaryChip').hidden = !$('militaryToggle').checked;
        loadInitialResume();
        initTabs();
        initMenus();
        initFileDrop();
        initTrackerEvents();
        initFindJobs();
        EXTRA_JOB_IDS.forEach(id => $(id).addEventListener('input', updateBatchUi));
        $('resultCol').addEventListener('click', (e) => { const row = e.target.closest('[data-batch-open]'); if (row) openBatchItem(Number(row.dataset.batchOpen)); });
        updateCounts();
        renderResumeCheck();
        updateTrackerBadge();
        // First visit (nothing saved yet): open on a worked example. Returning visitors get their own resume.
        setResultState('empty');
        if (HASH_VIEW[location.hash] && HASH_VIEW[location.hash] !== 'analyze') showView(HASH_VIEW[location.hash]);

        document.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (actionEl && ACTIONS[actionEl.dataset.action]) { e.preventDefault(); return ACTIONS[actionEl.dataset.action](actionEl); }
            const copyEl = e.target.closest('[data-copy]');
            if (copyEl) { const src = document.querySelector(copyEl.dataset.copy); if (src) copyText(src.innerText || src.textContent); return; }
            const viewEl = e.target.closest('[data-view-link]');
            if (viewEl) return showView(viewEl.dataset.viewLink);
            const tpl = e.target.closest('[data-template]');
            if (tpl) return showTemplate(tpl.dataset.template);
            const askEl = e.target.closest('[data-ask]');
            if (askEl) return askRecruiter(askEl.dataset.ask);
            const loadEl = e.target.closest('[data-load-resume]');
            if (loadEl) return loadSavedResume(loadEl.dataset.loadResume);
            const delEl = e.target.closest('[data-delete-resume]');
            if (delEl) return deleteSavedResume(delEl.dataset.deleteResume);
        });
        $('resumeText').addEventListener('input', onResumeChanged);
        $('jobDescription').addEventListener('input', (e) => { if (e.inputType === 'insertFromPaste' && isUrl(e.target.value)) return readLink(e.target.value); if (state.linkHelp === 'read' && e.target.value !== state.linkedText) { state.linkHelp = 'kept'; state.linkedText = ''; renderLinkHelp(); } if (!e.target.value.trim()) jobReplaced(); if (e.target.value.trim()) clearFieldError('job'); updateCounts(); });
        $('jobDescription').addEventListener('paste', (e) => { const t = e.target; if (t.selectionStart === 0 && t.selectionEnd === t.value.length) jobReplaced(); });
        $('militaryToggle').addEventListener('change', (e) => { store.set(KEYS.military, e.target.checked ? '1' : '0'); $('militaryChip').hidden = !e.target.checked; });
        $('restoreFile').addEventListener('change', (e) => restoreData(e.target.files[0]));
        // Ctrl/Cmd + Enter: analyze from either input, send from the chat box
        ['resumeText', 'jobDescription', 'recruiterQuestion'].forEach(id => $(id).addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            if (id === 'recruiterQuestion') askRecruiter();
            else if (!$('analyzeBtn').disabled) runCheck();
        }));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
