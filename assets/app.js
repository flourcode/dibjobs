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
        military: 'dib_jobs_military'
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

    // ======================================================================
    // FILE READING (PDF, Word .docx, text) - runs entirely in the browser
    // ======================================================================
    const VENDOR = {
        pdf: 'vendor/pdf.min.js',
        pdfWorker: 'vendor/pdf.worker.min.js',
        mammoth: 'vendor/mammoth.browser.min.js'
    };
    const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB to read locally
    const MAX_OCR_BYTES = 4 * 1024 * 1024;     // 4 MB to send for AI reading
    const MAX_PDF_PAGES = 15;
    const MAX_RESUME_CHARS = 30000;            // matches the backend limit
    const MAX_JD_CHARS = 15000;
    const scriptPromises = {};

    function loadScript(src) {
        if (!scriptPromises[src]) {
            scriptPromises[src] = new Promise((resolve, reject) => {
                const el = document.createElement('script');
                el.src = src;
                el.onload = resolve;
                el.onerror = () => { delete scriptPromises[src]; reject(new Error('Could not load the file reader. Check your connection and try again.')); };
                document.head.appendChild(el);
            });
        }
        return scriptPromises[src];
    }

    function countWords(text) {
        const m = (text || '').trim().match(/\S+/g);
        return m ? m.length : 0;
    }

    // Clean up what comes out of PDFs / Word files so the AI sees tidy text
    function normalizeExtractedText(text) {
        return (text || '')
            .replace(/\r\n?/g, '\n')
            .replace(/\u0000/g, '')
            .replace(/[  -   　]/g, ' ')
            .replace(/[​-‍﻿­]/g, '')
            .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
            .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
            .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
            .replace(/^[ \t]*[•●○▪■◦‣⁃∙➢❖o][ \t]+(?=\S)/gm, '- ')
            .replace(/^[ \t]*(page\s+)?\d+\s+(of|\/)\s+\d+[ \t]*$/gim, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    async function extractPdfText(buffer) {
        await loadScript(VENDOR.pdf);
        const pdfjsLib = window.pdfjsLib;
        if (!pdfjsLib) throw new Error('Could not load the PDF reader. Please paste your text instead.');
        pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR.pdfWorker;
        let pdf;
        try {
            pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
        } catch (e) {
            if (e && e.name === 'PasswordException') {
                throw new Error('This PDF is password-protected. Remove the password, or paste the text instead.');
            }
            throw new Error('This PDF could not be opened. It may be damaged. Try re-saving it, or paste the text instead.');
        }
        const pageCount = pdf.numPages;
        const pagesToRead = Math.min(pageCount, MAX_PDF_PAGES);
        const pages = [];
        let multiColumn = false;
        for (let p = 1; p <= pagesToRead; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            pages.push(pdfItemsToText(content.items));
            if (looksMultiColumn(content.items, page.view[2] - page.view[0])) multiColumn = true;
        }
        try { pdf.destroy(); } catch (e) { /* ignore */ }
        return { text: pages.join('\n\n'), pages: pageCount, pagesRead: pagesToRead, multiColumn };
    }

    // Rebuild lines from positioned PDF text fragments (keeps the PDF's own
    // reading order, which is what keeps two-column resumes in sequence).
    function pdfItemsToText(items) {
        let out = '';
        let line = '';
        let lastY = null, lastEndX = null, lastH = 10;
        const flush = (extraBreak) => {
            if (line.trim()) out += line.replace(/\s+$/, '') + '\n';
            if (extraBreak && out && !out.endsWith('\n\n')) out += '\n';
            line = '';
        };
        for (const item of items) {
            const str = item.str || '';
            const x = item.transform[4];
            const y = item.transform[5];
            const h = item.height || Math.abs(item.transform[3]) || lastH;
            if (lastY !== null) {
                const dy = Math.abs(y - lastY);
                if (dy > Math.max(2, Math.min(h, lastH) * 0.5)) {
                    flush(dy > Math.max(h, lastH) * 1.9);
                    lastEndX = null;
                } else if (lastEndX !== null && str.trim()) {
                    const gap = x - lastEndX;
                    if (gap > h * 0.18 && !/\s$/.test(line) && !/^\s/.test(str)) line += ' ';
                    else if (gap < -h * 2 && !/\s$/.test(line)) line += ' ';
                }
            }
            line += str;
            if (str.trim() || lastY === null) {
                lastY = y;
                lastH = h || lastH;
                lastEndX = x + (item.width || 0);
            }
            if (item.hasEOL) { flush(false); lastEndX = null; }
        }
        flush(false);
        return out;
    }

    // Many substantial lines starting well to the right AND many starting at
    // the left margin = sidebar / two-column layout.
    function looksMultiColumn(items, pageWidth) {
        if (!pageWidth) return false;
        const starts = [];
        let lastY = null, startX = 0, len = 0;
        const close = () => { if (len >= 12) starts.push(startX); };
        for (const item of items) {
            if (!item.str || !item.str.trim()) continue;
            const y = item.transform[5];
            if (lastY === null || Math.abs(y - lastY) > 2) {
                if (lastY !== null) close();
                startX = item.transform[4]; len = 0;
            }
            len += item.str.length;
            lastY = y;
        }
        close();
        if (starts.length < 12) return false;
        const margin = Math.min(...starts);
        const left = starts.filter(x => x < margin + pageWidth * 0.08).length;
        const right = starts.filter(x => x > margin + pageWidth * 0.22).length;
        return right >= 6 && left >= 6;
    }

    async function extractDocxText(buffer) {
        await loadScript(VENDOR.mammoth);
        if (!window.mammoth) throw new Error('Could not load the Word reader. Please paste your text instead.');
        let html;
        try {
            const result = await window.mammoth.convertToHtml({ arrayBuffer: buffer }, { convertImage: window.mammoth.images.imgElement(() => Promise.resolve({ src: '' })) });
            html = result.value || '';
        } catch (e) {
            throw new Error('This Word file could not be read. Re-save it as .docx or PDF, or paste the text instead.');
        }
        let text = htmlToText(html);
        const flags = { tables: (html.match(/<table/g) || []).length, headerContact: false };
        // Word headers/footers (where many resumes keep name + contact info)
        // are not part of the document body, so read them separately.
        try {
            const headerText = await extractDocxHeaderText(buffer);
            if (headerText) {
                const bodyLower = text.toLowerCase();
                const fresh = headerText.split('\n').filter(l => l.trim() && !bodyLower.includes(l.trim().toLowerCase()));
                if (fresh.length) {
                    text = fresh.join('\n') + '\n\n' + text;
                    flags.headerContact = /@|\d{3}[\s.-]\d{4}/.test(fresh.join(' '));
                }
            }
        } catch (e) { /* headers are a bonus; ignore failures */ }
        return { text, flags };
    }

    function htmlToText(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const lines = [];
        const walk = (node) => {
            for (const el of node.children) {
                const tag = el.tagName.toLowerCase();
                if (tag === 'ul' || tag === 'ol') {
                    for (const li of el.children) {
                        const nested = li.querySelector('ul, ol');
                        let own = '';
                        li.childNodes.forEach(n => { if (!(n.nodeType === 1 && /^(ul|ol)$/i.test(n.tagName))) own += n.textContent; });
                        if (own.trim()) lines.push('- ' + own.trim());
                        if (nested) walk(li);
                    }
                } else if (tag === 'table') {
                    for (const row of el.querySelectorAll('tr')) {
                        const cells = [...row.children].map(c => {
                            const sub = [];
                            const before = lines.length;
                            walk(c);
                            while (lines.length > before) sub.unshift(lines.pop());
                            return sub.length ? sub.join('\n') : c.textContent.trim();
                        }).filter(Boolean);
                        if (cells.length) lines.push(cells.join(cells.some(c => c.includes('\n')) ? '\n' : '  |  '));
                    }
                    lines.push('');
                } else if (/^h[1-6]$/.test(tag)) {
                    lines.push('', el.textContent.trim());
                } else if (tag === 'p') {
                    const clone = el.cloneNode(true);
                    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                    lines.push(clone.textContent.trim());
                } else {
                    walk(el);
                }
            }
        };
        walk(doc.body);
        return lines.join('\n');
    }

    // Minimal .docx (zip) reader for word/header*.xml, using the browser's
    // built-in decompression. Returns '' when unsupported.
    async function extractDocxHeaderText(buffer) {
        if (typeof DecompressionStream === 'undefined') return '';
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        let eocd = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) return '';
        const count = view.getUint16(eocd + 10, true);
        let ptr = view.getUint32(eocd + 16, true);
        const decoder = new TextDecoder();
        const out = [];
        for (let n = 0; n < count && ptr + 46 <= bytes.length; n++) {
            if (view.getUint32(ptr, true) !== 0x02014b50) break;
            const method = view.getUint16(ptr + 10, true);
            const compSize = view.getUint32(ptr + 20, true);
            const nameLen = view.getUint16(ptr + 28, true);
            const extraLen = view.getUint16(ptr + 30, true);
            const commentLen = view.getUint16(ptr + 32, true);
            const localOffset = view.getUint32(ptr + 42, true);
            const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
            ptr += 46 + nameLen + extraLen + commentLen;
            if (!/^word\/header\d*\.xml$/i.test(name)) continue;
            const lNameLen = view.getUint16(localOffset + 26, true);
            const lExtraLen = view.getUint16(localOffset + 28, true);
            const start = localOffset + 30 + lNameLen + lExtraLen;
            const data = bytes.subarray(start, start + compSize);
            let xml;
            if (method === 0) {
                xml = decoder.decode(data);
            } else if (method === 8) {
                const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
                xml = await new Response(stream).text();
            } else continue;
            const xdoc = new DOMParser().parseFromString(xml, 'application/xml');
            for (const p of xdoc.getElementsByTagName('w:p')) {
                let lineText = '';
                for (const node of p.getElementsByTagName('*')) {
                    if (node.tagName === 'w:t') lineText += node.textContent;
                    else if (node.tagName === 'w:tab') lineText += '  ';
                    else if (node.tagName === 'w:br') lineText += '\n';
                }
                if (lineText.trim() && !/^\s*(page\s*)?\d*\s*$/i.test(lineText)) out.push(lineText.trim());
            }
        }
        return [...new Set(out)].join('\n');
    }

    function sniffFileType(file, bytes) {
        const name = (file.name || '').toLowerCase();
        const head = String.fromCharCode(...bytes.subarray(0, 5));
        if (head.startsWith('%PDF')) return 'pdf';
        if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
            if (/\.(pages|odt|xlsx|pptx|zip)$/.test(name)) return 'unsupported';
            return 'docx';
        }
        if (bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) return 'doc';
        if (head.startsWith('{\\rtf')) return 'rtf';
        if (/\.pdf$/.test(name)) return 'pdf';
        if (/\.docx$/.test(name)) return 'docx';
        if (/\.doc$/.test(name)) return 'doc';
        if (/\.(txt|md|text)$/.test(name) || (file.type || '').startsWith('text/')) return 'text';
        if (/\.(png|jpe?g|heic|gif|webp)$/.test(name) || (file.type || '').startsWith('image/')) return 'image';
        return 'unsupported';
    }

    // Returns { text, kind, pages, pagesRead, scanned }
    async function readDocumentFile(file) {
        if (file.size > MAX_FILE_BYTES) throw new Error('That file is over 10 MB. Export a smaller PDF, or paste the text instead.');
        if (file.size === 0) throw new Error('That file is empty.');
        const buffer = await file.arrayBuffer();
        const kind = sniffFileType(file, new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength)));
        if (kind === 'doc') throw new Error('Older .doc files can\'t be read here. In Word, use File > Save As and choose .docx or PDF, then drop that in.');
        if (kind === 'rtf') throw new Error('RTF files aren\'t supported. Save as .docx or PDF, or paste the text.');
        if (kind === 'image') throw new Error('That\'s an image. Please use a PDF or Word file, or paste the text.');
        if (kind === 'unsupported') throw new Error('That file type isn\'t supported. Use a PDF, a Word .docx, or a text file.');
        if (kind === 'text') {
            return { kind, text: normalizeExtractedText(new TextDecoder().decode(buffer)) };
        }
        if (kind === 'docx') {
            const res = await extractDocxText(buffer);
            return { kind, text: normalizeExtractedText(res.text), flags: res.flags };
        }
        const res = await extractPdfText(buffer);
        const text = normalizeExtractedText(res.text);
        // Little or no text layer = scanned or image-only PDF
        const scanned = text.length < Math.max(200, 80 * res.pagesRead);
        return { kind, text, pages: res.pages, pagesRead: res.pagesRead, scanned, flags: { multiColumn: res.multiColumn, pages: res.pages } };
    }

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
    function askDialog({ title, body = '', label = '', value = '', okText = 'OK', danger = false }) {
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
            dlg.returnValue = 'cancel';
            const onClose = () => {
                dlg.removeEventListener('close', onClose);
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

    function showView(name) {
        const tab = document.querySelector(`#mainTabs [data-view="${name}"]`);
        if (!tab) return;
        selectTab($('mainTabs'), tab);
        document.querySelectorAll('main > .view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
        window.scrollTo({ top: 0 });
        if (name === 'tracker') renderTracker();
    }

    function showPanel(name) {
        const tab = document.querySelector(`#resultTabs [data-panel="${name}"]`);
        if (!tab) return;
        selectTab($('resultTabs'), tab);
        document.querySelectorAll('#results .panel').forEach(p => { p.hidden = p.id !== 'panel-' + name; });
    }

    function initTabs() {
        [['mainTabs', t => showView(t.dataset.view)], ['resultTabs', t => showPanel(t.dataset.panel)]].forEach(([id, activate]) => {
            const list = $(id);
            list.addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t) activate(t); });
            list.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                const tabs = [...list.querySelectorAll('[role="tab"]')];
                const i = tabs.indexOf(document.activeElement);
                if (i < 0) return;
                const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                next.focus(); activate(next);
            });
        });
    }

    // ======================================================================
    // RESUME INPUT: saved versions, file upload, autosave, resume check
    // ======================================================================
    const getSavedResumes = () => store.get(KEYS.resumes, {}) || {};

    function updateResumeSelector(selected = '') {
        const sel = $('resumeSelector');
        const names = Object.keys(getSavedResumes());
        sel.innerHTML = '<option value="">Saved resumes</option>';
        names.forEach(n => sel.add(new Option(n, n)));
        if (names.length) {
            const group = document.createElement('optgroup');
            group.label = 'Remove a saved resume';
            names.forEach(n => group.appendChild(new Option('Remove "' + n + '"', '__del__' + n)));
            sel.appendChild(group);
        }
        sel.value = names.includes(selected) ? selected : '';
        sel.hidden = names.length === 0;
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
        updateResumeSelector(name.substring(0, 50));
        snackbar(`Saved "${name.substring(0, 50)}".`);
    }

    async function onResumeSelect() {
        const sel = $('resumeSelector');
        const value = sel.value;
        if (!value) return;
        const resumes = getSavedResumes();
        if (value.startsWith('__del__')) {
            const name = value.slice(7);
            sel.value = '';
            const ok = await askDialog({ title: 'Remove saved resume?', body: `"${escapeHtml(name)}" will be removed from this browser.`, okText: 'Remove', danger: true });
            if (ok) { delete resumes[name]; store.set(KEYS.resumes, resumes); snackbar(`Removed "${name}".`); }
            updateResumeSelector();
            return;
        }
        if (resumes[value]) {
            $('resumeText').value = resumes[value].text;
            state.fileFlags = null; state.fileName = '';
            setFileStatus();
            onResumeChanged();
            snackbar(`Loaded "${value}".`);
        }
    }

    function clearResume() {
        $('resumeText').value = '';
        $('resumeSelector').value = '';
        state.resumeText = ''; state.pendingOcrFile = null; state.fileName = ''; state.fileFlags = null;
        setFileStatus();
        onResumeChanged();
    }

    function setFileStatus(kind, html) {
        const el = $('resumeFileStatus');
        el.hidden = !html;
        const iconName = { success: 'check', warn: 'alert', error: 'x-circle' }[kind] || 'info';
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
        $('resumeSelector').value = '';
        state.fileName = fileName.replace(/\.[^.]+$/, '').substring(0, 50);
        state.fileFlags = Object.assign({ kind: info.kind }, info.flags || {});
        onResumeChanged();
        const pageInfo = info.pages ? `${info.pages} page${info.pages !== 1 ? 's' : ''}, ` : '';
        const thin = words < 150;
        setFileStatus(thin || note ? 'warn' : 'success', `<span class="grow"><strong>${escapeHtml(fileName)}</strong> &middot; ${pageInfo}${words.toLocaleString()} words read${info.viaAI ? ' by AI' : ''}.<br>${thin
            ? 'That is less text than a typical resume. Check the text below and paste anything that is missing.'
            : 'Skim the text below to confirm it looks right. You can edit it before analyzing.'}${escapeHtml(note)}</span>`);
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

    function updateCounts() {
        const resume = $('resumeText').value, job = $('jobDescription').value;
        const fmt = (t) => t.trim() ? `${countWords(t).toLocaleString()} words` : '';
        $('resumeCount').textContent = fmt(resume) + (resume.length > MAX_RESUME_CHARS ? ` (only the first ${MAX_RESUME_CHARS.toLocaleString()} characters are analyzed)` : '');
        $('jobCount').textContent = /^https?:\/\/\S+$/i.test(job.trim()) ? 'Link detected: we will fetch the posting' : fmt(job);
    }

    function onResumeChanged() {
        updateCounts();
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
            updateResumeSelector(Object.keys(resumes).find(n => resumes[n].text === draft) || '');
            return;
        }
        const names = Object.keys(resumes).sort((a, b) => (resumes[b].savedAt || '').localeCompare(resumes[a].savedAt || ''));
        updateResumeSelector(names[0] || '');
        if (names[0]) $('resumeText').value = resumes[names[0]].text;
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
        wrap.querySelector('summary .icon use').setAttribute('href', flagged.length ? '#i-alert' : '#i-check');
        $('resumeCheckList').innerHTML = [...flagged, ...items.filter(i => i.ok)]
            .map(i => `<li class="${i.ok ? 'pass' : 'flag'}">${icon(i.ok ? 'check' : 'alert')}<span>${escapeHtml(i.msg)}</span></li>`).join('');
    }

    // ======================================================================
    // ANALYSIS (two calls: fit analysis, then market intel in the background)
    // ======================================================================
    function showInlineError(message) {
        const el = $('inlineError');
        el.textContent = message || '';
        el.hidden = !message;
    }

    function showInputs() {
        $('inputs').hidden = false;
        $('analyzeBar').hidden = false;
        $('inputSummary').hidden = true;
        document.querySelector('#view-analyze .page-intro').hidden = !$('results').hidden;
    }

    function collapseInputs() {
        const a = state.analysis;
        $('inputs').hidden = true;
        $('analyzeBar').hidden = true;
        $('inputSummary').hidden = false;
        document.querySelector('#view-analyze .page-intro').hidden = true;
        const company = knownCompany(a.company);
        $('inputSummaryText').textContent = `Your resume (${countWords(state.resumeText).toLocaleString()} words) vs. ${a.job_title || 'this role'}${company ? ' at ' + company : ''}`;
    }

    function startLoading() {
        const steps = [[15, 'Reading job description...'], [35, 'Extracting key requirements...'], [55, 'Comparing against your resume...'], [72, 'Checking clearance and fit signals...'], [86, 'Drafting interview prep...'], [94, 'Finishing up...']];
        let i = 0;
        $('loading').hidden = false;
        $('results').hidden = true;
        $('loadingProgress').style.width = '5%';
        $('loadingStep').textContent = steps[0][1];
        $('loading').scrollIntoView({ behavior: 'smooth', block: 'center' });
        clearInterval(state.loadingTimer);
        state.loadingTimer = setInterval(() => {
            if (i < steps.length) { $('loadingProgress').style.width = steps[i][0] + '%'; $('loadingStep').textContent = steps[i][1]; i++; }
        }, 1500);
    }

    function stopLoading() {
        clearInterval(state.loadingTimer);
        $('loading').hidden = true;
    }

    const jobKey = (jd) => jd.replace(/\s+/g, ' ').trim().substring(0, 160) + '|' + jd.length;

    async function analyzeJob() {
        const jd = $('jobDescription').value.trim();
        const resume = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        showInlineError('');
        if (!resume) return showInlineError(state.pendingOcrFile ? 'Your PDF had no readable text. Use "Read with AI" in the resume section, or paste your resume text.' : 'Add your resume first: drop in a PDF or Word file, or paste the text.');
        if (resume.length < 100) return showInlineError('That resume is too short to analyze. Add more detail.');
        if (!jd) return showInlineError('Add a job description: paste the text or a link to the posting.');

        const btn = $('analyzeBtn');
        btn.disabled = true;
        $('btnText').textContent = 'Analyzing...';
        startLoading();
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                if (attempt > 1) { $('btnText').textContent = `Retrying (${attempt} of ${MAX_RETRIES})...`; await sleep(RETRY_DELAY_MS); }
                const data = await api({ request_type: 'resume_match', job_description: jd, resume_text: resume, military_transition: isMilitary() });
                // If a link was given, the backend returns the text it fetched:
                // show it and use it for every follow-up call.
                state.jd = jd;
                state.jdSourceUrl = /^https?:\/\/\S+$/i.test(jd) ? jd : '';
                if (data.job_description_text) {
                    state.jd = data.job_description_text;
                    $('jobDescription').value = state.jd;
                    delete data.job_description_text;
                    updateCounts();
                }
                state.resumeText = resume;
                verifyKeywords(data, resume);
                const key = jobKey(state.jd);
                const previous = state.lastScores[key];
                state.lastScores[key] = data.score;
                state.analysis = data;
                resetGenerated();
                stopLoading();
                renderResults(data, previous);
                fetchMarketIntel();
                track('analysis_complete', { score: data.score, military: isMilitary() });
                lastError = null;
                break;
            } catch (e) {
                lastError = e;
                if (!e.transient) break;
            }
        }
        btn.disabled = false;
        $('btnText').textContent = 'Analyze job fit';
        if (lastError) {
            stopLoading();
            showInlineError(lastError.message);
            $('analyzeBar').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    async function fetchMarketIntel() {
        const requestedFor = state.analysis;
        try {
            const intel = await api({ request_type: 'market_intel', job_description: state.jd, job_title: requestedFor.job_title, company: requestedFor.company });
            if (state.analysis !== requestedFor) return;   // user moved on to another job
            Object.assign(requestedFor, { salary_intel: intel.salary_intel, competition: intel.competition, company_intel: intel.company_intel, timeline: intel.timeline });
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

    function resetGenerated() {
        state.tailored = null; state.chat = [];
        $('tailoredWrap').hidden = true;
        $('linkedinList').innerHTML = '';
        $('emailWrap').hidden = true;
        $('chat').innerHTML = '';
        $('recruiterQuestion').value = '';
    }

    function listItems(container, lines, kind) {
        container.innerHTML = lines.length ? lines.map(line => {
            const [head, ...rest] = line.split(/\s*(?:→|->|=>)\s*/);
            return `<div class="list-item"><svg class="icon lead ${kind}" aria-hidden="true"><use href="#i-${kind === 'ok' ? 'check' : 'alert'}"/></svg><div><div class="headline-text">${escapeHtml(head)}</div>${rest.length ? `<div class="support-text">${escapeHtml(rest.join(' '))}</div>` : ''}</div></div>`;
        }).join('') : `<div class="list-item"><div class="support-text">${kind === 'ok' ? 'No clear strengths were identified.' : 'No significant gaps were identified.'}</div></div>`;
    }

    function renderResults(data, previousScore) {
        $('results').hidden = false;
        collapseInputs();
        showPanel('overview');

        // Hero
        const score = Math.max(0, Math.min(100, Math.round(Number(data.score) || 0)));
        const ring = $('scoreRing');
        ring.className = 'score-ring ' + scoreBand(score);
        ring.setAttribute('aria-label', `Fit score ${score} out of 100`);
        $('scoreNum').textContent = score;
        $('scoreArc').style.strokeDashoffset = 326.7;
        requestAnimationFrame(() => requestAnimationFrame(() => { $('scoreArc').style.strokeDashoffset = (326.7 * (1 - score / 100)).toFixed(1); }));
        $('verdict').textContent = data.verdict || '';
        const company = knownCompany(data.company);
        $('roleLine').textContent = (data.job_title || 'Role') + (company ? ' at ' + company : '');
        $('jobSummary').textContent = data.job_summary || '';
        const delta = $('scoreDelta');
        if (typeof previousScore === 'number') {
            const d = score - previousScore;
            delta.hidden = false;
            delta.className = 'chip sm ' + (d > 0 ? 'ok' : d < 0 ? 'bad' : 'tonal');
            delta.textContent = d === 0 ? 'No change from last run' : `${d > 0 ? '+' : ''}${d} from last run`;
        } else delta.hidden = true;
        const saveLabel = $('saveToTrackerBtn').querySelector('span');
        saveLabel.textContent = 'Save to tracker';
        $('saveToTrackerBtn').disabled = false;

        // Overview
        const { gaps, matches } = splitAnalysis(data);
        renderClearance(data);
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

        setTimeout(() => $('inputSummary').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }

    function renderClearance(data) {
        const el = $('clearanceGate');
        const c = data.clearance;
        if (!c || !c.required || !c.status) { el.hidden = true; return; }
        const status = ['meets', 'gap', 'not_required', 'unclear'].includes(c.status) ? c.status : 'unclear';
        const kind = { meets: 'success', gap: 'error', not_required: 'info', unclear: 'warn' }[status];
        const label = { meets: 'Meets the clearance requirement', gap: 'Clearance gap', not_required: 'No clearance required', unclear: 'Clearance unclear: confirm with the recruiter' }[status];
        el.hidden = false;
        el.className = 'banner ' + kind;
        el.innerHTML = `${icon({ success: 'check', error: 'x-circle', info: 'info', warn: 'alert' }[kind])}<span class="grow"><strong>${label}</strong><br>Role requires: ${escapeHtml(c.required)} &middot; Your resume shows: ${escapeHtml(c.candidate || 'Not stated')}${c.note ? `<br>${escapeHtml(c.note)}` : ''}</span>`;
    }

    function renderFitSignals(data) {
        const rows = Array.isArray(data.fit_signals) ? data.fit_signals.filter(s => s && s.signal) : [];
        $('fitSignalsBlock').hidden = !rows.length;
        const chip = { strong: ['ok', 'Strong'], partial: ['warn', 'Partial'], missing: ['bad', 'Missing'] };
        $('fitSignalsBody').innerHTML = rows.map(s => {
            const [cls, text] = chip[s.status] || chip.partial;
            return `<tr><th scope="row">${escapeHtml(s.signal)}</th><td>${escapeHtml(s.role_expects || 'Not stated')}</td><td>${escapeHtml(s.resume_shows || 'Not shown')}</td><td><span class="chip sm ${cls}">${text}</span></td></tr>`;
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
            const variable = !!sal.is_variable_comp;
            const mid = Number(sal.mid) || (sal.low + sal.high) / 2;
            $('compLabel').textContent = variable ? 'ON-TARGET EARNINGS (EST.)' : 'ESTIMATED PAY';
            $('salaryEstimateLabel').textContent = variable ? 'Est. OTE' : 'Est. pay';
            $('salaryRange').textContent = `${k(sal.low)} to ${k(sal.high)}`;
            $('salaryEstimate').textContent = k(mid);
            const hasBase = variable && Number(sal.base_low) > 0 && Number(sal.base_high) >= Number(sal.base_low);
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
            $('compLabel').textContent = 'ESTIMATED PAY';
            $('salaryRange').textContent = 'Loading...';
            $('salaryEstimate').textContent = '...';
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
        if (!state.analysis) return;
        await withBusy(button, 'Writing your resume...', async () => {
            const data = await api({ request_type: 'tailor_resume', job_description: state.jd, resume_text: state.resumeText, analysis_data: slimAnalysis(), military_transition: isMilitary() });
            state.tailored = data.resume;
            renderTailored(data.resume);
            track('tailored_resume_built');
        });
    }

    // Send only what the backend prompts use, not the whole result object.
    function slimAnalysis() {
        const a = state.analysis || {};
        return { score: a.score, job_title: a.job_title, company: a.company, analysis: a.analysis, clearance: a.clearance, salary_intel: a.salary_intel, competition: a.competition, company_intel: a.company_intel };
    }

    const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];

    function renderTailored(r) {
        const section = (title, html) => html ? `<h4>${title}</h4>${html}` : '';
        const lines = (list) => arr(list).map(x => `<p>${escapeHtml(x)}</p>`).join('');
        const jobs = (Array.isArray(r.experience) ? r.experience : []).map(j => `<div class="job"><b>${escapeHtml(j.title || '')}</b>${j.company ? ', ' + escapeHtml(j.company) : ''}${j.location ? ' &middot; ' + escapeHtml(j.location) : ''}${j.dates ? ' &middot; ' + escapeHtml(j.dates) : ''}<ul>${arr(j.bullets).map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul></div>`).join('');
        $('tailoredPreview').innerHTML = `<h3>${escapeHtml(r.name || '')}</h3>
            ${r.headline ? `<p><b>${escapeHtml(r.headline)}</b></p>` : ''}${r.contact ? `<p class="muted">${escapeHtml(r.contact)}</p>` : ''}
            ${r.clearance ? `<p><b>Clearance:</b> ${escapeHtml(r.clearance)}</p>` : ''}
            ${section('Summary', r.summary ? `<p>${escapeHtml(r.summary)}</p>` : '')}
            ${section('Core skills', arr(r.skills).length ? `<p>${arr(r.skills).map(escapeHtml).join(' &middot; ')}</p>` : '')}
            ${section('Experience', jobs)}${section('Education', lines(r.education))}${section('Certifications', lines(r.certifications))}${section('Additional', lines(r.additional))}`;
        const changes = arr(r.changes);
        $('tailorChanges').hidden = !changes.length;
        $('tailorChanges').innerHTML = `${icon('info')}<span class="grow"><strong>What changed</strong><br>${changes.map(escapeHtml).join('<br>')}</span>`;
        $('tailoredWrap').hidden = false;
        $('tailoredWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
        $('resumeSelector').value = '';
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
            const data = await api({ request_type: 'generate_linkedin_messages', job_description: state.jd, resume_text: state.resumeText, analysis_data: slimAnalysis() });
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
            const data = await api({ request_type: 'generate_intro_email', job_description: state.jd, resume_text: state.resumeText, analysis_data: slimAnalysis() });
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
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return el;
    }

    async function askRecruiter(preset) {
        const input = $('recruiterQuestion');
        const question = (preset || input.value).trim();
        if (!question) return snackbar('Type a question first.');
        if (!state.analysis) return snackbar('Analyze a job first.');
        if (!state.resumeText) state.resumeText = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        if (!state.resumeText) return snackbar('Add your resume on the Analyze tab first.');
        addMessage('user', question);
        state.chat.push({ role: 'user', content: question });
        input.value = '';
        const thinking = addMessage('thinking assistant', 'Thinking...');
        const btn = $('askBtn');
        btn.disabled = true;
        try {
            const data = await api({ request_type: 'ask_expert', question, job_description: state.jd, resume_text: state.resumeText, analysis_data: slimAnalysis(), chat_history: state.chat.slice(-10) });
            thinking.remove();
            addMessage('assistant', data.response || '');
            state.chat.push({ role: 'assistant', content: data.response || '' });
        } catch (e) {
            thinking.remove();
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
        $('printHeader').textContent = `DIB Jobs job fit report · ${a.job_title || 'Role'}${company ? ' at ' + company : ''} · ${new Date().toLocaleDateString()} · dibjobs.com`;
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

    function saveToTracker() {
        const a = state.analysis;
        if (!a) return;
        const company = knownCompany(a.company) || 'Unknown company', role = a.job_title || 'Unknown role';
        const existing = state.tracked.find(j => j.company === company && j.role === role);
        const link = /^https?:\/\/\S+$/i.test(state.jdSourceUrl || '') ? state.jdSourceUrl : '';
        if (existing) {
            Object.assign(existing, { score: a.score, analysis: a, jd: state.jd.substring(0, MAX_JD_CHARS) });
        } else {
            state.tracked.unshift({ id: Date.now(), company, role, score: a.score || 0, status: 'saved', date: new Date().toLocaleDateString(), jd: state.jd.substring(0, MAX_JD_CHARS), analysis: a, url: link, notes: '', nextAction: '', nextDate: '' });
        }
        if (!persistTracker()) {
            if (!existing) state.tracked.shift();
            return snackbar('Could not save. Browser storage is full: remove an old job from the tracker and try again.', 7000);
        }
        $('saveToTrackerBtn').querySelector('span').textContent = existing ? 'Updated in tracker' : 'Saved to tracker';
        $('saveToTrackerBtn').disabled = true;
        updateTrackerBadge();
        snackbar(existing ? 'Tracker entry updated with this analysis.' : 'Saved. Open the Tracker tab to set a follow-up date.');
        track('job_saved');
    }

    function updateTrackerBadge() {
        const badge = $('trackerBadge');
        const overdue = state.tracked.filter(isOverdue).length;
        badge.hidden = state.tracked.length === 0;
        badge.textContent = overdue || state.tracked.length;
        badge.classList.toggle('neutral', !overdue);
        badge.title = overdue ? `${overdue} follow-up${overdue > 1 ? 's' : ''} overdue` : `${state.tracked.length} saved`;
    }

    function renderTracker() {
        const jobs = state.tracked;
        const overdue = jobs.filter(isOverdue).length;
        $('trackerEmpty').hidden = jobs.length > 0;
        $('exportCsvBtn').hidden = jobs.length === 0;
        $('trackerCount').textContent = jobs.length ? `${jobs.length} job${jobs.length !== 1 ? 's' : ''} saved in this browser${overdue ? ` · ${overdue} follow-up${overdue > 1 ? 's' : ''} overdue` : ''}` : 'Saved in this browser only.';
        [...state.compareIds].forEach(id => { if (!findJob(id)) state.compareIds.delete(id); });
        $('trackerList').innerHTML = jobs.map(j => {
            const od = isOverdue(j);
            const sub = [j.company, j.nextDate ? `${od ? 'Overdue: ' : 'Next: '}${j.nextAction || 'follow up'} (${j.nextDate})` : `saved ${j.date || ''}`].filter(Boolean).join(' · ');
            return `<div class="job-card${od ? ' overdue' : ''}" data-id="${j.id}">
                <div class="job-row">
                    <input type="checkbox" class="checkbox" data-compare aria-label="Select ${escapeHtml(j.role)} to compare"${state.compareIds.has(String(j.id)) ? ' checked' : ''}>
                    <div style="min-width:0"><div class="job-title">${escapeHtml(j.role)}</div><div class="job-sub"${od ? ' style="color:var(--error)"' : ''}>${escapeHtml(sub)}</div></div>
                    <span class="score-pill ${scoreBand(j.score)}" title="Fit score">${Math.round(j.score) || 0}</span>
                    <button class="icon-btn" data-toggle-details aria-expanded="false" aria-label="Details for ${escapeHtml(j.role)}">${icon('chevron')}</button>
                    <div class="status-cell"><select class="select sm" data-field="status" aria-label="Status">${STATUSES.map(([v, l]) => `<option value="${v}"${j.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
                </div>
                <div class="details stack" hidden>
                    <div class="details-grid">
                        <label class="field sm"><span class="field-label">Next step</span><input type="text" data-field="nextAction" maxlength="120" placeholder="e.g. Follow up with recruiter" value="${escapeHtml(j.nextAction || '')}"></label>
                        <label class="field sm"><span class="field-label">Due</span><input type="date" data-field="nextDate" value="${escapeHtml(j.nextDate || '')}"></label>
                    </div>
                    <label class="field sm"><span class="field-label">Link to posting</span><input type="url" data-field="url" maxlength="500" placeholder="https://" value="${escapeHtml(j.url || '')}"></label>
                    <label class="field sm"><span class="field-label">Notes</span><textarea data-field="notes" maxlength="2000" placeholder="Who you talked to, what they said, referral names">${escapeHtml(j.notes || '')}</textarea></label>
                    <div class="row end">
                        ${/^https?:\/\//i.test(j.url || '') ? `<a class="btn text" href="${escapeHtml(j.url)}" target="_blank" rel="noopener">${icon('open')}Open posting</a>` : ''}
                        <button class="btn text danger" data-remove>Remove</button>
                        <button class="btn tonal" data-open>Open analysis</button>
                    </div>
                </div>
            </div>`;
        }).join('');
        updateCompareButton();
        renderInsights();
        updateTrackerBadge();
        if ($('compareSection').hidden === false) renderCompare();
    }

    function updateCompareButton() {
        const n = state.compareIds.size;
        $('compareBtn').disabled = n < 2 || n > 3;
        $('compareBtn').querySelector('span').textContent = n > 3 ? 'Compare (pick up to 3)' : n ? `Compare (${n})` : 'Compare';
    }

    function initTrackerEvents() {
        const list = $('trackerList');
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
        if (!job.analysis) return snackbar('This entry has no saved analysis.');
        $('jobDescription').value = job.jd || '';
        state.jd = job.jd || '';
        state.resumeText = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        state.analysis = job.analysis;
        resetGenerated();
        updateCounts();
        showView('analyze');
        renderResults(job.analysis);
    }

    const topLine = (analysis, kind) => { const s = splitAnalysis(analysis || {}); const l = (kind === 'gap' ? s.gaps : s.matches)[0]; return l ? l.split(/\s*(?:→|->)\s*/)[0] : 'n/a'; };

    function renderCompare() {
        const jobs = [...state.compareIds].map(findJob).filter(Boolean).slice(0, 3);
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
        state.tracked.forEach(j => { const a = j.analysis || {}; rows.push([j.company, j.role, j.score, j.status, j.date, j.nextAction, j.nextDate, j.url, j.notes, a.verdict, a.salary_intel?.low, a.salary_intel?.high, a.clearance?.required]); });
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
            const jobs = data.tracker.filter(j => j && typeof j === 'object' && j.role).map(j => Object.assign({}, j, { id: Number(j.id) || Date.now() + Math.random(), score: Number(j.score) || 0, status: STATUSES.some(s => s[0] === j.status) ? j.status : 'saved' }));
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
    // FIND ROLES
    // ======================================================================
    const COMPANY_BOARDS = [
        ['Defense primes and integrators', [['Lockheed Martin', 'lockheed-martin'], ['RTX (Raytheon)', 'rtx'], ['GDIT', 'gdit'], ['Northrop Grumman', 'northrop-grumman-corporation'], ['Boeing', 'boeing'], ['Leidos', 'leidos'], ['BAE Systems', 'bae-systems'], ['L3Harris', 'l3harris-technologies'], ['Booz Allen', 'booz-allen-hamilton'], ['SAIC', 'saicinc'], ['CACI', 'caci-international-inc'], ['ManTech', 'mantech'], ['Peraton', 'peraton'], ['Anduril', 'anduril'], ['Palantir', 'palantir-technologies'], ['Shield AI', 'shield-ai']]],
        ['Cloud service providers', [['Amazon / AWS', 'amazon-web-services'], ['Microsoft / Azure', 'microsoft'], ['Google Cloud', 'google-cloud'], ['Oracle Cloud', 'oracle'], ['IBM Cloud', 'ibm']]],
        ['SaaS and platforms', [['Salesforce', 'salesforce'], ['ServiceNow', 'servicenow'], ['Snowflake', 'snowflake-computing'], ['Databricks', 'databricks'], ['Atlassian', 'atlassian'], ['Palo Alto Networks', 'palo-alto-networks'], ['CrowdStrike', 'crowdstrike'], ['Zscaler', 'zscaler'], ['Tenable', 'tenableinc'], ['Okta', 'okta-inc-'], ['Splunk', 'splunk']]],
        ['Consulting and systems integrators', [['Accenture Federal', 'accenturefederalservices'], ['Deloitte', 'deloitte'], ['PwC', 'pwc'], ['EY', 'ernstandyoung'], ['KPMG', 'kpmg-us'], ['Capgemini', 'capgemini']]],
        ['VARs and resellers', [['Carahsoft', 'carahsoft'], ['WWT', 'world-wide-technology'], ['Iron Bow', 'iron-bow-technologies'], ['Presidio', 'presidio-'], ['DXC Technology', 'dxctechnology'], ['CGI Federal', 'cgi'], ['Red River', 'red-river-technology'], ['ThunderCat', 'thundercat-technology']]]
    ];

    const searchLinks = (query) => {
        const q = encodeURIComponent(query);
        const link = (href, label) => `<a class="chip sm" href="${href}" target="_blank" rel="noopener">${label}</a>`;
        return link(`https://www.linkedin.com/jobs/search/?keywords=${q}&f_TPR=r604800`, 'LinkedIn, past week')
            + link(`https://www.clearancejobs.com/jobs?keywords=${q}`, 'ClearanceJobs')
            + link(`https://www.indeed.com/jobs?q=${q}`, 'Indeed');
    };

    function renderCompanyBoards() {
        $('companyBoards').innerHTML = COMPANY_BOARDS.map(([title, companies]) => `<p class="label-lg muted" style="margin:20px 0 8px">${title}</p><div class="chips">${
            companies.map(([name, slug]) => `<a class="chip" href="https://www.linkedin.com/company/${slug}/jobs/" target="_blank" rel="noopener">${name}</a>`).join('')}</div>`).join('')
            + `<p class="label-lg muted" style="margin:20px 0 8px">Job boards</p><div class="chips"><a class="chip" href="https://www.clearancejobs.com/jobs" target="_blank" rel="noopener">ClearanceJobs</a><a class="chip" href="https://www.linkedin.com/jobs/search/?keywords=federal%20sales&f_TPR=r604800" target="_blank" rel="noopener">LinkedIn: federal sales, past week</a><a class="chip" href="https://www.indeed.com/jobs?q=federal+sales" target="_blank" rel="noopener">Indeed: federal sales</a></div>`;
    }

    async function suggestRoles(button) {
        const resume = $('resumeText').value.trim().substring(0, MAX_RESUME_CHARS);
        if (resume.length < 100) { showView('analyze'); showInputs(); return snackbar('Add your resume first, then come back to Find roles.'); }
        await withBusy(button, 'Reading your resume...', async () => {
            const data = await api({ request_type: 'suggest_roles', resume_text: resume, military_transition: isMilitary() });
            const fit = { core: ['ok', 'Strong fit'], stretch: ['warn', 'Stretch'], adjacent: ['tonal', 'Adjacent move'] };
            if (data.headline) $('rolesHeadline').textContent = data.headline;
            $('rolesList').innerHTML = `<div class="list">${data.roles.filter(r => r && r.title).map(r => {
                const [cls, label] = fit[r.fit] || fit.core;
                return `<div class="list-item"><div class="grow"><div class="row"><span class="headline-text">${escapeHtml(r.title)}</span><span class="chip sm ${cls}">${label}</span></div>
                    <div class="support-text">${escapeHtml(r.why || '')}${r.employer_types ? ` Look at: ${escapeHtml(r.employer_types)}.` : ''}</div>
                    <div class="chips" style="margin-top:8px">${searchLinks(r.search_query || r.title)}</div></div></div>`;
            }).join('')}</div>`;
            track('roles_suggested');
        });
    }

    // ======================================================================
    // SAMPLE DATA
    // ======================================================================
    function loadSampleData() {
        $('resumeText').value = `JOHN DOE
Arlington, VA | johndoe@email.com | (703) 555-1234

CLEARANCE: Top Secret

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
        $('jobDescription').value = `Principal DoD Sales Representative
Amazon Web Services (AWS) - Arlington, VA

About the Role:
AWS is seeking an experienced Principal DoD Sales Representative to drive adoption of cloud services across Department of Defense customers. You will be responsible for developing and executing sales strategies for a portfolio of DoD accounts, working closely with solutions architects, partners, and AWS leadership to accelerate cloud adoption.

Basic Qualifications:
- 10+ years of enterprise sales experience, with 7+ years selling to DoD customers
- Active Top Secret/SCI clearance with Full Scope Polygraph
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
        $('resumeSelector').value = '';
        state.fileFlags = null; state.fileName = '';
        setFileStatus('info', '<span class="grow">Sample resume and job loaded. Your own saved resume is untouched and comes back when you reload.</span>');
        updateCounts();          // the sample is intentionally not remembered
        renderResumeCheck();
        showInlineError('');
        snackbar('Sample loaded. Choose "Analyze job fit" to see it work.');
    }

    function newJob() {
        $('jobDescription').value = '';
        $('results').hidden = true;
        state.analysis = null; state.jd = '';
        resetGenerated();
        showInputs(); showInlineError(''); updateCounts();
        $('jobDescription').focus();
    }

    // ======================================================================
    // INIT + EVENT WIRING
    // ======================================================================
    const ACTIONS = {
        'analyze': () => analyzeJob(),
        'sample': () => loadSampleData(),
        'save-resume': () => saveCurrentResume(),
        'clear-resume': () => clearResume(),
        'ocr': () => readResumeWithAI(),
        'edit-inputs': () => { showInputs(); $('inputs').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
        'new-job': () => newJob(),
        'save-job': () => saveToTracker(),
        'download-report': () => downloadReport(),
        'share': () => shareTool(),
        'copy-link': () => { copyText(SHARE_URL, 'Link copied. Paste it anywhere.'); track('share', { method: 'copy_link' }); },
        'tailor': (b) => buildTailoredResume(b),
        'download-docx': () => downloadTailoredDocx(),
        'copy-tailored': () => state.tailored && copyText(tailoredToText(state.tailored), 'Resume text copied.'),
        'use-tailored': () => useTailoredAsResume(),
        'copy-missing-keywords': () => { const k = ((state.analysis || {}).keywords || []).filter(x => x && !x.in_resume).map(x => x.term); k.length ? copyText(k.join(', '), 'Missing keywords copied.') : snackbar('Nothing missing: every keyword is in your resume.'); },
        'linkedin': (b) => writeLinkedInNotes(b),
        'email': (b) => writeIntroEmail(b),
        'ask': () => askRecruiter(),
        'clear-chat': () => { state.chat = []; $('chat').innerHTML = ''; },
        'compare': () => { renderCompare(); $('compareSection').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
        'close-compare': () => { $('compareSection').hidden = true; },
        'export-csv': () => exportTrackerCSV(),
        'backup': () => backupData(),
        'restore': () => $('restoreFile').click(),
        'suggest-roles': (b) => suggestRoles(b),
        'dismiss-snackbar': () => $('snackbar').classList.remove('show')
    };

    function init() {
        state.tracked = (store.get(KEYS.tracker, []) || []).filter(j => j && typeof j === 'object');
        $('militaryToggle').checked = store.getRaw(KEYS.military) === '1';
        loadInitialResume();
        initTabs();
        initFileDrop();
        initTrackerEvents();
        renderCompanyBoards();
        updateCounts();
        renderResumeCheck();
        updateTrackerBadge();

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
        });
        $('resumeText').addEventListener('input', onResumeChanged);
        $('jobDescription').addEventListener('input', updateCounts);
        $('resumeSelector').addEventListener('change', onResumeSelect);
        $('militaryToggle').addEventListener('change', (e) => store.set(KEYS.military, e.target.checked ? '1' : '0'));
        $('restoreFile').addEventListener('change', (e) => restoreData(e.target.files[0]));
        // Ctrl/Cmd + Enter: analyze from either input, send from the chat box
        ['resumeText', 'jobDescription', 'recruiterQuestion'].forEach(id => $(id).addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            if (id === 'recruiterQuestion') askRecruiter();
            else if (!$('analyzeBtn').disabled) analyzeJob();
        }));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
