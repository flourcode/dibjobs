/* ==========================================================================
   DIB Jobs Recruiter - candidate screening
   Queue resumes against one job description, rank them, and show a
   send / review / pass call for each. File reading is shared with the main
   site (assets/files.js) and so is the backend: the DIB Jobs Lambda's
   "recruiter_screen" request.
   ========================================================================== */
(() => {
    'use strict';

    // ======================================================================
    // CONFIG + STATE
    // ======================================================================
    // The same Lambda as the job seeker pages (assets/app.js); the recruiter analysis is its "recruiter_screen" request.
    const API_ENDPOINT = 'https://pchkhu4vitpzuppdmtnrlxx2sy0idjzp.lambda-url.us-east-1.on.aws/';
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const RATE_WAIT_MS = (window.DIB_TEST && window.DIB_TEST.rateWaitMs) || 25000;
    const { readDocumentFile, countWords, MAX_RESUME_CHARS, MAX_JD_CHARS } = window.DIBFiles;

    let queue = [];              // { id, name, resumeText, status: pending|analyzing|complete|error, result, error }
    let results = [];            // completed analyses, { id, name, resumeText, ...result }
    let filter = 'all';
    let sort = { column: 'score', direction: 'desc' };
    let nextId = 1;
    let running = false;
    const USED_KEY = 'dib_jobs_recruiter_used';
    let isExample = false;
    let stash = null;            // the recruiter's own queue and results while the example is on screen       // the built-in example is on screen (made-up job and candidates)
    let snackTimer = null;

    const $ = (id) => document.getElementById(id);
    const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
    const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    const track = (event, params) => { if (typeof gtag === 'function') gtag('event', event, params || {}); };
    const keyPart = (str) => String(str || '').split(/\s*(?:→|->)\s*/)[0].trim();
    const lines = (result, prefix) => (Array.isArray(result.analysis) ? result.analysis : [])
        .filter(a => typeof a === 'string' && a.toLowerCase().startsWith(prefix + ':'))
        .map(a => a.slice(prefix.length + 1).trim());

    function snackbar(message, duration = 4000) {
        $('snackbarText').textContent = message;
        $('snackbar').classList.add('show');
        clearTimeout(snackTimer);
        snackTimer = setTimeout(() => $('snackbar').classList.remove('show'), duration);
    }

    function showInlineError(message) {
        $('inlineError').textContent = message || '';
        $('inlineError').hidden = !message;
    }

    // ======================================================================
    // NAME EXTRACTION - filename first, then the resume text
    // ======================================================================
    function extractNameFromFilename(filename) {
        if (!filename) return null;
        let name = filename.replace(/\.(pdf|docx?|txt|rtf|md)$/i, '');
        name = name.replace(/(resume|cv|curriculum[\s_-]*vitae|cover[\s_-]*letter|application)/gi, ' ');
        name = name.replace(/20\d{2}/g, ' ');
        name = name.replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi, ' ');
        name = name.replace(/\b(v\d+|version[\s_-]*\d+|final|draft|updated|new|copy|edit|\d+)\b/gi, ' ');
        name = name.replace(/[_-]+/g, ' ').replace(/[()\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
        if (name.length < 2) return null;
        if (['resume', 'cv', 'document', 'file', 'untitled', 'download', 'attachment'].includes(name.toLowerCase())) return null;
        return name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    function extractNameFromResume(resumeText) {
        if (!resumeText) return null;
        const rows = resumeText.split('\n').map(l => l.trim()).filter(Boolean);
        const headers = new Set(['summary', 'experience', 'education', 'skills', 'profile', 'objective', 'qualifications', 'competencies',
            'core competencies', 'key competencies', 'professional experience', 'work experience', 'employment history', 'career summary',
            'professional summary', 'executive summary', 'technical skills', 'certifications', 'achievements', 'accomplishments', 'references',
            'awards', 'publications', 'languages', 'interests', 'hobbies', 'contact', 'contact information', 'personal information', 'resume',
            'cv', 'curriculum vitae', 'account management', 'project management', 'business development', 'contract negotiation', 'sales',
            'marketing', 'leadership', 'management', 'communication', 'strategic planning', 'customer relations', 'team leadership',
            'problem solving', 'analytics', 'operations', 'finance', 'human resources', 'areas of expertise', 'key skills',
            'professional profile', 'career objective', 'overview', 'about', 'about me', 'background']);
        for (let i = 0; i < Math.min(rows.length, 20); i++) {
            const line = rows[i];
            if (headers.has(line.toLowerCase())) continue;
            if (line.length < 4 || line.length > 45) continue;
            if (/[@|•:()\/]/.test(line) || /\d{3}.*\d{3}.*\d{4}/.test(line) || /\d{4,}/.test(line) || /^\d/.test(line)) continue;
            if (/http|www\.|\.com|\.org|\.net/i.test(line)) continue;
            let cleaned = line.replace(/\b([A-Z])\s+(?=[A-Z]\b)/g, '$1');   // "K YLIE" -> "KYLIE"
            const words = cleaned.split(/\s+/).filter(Boolean);
            if (words.length < 2 || words.length > 4) continue;
            if (!words.every(w => /^[A-Za-z][A-Za-z.\-']*$/.test(w))) continue;
            if (cleaned === cleaned.toUpperCase()) cleaned = cleaned.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            return cleaned;
        }
        return null;
    }

    // ======================================================================
    // QUEUE
    // ======================================================================
    function addToQueue(resumeText, name) {
        const text = resumeText.trim().substring(0, MAX_RESUME_CHARS);
        if (text.length < 100) return { ok: false, reason: 'too short to be a resume' };
        if (queue.some(c => c.resumeText === text)) return { ok: false, reason: 'already in the list' };
        queue.push({ id: nextId++, name: name || extractNameFromResume(text) || `Candidate ${queue.length + 1}`, resumeText: text, status: 'pending', result: null });
        return { ok: true };
    }

    function renderQueue() {
        const n = queue.length;
        $('queueCount').textContent = `${n} candidate${n !== 1 ? 's' : ''}`;
        $('clearQueueBtn').hidden = n === 0 || isExample;
        $('exampleBtn').hidden = isExample;
        $('candidateQueue').innerHTML = n ? queue.map(c => {
            let status = `${countWords(c.resumeText).toLocaleString()} words, ready`;
            let score = '';
            if (c.status === 'analyzing') status = '<span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:-2px"></span> Screening...';
            else if (c.status === 'complete' && c.result) { status = escapeHtml(c.result.verdict || 'Done'); score = `<span class="score-pill ${band(c.result.score)}">${Math.round(c.result.score) || 0}</span>`; }
            else if (c.status === 'error') status = `<span style="color:var(--danger-ink); font-weight:600">${escapeHtml(c.error || 'Could not be screened')}</span>`;
            return `<div class="row-item queue-row"><span class="grow"><span class="queue-name">${escapeHtml(c.name)}</span><span class="queue-status">${status}</span></span>${score}<button class="icon-btn" data-remove="${c.id}" aria-label="Remove ${escapeHtml(c.name)}"${running ? ' disabled' : ''}>${icon('close')}</button></div>`;
        }).join('') : '<div class="row-item queue-row"><span class="queue-status">No candidates yet. Drop resumes in step 2 and they will line up here.</span></div>';
    }

    // ======================================================================
    // FILES: drop anywhere = resumes; drop on the job box = job description
    // ======================================================================
    function setFileStatus(kind, html) {
        const el = $('fileStatus');
        el.hidden = !html;
        el.className = 'banner ' + (kind || '');
        el.innerHTML = html ? icon({ warn: 'minus', error: 'x-circle' }[kind] || 'check') + `<span class="grow">${html}</span>` : '';
    }

    async function handleResumeFiles(fileList) {
        const files = [...fileList];
        if (!files.length) return;
        clearExample();
        $('resumeDrop').classList.add('busy');
        $('resumeDropMain').textContent = `Reading ${files.length} file${files.length > 1 ? 's' : ''}...`;
        const added = [], skipped = [];
        for (const file of files) {
            try {
                const res = await readDocumentFile(file);
                if (res.scanned || !res.text) throw new Error('looks scanned or image-only, so there is no text to read');
                const out = addToQueue(res.text, extractNameFromFilename(file.name) || extractNameFromResume(res.text));
                if (out.ok) added.push(file.name); else skipped.push(`${file.name}: ${out.reason}`);
            } catch (e) {
                skipped.push(`${file.name}: ${(e.message || 'could not be read').replace(/\.$/, '')}`);
            }
            renderQueue();
        }
        $('resumeDrop').classList.remove('busy');
        $('resumeDropMain').innerHTML = 'Drop resumes here or <u>choose files</u>';
        $('resumeFiles').value = '';
        showInlineError('');
        setFileStatus(skipped.length ? 'warn' : '', `${added.length ? `<strong>Added ${added.length} candidate${added.length > 1 ? 's' : ''}.</strong>` : '<strong>Nothing was added.</strong>'}${skipped.length ? '<br>Skipped: ' + skipped.map(escapeHtml).join('<br>') : ' Check the names in the list, then run the ranking.'}`);
        track('recruiter_files_added', { count: added.length });
    }

    async function handleJobFile(file) {
        clearExample();
        const box = $('jobDescription');
        const prev = box.placeholder;
        box.placeholder = `Reading ${file.name}...`;
        try {
            const res = await readDocumentFile(file);
            if (res.scanned || !res.text) throw new Error('No readable text was found in that file. Paste the job description instead.');
            box.value = res.text.substring(0, MAX_JD_CHARS);
            $('jobFileInfo').textContent = 'From ' + file.name;
            updateJobCount();
        } catch (e) {
            snackbar(e.message || 'That file could not be read.', 7000);
        } finally {
            box.placeholder = prev;
        }
    }

    function initFileDrop() {
        const drop = $('resumeDrop'), input = $('resumeFiles'), jobBox = $('jobDescription');
        drop.addEventListener('click', () => input.click());
        drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
        input.addEventListener('change', () => handleResumeFiles(input.files));
        const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
        const overJob = (e) => !!e.target.closest && !!e.target.closest('#jobDescription');
        let depth = 0;
        const end = () => { depth = 0; document.body.classList.remove('file-dragging'); drop.classList.remove('drop-target'); jobBox.classList.remove('drop-target'); };
        window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; document.body.classList.add('file-dragging'); } });
        window.addEventListener('dragleave', (e) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) end(); } });
        window.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            jobBox.classList.toggle('drop-target', overJob(e));
            drop.classList.toggle('drop-target', !overJob(e));
        });
        window.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            const onJob = overJob(e), files = e.dataTransfer.files;
            end();
            if (!files || !files.length) return;
            if (onJob) handleJobFile(files[0]); else handleResumeFiles(files);
        });
    }

    function updateJobCount() {
        const t = $('jobDescription').value;
        $('jobCount').textContent = t.trim() ? `${countWords(t).toLocaleString()} words` : '';
    }

    // ======================================================================
    // ANALYSIS (one candidate at a time, to stay inside rate limits)
    // ======================================================================
    async function callScreen(jobDescription, resumeText) {
        let response;
        try {
            // Sent as text/plain so the browser skips the CORS preflight request (the Lambda parses it as JSON).
            response = await fetch(API_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body: JSON.stringify({ request_type: 'recruiter_screen', job_description: jobDescription, resume_text: resumeText })
            });
        } catch (e) {
            const err = new Error('Could not reach the screening service'); err.transient = true; throw err;
        }
        let data;
        try { data = await response.json(); } catch (e) { const err = new Error('The screening service is unavailable'); err.transient = true; throw err; }
        let status = response.status;
        // A Function URL in streaming mode with the buffered handler wraps the answer as { statusCode, body }.
        if (data && typeof data.statusCode === 'number' && typeof data.body === 'string') {
            status = data.statusCode;
            try { data = JSON.parse(data.body || '{}'); } catch (e) { data = {}; }
        }
        if (status < 200 || status >= 300 || data.error) {
            const err = new Error(/unknown request type/i.test(data.error || '') ? 'Screening is not available yet' : (data.error || 'Screening failed'));
            err.transient = [502, 503, 504].includes(status);
            err.rateLimited = status === 429;
            throw err;
        }
        if (typeof data.score !== 'number') throw new Error('The answer came back incomplete');
        data.score = Math.max(0, Math.min(100, Math.round(data.score)));
        return data;
    }

    // One retry for a network blip. If the service says "slow down", wait and carry on with the same candidate.
    async function analyzeCandidate(jobDescription, resumeText, onWait) {
        let waits = 0;
        for (let attempt = 1; ; attempt++) {
            try { return await callScreen(jobDescription, resumeText); }
            catch (e) {
                if (e.rateLimited && waits < 3) { waits++; attempt--; if (onWait) onWait(RATE_WAIT_MS / 1000); await sleep(RATE_WAIT_MS); continue; }
                if (e.transient && attempt < 2) { await sleep(1500); continue; }
                throw e;
            }
        }
    }

    async function analyzeAll() {
        let jd = $('jobDescription').value.trim().substring(0, MAX_JD_CHARS);
        showInlineError('');
        const jdIsUrl = /^https?:\/\/\S+$/i.test(jd);
        if (jd.length < 50 && !jdIsUrl) return showInlineError('Add the job description in step 1 first.');
        if (!queue.length) return showInlineError('Add at least one resume in step 2.');
        if (running) return;
        running = true;
        const btn = $('analyzeAllBtn');
        btn.disabled = true;
        results = [];
        let done = 0;
        for (const c of queue) {
            $('analyzeText').textContent = `Screening ${done + 1} of ${queue.length}...`;
            c.status = 'analyzing'; c.error = '';
            renderQueue();
            try {
                const label = `Screening ${done + 1} of ${queue.length}...`;
                const result = await analyzeCandidate(jd, c.resumeText, (secs) => { $('analyzeText').textContent = `Pausing ${secs} seconds, then continuing...`; setTimeout(() => { if (running) $('analyzeText').textContent = label; }, secs * 1000); });
                // A link was given: the service returns the posting text it read. Show it and reuse it for the rest.
                if (result.job_description_text) { jd = result.job_description_text.substring(0, MAX_JD_CHARS); $('jobDescription').value = jd; updateJobCount(); delete result.job_description_text; }
                c.status = 'complete'; c.result = result;
                results.push({ id: c.id, name: c.name, resumeText: c.resumeText, ...result });
            } catch (e) {
                c.status = 'error'; c.result = null; c.error = e.message;
            }
            done++;
            renderQueue();
        }
        running = false;
        btn.disabled = false;
        $('analyzeText').textContent = results.length ? 'Run the ranking again' : 'Rank these candidates';
        renderQueue();
        sort = { column: 'score', direction: 'desc' };
        applySort();
        renderResults();
        const failed = queue.length - results.length;
        if (!results.length) showInlineError('None of the candidates could be screened. Try again in a minute.');
        else {
            snackbar(`Ranked ${results.length} candidate${results.length > 1 ? 's' : ''}${failed ? `; ${failed} could not be screened` : ''}.`);
            $('resultsCard').scrollIntoView({ behavior: (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth', block: 'start' });
        }
        if (results.length) { try { localStorage.setItem(USED_KEY, '1'); } catch (e) { /* not essential */ } }
        track('recruiter_ranking_complete', { count: results.length });
    }

    // ======================================================================
    // RESULTS
    // ======================================================================
    const band = (score) => score >= 75 ? 'high' : score >= 50 ? 'mid' : 'low';

    // The call for each candidate: the backend's own risk level when it sends one, else from the score.
    function callFor(result) {
        const risk = (result.recruiter_summary || {}).risk_level;
        const level = ['green', 'yellow', 'red'].includes(risk) ? risk : (result.score >= 75 ? 'green' : result.score >= 60 ? 'yellow' : 'red');
        return { green: { key: 'send', label: 'Send', chip: 'status-ok' }, yellow: { key: 'review', label: 'Review', chip: 'warn' }, red: { key: 'pass', label: 'Pass', chip: 'bad' } }[level];
    }

    function topStrength(result) {
        return (result.recruiter_summary || {}).top_strength || keyPart(lines(result, 'match')[0]) || '';
    }

    function topConcern(result) {
        const summary = result.recruiter_summary || {};
        if (summary.dealbreaker) return { text: summary.dealbreaker, dealbreaker: true };
        if (summary.concern) return { text: summary.concern, dealbreaker: false };
        // No concern written out: say what is missing, not just which requirement it was.
        const first = (Array.isArray(result.analysis) ? result.analysis : []).find(x => /^\s*gap\b/i.test(x)) || '';
        const [req, found] = first.replace(/^\s*gap\s*:\s*/i, '').split(/\s*(?:\u2192|->)\s*/);
        const fallback = ((result.gap_strategies || []).find(g => g && g.gap) || {}).gap || '';
        return { text: found ? `${found} (job asks for: ${req})` : (req || fallback), dealbreaker: false };
    }

    function applySort() {
        const dir = sort.direction === 'asc' ? 1 : -1;
        results.sort((a, b) => sort.column === 'name'
            ? dir * String(a.name).localeCompare(String(b.name))
            : dir * ((a.score || 0) - (b.score || 0)));
    }

    function renderResults() {
        $('resultsCard').hidden = results.length === 0;
        if (!results.length) return;

        // Summary: the number first, then the call, then why
        const calls = results.map(callFor);
        const send = calls.filter(c => c.key === 'send').length, review = calls.filter(c => c.key === 'review').length, pass = calls.filter(c => c.key === 'pass').length;
        const best = [...results].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
        const total = results.length;
        $('summaryVerdict').dataset.tone = send ? 'good' : review ? 'caution' : 'bad';
        $('sendCount').textContent = send;
        $('sendUnit').innerHTML = `worth sending<br>of ${total} screened`;
        $('summaryLabel').textContent = send ? `Send ${best.name} first.` : review ? 'No one clears the bar yet.' : 'This slate is a pass.';
        $('summaryExplain').textContent = send
            ? `${best.name} leads at ${best.score}${topStrength(best) ? `: ${topStrength(best).replace(/\.$/, '')}` : ''}. ${review ? `${review} more need${review === 1 ? 's' : ''} a closer look.` : ''}`.trim()
            : review ? `${review} candidate${review > 1 ? 's are' : ' is'} worth a closer read. The best score is ${best.score}.`
                : `The best score is ${best.score}. Widen the search or revisit the must-haves.`;
        const role = best.job_title ? `${best.job_title}${best.company && !/not specified|unknown/i.test(best.company) ? ' at ' + best.company : ''}` : 'Ranking';
        $('summaryRole').textContent = role;

        $('totalCandidates').textContent = total;
        $('strongMatches').textContent = results.filter(r => (r.score || 0) >= 75).length;
        $('avgScore').textContent = Math.round(results.reduce((n, r) => n + (r.score || 0), 0) / total);
        $('flaggedCount').textContent = results.filter(r => lines(r, 'gap').length > 0 || (r.gap_strategies || []).length > 0).length;

        const ranked = [...results].sort((a, b) => (b.score || 0) - (a.score || 0)).map(r => r.id);
        const shown = results.filter(r => filter === 'all' || callFor(r).key === filter);
        $('resultsBody').innerHTML = shown.length ? shown.map(r => {
            const call = callFor(r), concern = topConcern(r), strength = topStrength(r);
            return `<tr>
                <td class="rank">${ranked.indexOf(r.id) + 1}</td>
                <th scope="row">${escapeHtml(r.name || 'Unknown')}${r.verdict ? `<span class="sub">${escapeHtml(r.verdict)}</span>` : ''}</th>
                <td class="score"><span class="score-pill ${band(r.score)}">${r.score}</span></td>
                <td class="status-cell"><span class="chip sm ${call.chip}">${call.label}</span></td>
                <td data-label="Top strength">${strength ? escapeHtml(strength) : '<span class="muted">None identified</span>'}</td>
                <td data-label="${concern.dealbreaker ? 'Dealbreaker' : 'Key concern'}">${concern.text ? escapeHtml(concern.text) : '<span class="muted">None identified</span>'}</td>
                <td class="actions"><button class="btn" data-details="${r.id}">View<span class="sr"> ${escapeHtml(r.name || '')}</span></button></td>
            </tr>`;
        }).join('') : `<tr><td colspan="7" class="muted">No candidates in this group.</td></tr>`;
        document.querySelectorAll('#resultsTable [data-sort]').forEach(b => b.closest('th').setAttribute('aria-sort', b.dataset.sort === sort.column ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'));
    }

    function showDetails(id) {
        const r = results.find(x => String(x.id) === String(id));
        if (!r) return;
        const call = callFor(r);
        const matches = lines(r, 'match'), gaps = lines(r, 'gap');
        const strategies = (Array.isArray(r.gap_strategies) ? r.gap_strategies : []).filter(g => g && g.gap);
        const questions = (Array.isArray(r.interview_questions) ? r.interview_questions : [])
            .map(q => typeof q === 'string' ? { question: q, answer: '' } : { question: (q && q.question) || '', answer: (q && (q.suggested_answer || q.answer)) || '' })
            .filter(q => q.question.trim() && !q.question.includes('[object')).slice(0, 5);
        const keywords = (Array.isArray(r.keywords) ? r.keywords : []).filter(k => k && k.term);
        const listHtml = (items, kind) => items.length
            ? `<div class="list">${items.map(x => { const [head, ...rest] = x.split(/\s*(?:→|->)\s*/); return `<div class="list-item">${icon(kind === 'ok' ? 'check' : 'minus', 'icon lead ' + kind)}<div><div class="headline-text">${escapeHtml(head)}</div>${rest.length ? `<div class="support-text">${escapeHtml(rest.join(' '))}</div>` : ''}</div></div>`; }).join('')}</div>`
            : '<p class="body-md muted">None identified.</p>';
        $('detailEyebrow').textContent = r.job_title ? `For ${r.job_title}` : 'Candidate';
        $('detailTitle').textContent = r.name || 'Candidate';
        $('detailBody').innerHTML = `
            <div class="verdict" data-tone="${{ send: 'good', review: 'caution', pass: 'bad' }[call.key]}">
                <div class="verdict-num" style="margin-top:0"><b>${r.score}</b><span>fit score<br>out of 100</span></div>
                <p class="verdict-label">${call.label}${r.verdict ? `: ${escapeHtml(r.verdict)}` : ''}</p>
            </div>
            ${r.clearance && r.clearance.required && !/^none/i.test(r.clearance.required) && r.clearance.status !== 'not_required' ? `<div class="rows"><div class="row-item"><span>Clearance the job asks for</span><b>${escapeHtml(r.clearance.required)}</b></div><div class="row-item"><span>Resume shows</span><b>${escapeHtml(r.clearance.candidate || 'Not stated')}</b></div></div>` : ''}
            ${r.tailored_summary ? `<div><p class="eyebrow">Summary for the hiring manager</p><div class="paper prose" id="detailSummary" style="margin-top:8px">${escapeHtml(r.tailored_summary)}</div><div class="row" style="margin-top:8px"><button class="btn" data-copy="#detailSummary">${icon('copy')}Copy summary</button></div></div>` : ''}
            <div><p class="eyebrow">Strengths (${matches.length})</p><div style="margin-top:8px">${listHtml(matches, 'ok')}</div></div>
            <div><p class="eyebrow">Gaps and concerns (${gaps.length || strategies.length})</p><div style="margin-top:8px">${listHtml(gaps.length ? gaps : strategies.map(s => s.gap), 'gap')}</div></div>
            ${strategies.length ? `<div><p class="eyebrow">What to check</p><div class="stack-sm" style="margin-top:8px">${strategies.map(s => `<div class="rewrite"><div class="before"><span class="tag">Gap</span>${escapeHtml(s.gap)}</div><div class="after"><span class="tag">Check</span>${escapeHtml(s.strategy || '')}${s.talking_points ? `<div class="why">${escapeHtml(s.talking_points)}</div>` : ''}</div></div>`).join('')}</div></div>` : ''}
            ${questions.length ? `<div><p class="eyebrow">Interview questions</p><div id="interviewQuestionsList" style="margin-top:8px">${questions.map((q, i) => `<details class="disclosure qa"${i === 0 ? ' open' : ''}><summary><span>${escapeHtml(q.question)}</span>${icon('chevron', 'icon chev')}</summary>${q.answer ? `<div class="disclosure-body"><p class="label-md muted">WHAT A STRONG ANSWER DRAWS ON</p><p class="body-md">${escapeHtml(q.answer)}</p></div>` : ''}</details>`).join('')}</div></div>` : ''}
            ${keywords.length ? `<div><p class="eyebrow">Keywords from the posting</p><div class="chips" style="margin-top:8px">${keywords.map(k => `<span class="chip sm ${k.in_resume ? 'ok' : 'miss'}">${k.in_resume ? icon('check') : ''}${escapeHtml(k.term)}</span>`).join('')}</div></div>` : ''}`;
        $('detailDialog').showModal();
        $('detailDialog').scrollTop = 0;
    }

    // ======================================================================
    // EXAMPLE: one made-up role and four made-up candidates, already ranked.
    // Nothing here is sent anywhere; it only shows what a finished screen looks like.
    // ======================================================================
    const EXAMPLE_JD = `Federal Account Executive, DoD
Northgate Cloud (fictional example company) - Arlington, VA or remote

Sell our FedRAMP High cloud data platform to Department of Defense customers.

What you will do
- Own a named list of Army and Air Force accounts and carry a $4M annual quota
- Build pipeline with program offices, CIO staff and the integrators that support them
- Move deals through contract vehicles such as SEWP, ESI and OTAs, working with resellers

What we need
- 7+ years selling software or cloud services to the DoD
- A record of meeting quota, with deals over $1M
- Active Secret clearance (TS/SCI preferred)
- Working knowledge of the federal budget cycle and acquisition process`;

    const EXAMPLE_JOB = { job_title: 'Federal Account Executive, DoD', company: 'Northgate Cloud' };
    const EXAMPLE_KEYWORDS = ['DoD', 'quota', 'FedRAMP', 'SEWP', 'Secret clearance', 'Army', 'Air Force', 'resellers'];
    const kw = (...have) => EXAMPLE_KEYWORDS.map(term => ({ term, in_resume: have.includes(term) }));

    const EXAMPLE_CANDIDATES = [
        { name: 'Maya Okafor',
          resume: 'MAYA OKAFOR (fictional example)\nSenior Federal Account Executive, cloud software. Nine years selling to Army and Air Force program offices. 118% average quota attainment on a $4.5M number. Closed a $6.2M Army data platform deal through SEWP with a reseller partner. Active TS/SCI clearance.',
          result: { score: 88, verdict: 'Strong fit',
            recruiter_summary: { risk_level: 'green', top_strength: 'Nine years selling cloud to the Army and Air Force, above quota', concern: 'No OTA deals shown; the role sells through OTAs', dealbreaker: '' },
            analysis: ['Match: 7+ years selling to the DoD → nine years, Army and Air Force accounts', 'Match: Quota record with $1M+ deals → 118% average on $4.5M, including a $6.2M Army deal', 'Match: Active Secret, TS/SCI preferred → holds an active TS/SCI', 'Match: Contract vehicles and resellers → closed through SEWP with a reseller', 'Gap: OTA experience → not mentioned'],
            tailored_summary: 'Maya has sold cloud software to the Army and Air Force for nine years and has averaged 118% of a $4.5M quota. Her largest deal, $6.2M, ran through SEWP with a reseller, which is how this role sells. She holds an active TS/SCI. The one thing to ask about is OTAs, which her resume does not mention.',
            gap_strategies: [{ gap: 'No OTA deals shown', strategy: 'Ask whether she has supported an OTA or worked beside a team that did.', talking_points: 'Her SEWP and reseller experience covers most of how this role transacts.' }],
            interview_questions: [{ question: 'Walk me through the $6.2M Army deal from first meeting to award.', suggested_answer: 'Who the buyer was, how the vehicle was chosen, and what she did herself versus the reseller.' }, { question: 'Which of your current accounts would carry over to our named list?', suggested_answer: 'Specific program offices and relationships, without sharing anything proprietary.' }],
            keywords: kw('DoD', 'quota', 'SEWP', 'Army', 'Air Force', 'resellers') } },
        { name: 'Daniel Reyes',
          resume: 'DANIEL REYES (fictional example)\nRegional Sales Manager, federal cybersecurity. Eleven years selling to DoD and the intelligence community. Closed $9M in 2025 against a $7M quota. Works through Carahsoft and SEWP. Secret clearance, inactive since 2023 after moving to a role that did not require it.',
          result: { score: 79, verdict: 'Strong seller, clearance to confirm',
            recruiter_summary: { risk_level: 'yellow', top_strength: 'Eleven years of DoD selling, $9M closed last year', concern: 'Secret clearance inactive since 2023; the role needs an active one. Verify it can be reinstated.', dealbreaker: '' },
            analysis: ['Match: 7+ years selling to the DoD → eleven years across DoD and the IC', 'Match: Quota record with $1M+ deals → $9M closed against a $7M quota in 2025', 'Match: Contract vehicles and resellers → sells through Carahsoft and SEWP', 'Gap: Active Secret clearance → Secret has been inactive since 2023', 'Gap: Cloud data platform experience → background is cybersecurity, not data'],
            tailored_summary: 'Daniel has the strongest sales numbers of the four: $9M closed against $7M last year, across eleven years of DoD and IC selling. Two things hold him at review. His Secret clearance has been inactive since 2023, and the role asks for an active one. His products have been cybersecurity, not data platforms. If the clearance can be reinstated quickly, he belongs on the shortlist.',
            gap_strategies: [{ gap: 'Secret clearance inactive since 2023', strategy: 'Confirm with your security officer whether it can be reinstated without a new investigation.', talking_points: 'Ask the hiring manager whether an interim period without access is workable.' }, { gap: 'No data platform sales', strategy: 'Probe how fast he learned his last product line.', talking_points: 'His buyers and vehicles are the same ones this role uses.' }],
            interview_questions: [{ question: 'What is the exact status of your clearance, and when was your last investigation?', suggested_answer: 'Dates, the sponsoring employer, and whether it is still within the reinstatement window.' }, { question: 'How would you sell a data platform to an account that knows you for security products?', suggested_answer: 'Which existing relationships transfer and which buyers are new to him.' }],
            keywords: kw('DoD', 'quota', 'SEWP', 'Secret clearance', 'resellers') } },
        { name: 'Priya Shah',
          resume: 'PRIYA SHAH (fictional example)\nEnterprise Account Executive, commercial SaaS data analytics. Six years selling to Fortune 500 financial services and healthcare. 135% of a $3M quota in 2025, largest deal $2.4M. Supported one state government pilot. No security clearance.',
          result: { score: 62, verdict: 'Good seller, no federal background',
            recruiter_summary: { risk_level: 'yellow', top_strength: 'Sells data platforms, 135% of quota last year', concern: 'No federal selling and no clearance; the role needs 7+ years with the DoD', dealbreaker: '' },
            analysis: ['Match: Quota record with $1M+ deals → 135% of $3M, largest deal $2.4M', 'Match: Cloud data platform experience → six years selling data analytics SaaS', 'Gap: 7+ years selling to the DoD → no federal selling; one state government pilot', 'Gap: Active Secret clearance → no clearance', 'Gap: Contract vehicles and acquisition process → not shown'],
            tailored_summary: 'Priya knows the product category better than anyone else in this group and beat a $3M quota by 35% last year. She has not sold to the federal government and holds no clearance, so she would need sponsorship and a long ramp. Worth a conversation only if the hiring manager is open to a commercial seller.',
            gap_strategies: [{ gap: 'No DoD selling experience', strategy: 'Ask the hiring manager whether a commercial hire is on the table before spending her time.', talking_points: 'Her data platform knowledge would shorten product ramp, not account ramp.' }, { gap: 'No clearance', strategy: 'Confirm the company will sponsor a Secret and how long the role can run without it.', talking_points: '' }],
            interview_questions: [{ question: 'What did you learn from the state government pilot about selling to the public sector?', suggested_answer: 'Procurement steps, timelines, and how it differed from her commercial deals.' }],
            keywords: kw('quota') } },
        { name: 'Tom Becker',
          resume: 'TOM BECKER (fictional example)\nProgram Analyst supporting an Air Force program office as a contractor. Four years tracking budgets, schedules and deliverables. Wrote sections of two proposal responses. Active Secret clearance. No sales or quota-carrying experience.',
          result: { score: 41, verdict: 'Not a sales profile',
            recruiter_summary: { risk_level: 'red', top_strength: 'Knows an Air Force program office from the inside', dealbreaker: 'No sales or quota-carrying experience' },
            analysis: ['Match: Active Secret clearance → holds an active Secret', 'Match: Knowledge of the budget cycle → four years tracking program budgets', 'Gap: 7+ years selling to the DoD → no sales experience', 'Gap: Quota record with $1M+ deals → has never carried a quota', 'Gap: Contract vehicles and resellers → not shown'],
            tailored_summary: 'Tom understands how an Air Force program office works and holds an active Secret clearance, but he has never sold or carried a quota. This role needs seven years of DoD selling. He may suit a sales development or solutions role if one opens.',
            gap_strategies: [{ gap: 'No sales experience', strategy: 'Pass for this role. Keep him in mind for a sales development or customer success opening.', talking_points: '' }],
            interview_questions: [],
            keywords: kw('DoD', 'Secret clearance', 'Air Force') } }
    ];

    // auto: shown on arrival for a first-time visitor. The job box stays empty and the page does not scroll.
    function showExample(auto) {
        if (running || isExample) return;
        // The example is shown on its own. The recruiter's job description is never touched, and their
        // candidates and ranking are set aside and put back when the example is closed.
        stash = { queue, results, filter, sort };
        isExample = true;
        queue = EXAMPLE_CANDIDATES.map(c => ({ id: nextId++, name: c.name, resumeText: c.resume, status: 'complete', result: { ...EXAMPLE_JOB, ...c.result } }));
        results = queue.map(c => ({ id: c.id, name: c.name, resumeText: c.resumeText, ...c.result }));
        filter = 'all'; sort = { column: 'score', direction: 'desc' };
        document.querySelectorAll('#filterTabs [role="tab"]').forEach(t => { const on = t.dataset.filter === 'all'; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
        setFileStatus(); showInlineError(''); updateJobCount();
        applySort(); renderQueue(); renderResults(); renderExampleState();
        if (auto !== true) { $('resultsCard').scrollIntoView({ behavior: (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth', block: 'start' }); track('recruiter_example'); }
    }

    // Leave the example and put the recruiter's own candidates and ranking back as they were.
    function clearExample() {
        if (!isExample) return;
        isExample = false;
        queue = stash ? stash.queue : []; results = stash ? stash.results : [];
        if (stash) { filter = stash.filter; sort = stash.sort; }
        stash = null;
        document.querySelectorAll('#filterTabs [role="tab"]').forEach(t => { const on = t.dataset.filter === filter; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
        if ($('detailDialog').open) $('detailDialog').close();
        showInlineError('');
        renderQueue(); renderResults(); renderExampleState();
    }

    function renderExampleState() {
        $('exampleBanner').hidden = !isExample;
        $('queueExampleNote').hidden = !isExample;
        document.querySelector('.calc').classList.toggle('has-result', isExample);   // on phones, the ranked example leads
        $('exampleTag').hidden = !isExample;
        $('exampleBtn').hidden = isExample;
        $('clearQueueBtn').hidden = isExample || queue.length === 0;
        $('analyzeText').textContent = isExample ? 'Screen your own candidates' : results.length ? 'Run the ranking again' : 'Rank these candidates';
    }

    // ======================================================================
    // CSV EXPORT (blank Decision and Notes columns for the recruiter)
    // ======================================================================
    function exportCSV() {
        if (!results.length) return snackbar('Nothing to export yet.');
        const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
        const ranked = [...results].sort((a, b) => (b.score || 0) - (a.score || 0));
        const rows = [['Rank', 'Name', 'Score', 'Call', 'Verdict', 'Top strengths', 'Key gaps', 'Decision', 'Notes']];
        ranked.forEach((r, i) => {
            const strengths = lines(r, 'match').map(keyPart).slice(0, 3).join(' | ');
            let gaps = lines(r, 'gap').map(keyPart);
            if (!gaps.length) gaps = (r.gap_strategies || []).filter(g => g && g.gap).map(g => g.gap);
            rows.push([i + 1, r.name, r.score, callFor(r).label, r.verdict || '', strengths || 'None identified', gaps.slice(0, 3).join(' | ') || 'None identified', '', '']);
        });
        const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `candidate-screening-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        snackbar('CSV exported.');
    }

    // ======================================================================
    // INIT + EVENTS
    // ======================================================================
    const ACTIONS = {
        'analyze': () => { if (isExample) { clearExample(); $('jobDescription').focus(); return snackbar(queue.length ? 'Example closed. Your candidates are back.' : 'Example closed. Add your job and resumes.'); } analyzeAll(); },
        'clear-job': () => { clearExample(); $('jobDescription').value = ''; $('jobFileInfo').textContent = ''; updateJobCount(); $('jobDescription').focus(); },
        'clear-queue': () => { if (running) return; queue = []; results = []; setFileStatus(); showInlineError(''); $('analyzeText').textContent = 'Rank these candidates'; renderQueue(); renderResults(); },
        'example': () => showExample(false),
        'clear-example': () => { clearExample(); $('jobDescription').focus(); window.scrollTo({ top: 0, behavior: (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth' }); },
        'add-pasted': () => {
            clearExample();
            const out = addToQueue($('candidateResume').value, $('candidateName').value.trim());
            if (!out.ok) return snackbar(out.reason === 'too short to be a resume' ? 'Paste a full resume first (at least 100 characters).' : 'That resume is already in the list.');
            $('candidateResume').value = ''; $('candidateName').value = '';
            showInlineError(''); renderQueue();
            snackbar(`Added ${queue[queue.length - 1].name}.`);
        },
        'export-csv': () => exportCSV(),
        'close-detail': () => $('detailDialog').close(),
        'dismiss-snackbar': () => $('snackbar').classList.remove('show')
    };

    function init() {
        renderQueue(); renderExampleState();
        // First visit: show the ranked example straight away. Skipped once this browser has run a real ranking.
        let used = false; try { used = localStorage.getItem(USED_KEY) === '1'; } catch (e) { /* storage blocked: treat as a first visit */ }
        if (!used) showExample(true);
        initFileDrop();
        updateJobCount();
        $('jobDescription').addEventListener('input', () => { clearExample(); updateJobCount(); });

        // Sortable column headers
        const heads = document.querySelectorAll('#resultsTable thead th');
        [[1, 'name', 'Candidate'], [2, 'score', 'Score']].forEach(([i, key, label]) => { heads[i].setAttribute('aria-sort', 'none'); heads[i].innerHTML = `<button class="th-sort" data-sort="${key}">${label}</button>`; });

        document.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]');
            if (action && ACTIONS[action.dataset.action]) return ACTIONS[action.dataset.action]();
            const remove = e.target.closest('[data-remove]');
            if (remove && !running) { const id = Number(remove.dataset.remove); queue = queue.filter(c => c.id !== id); results = results.filter(r => r.id !== id); if (isExample && !queue.length) clearExample(); renderQueue(); renderResults(); return; }
            const details = e.target.closest('[data-details]');
            if (details) return showDetails(details.dataset.details);
            const sortBtn = e.target.closest('[data-sort]');
            if (sortBtn) { const col = sortBtn.dataset.sort; sort = { column: col, direction: sort.column === col ? (sort.direction === 'asc' ? 'desc' : 'asc') : (col === 'score' ? 'desc' : 'asc') }; applySort(); renderResults(); return; }
            const tab = e.target.closest('#filterTabs [role="tab"]');
            if (tab) { filter = tab.dataset.filter; document.querySelectorAll('#filterTabs [role="tab"]').forEach(t => { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }); renderResults(); return; }
            const copyEl = e.target.closest('[data-copy]');
            if (copyEl) { const src = document.querySelector(copyEl.dataset.copy); if (src && navigator.clipboard) navigator.clipboard.writeText(src.innerText).then(() => snackbar('Copied.'), () => snackbar('Could not copy.')); return; }
            if (e.target === $('detailDialog')) $('detailDialog').close();   // click on the backdrop
        });

        // Header menu on narrow screens
        const nav = $('navMore'), toggle = $('navToggle');
        const setNav = (open) => { nav.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); };
        toggle.addEventListener('click', () => setNav(!nav.classList.contains('open')));
        document.addEventListener('click', (e) => { if (!e.target.closest('#navToggle, #navMore')) setNav(false); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && nav.classList.contains('open')) { setNav(false); toggle.focus(); }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'jobDescription' && !running) { e.preventDefault(); analyzeAll(); }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
