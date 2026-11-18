/* ==========================================================================
   DIB Jobs - file reading (PDF, Word .docx, text), shared by the job-seeker
   page and the recruiter page. Everything here runs in the browser; files are
   never uploaded. Exposes window.DIBFiles.
   ========================================================================== */
(() => {
    'use strict';
    // Resolve the vendor folder from this script's own URL so the module works from any page depth.
    const ROOT = new URL('../', document.currentScript.src).href;
    const VENDOR = {
        pdf: ROOT + 'vendor/pdf.min.js',
        pdfWorker: ROOT + 'vendor/pdf.worker.min.js',
        mammoth: ROOT + 'vendor/mammoth.browser.min.js'
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


    window.DIBFiles = { readDocumentFile, normalizeExtractedText, countWords, MAX_FILE_BYTES, MAX_OCR_BYTES, MAX_RESUME_CHARS, MAX_JD_CHARS };
})();
