# DIB Jobs

Static site (plain HTML, CSS and JavaScript) plus one AWS Lambda that calls Google Gemini.

## What goes where

| Path | What it is |
| --- | --- |
| `index.html`, `assets/` | The main app: Check a job, Find Jobs, Tracker |
| `screen/` | Recruiter page. Uses the same Lambda (`recruiter_screen` request) |
| `onepage/` | One-page resume tool (standalone) |
| `vendor/` | pdf.js and mammoth, used to read resume files in the browser |
| `favicon.*`, `apple-touch-icon.png`, `icon-*.png`, `site.webmanifest` | Icons |
| `og-fit-83-2x.png` | 2400x1260 share image. Give it a new filename whenever it changes, because LinkedIn caches by address (`og-fit-83.png`, `og-image.png` and `dibjobs.png` are copies kept for old links) |
| `robots.txt`, `sitemap.xml` | Search engine files |
| `lambda.js` | Backend source. Deploy it to Lambda as `index.mjs`. It does not need to be on the web server. |

## Deploying the site

Upload everything except `lambda.js` and this README to the web root. When `assets/app.js`, `assets/app.css` or `assets/files.js` change, bump the `?v=` number on their references in `index.html` and `screen/index.html`.

## Deploying the Lambda

- Runtime Node.js 20 or newer, handler `index.handler`, timeout 60 s, memory 256 MB.
- Function URL with CORS configured for `https://dibjobs.com`. Leave `SEND_CORS_HEADERS` unset (or `false`) so headers are not sent twice.
- Environment: `GEMINI_API_KEY` (required), `GEMINI_MODEL` (default `gemini-3.5-flash-lite`), optional `ALLOWED_ORIGINS`, `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_HOUR`, `GEMINI_TIMEOUT_MS`.
- Health check: open the Function URL in a browser. It returns `{ ok, service, version, model, ready }`.

## Privacy

Resume files are parsed in the browser. Text is sent to the Lambda only when the user runs a check. The Lambda does not log or store resumes, job descriptions or questions. Saved resumes and the tracker live in the browser's localStorage. Find Jobs only builds links to LinkedIn, ClearanceJobs, Indeed and Google.
