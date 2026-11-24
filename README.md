# DIB Jobs

Static site (plain HTML, CSS and JavaScript) plus one AWS Lambda that calls Google Gemini.

## What goes where

| Path | What it is |
| --- | --- |
| `index.html`, `assets/` | The main app: Tailor a resume, Find Jobs, Tracker |
| `screen/` | Recruiter page. Uses the same Lambda (`recruiter_screen` request) |
| `onepage/` | One-page resume tool (standalone) |
| `vendor/` | pdf.js and mammoth, used to read resume files in the browser |
| `favicon.*`, `apple-touch-icon.png`, `icon-*.png`, `site.webmanifest` | Icons |
| `og-dibjobs-2x.png`, `og-recruiters-2x.png` | 2400x1260 share images: the first for the main site and its About, Privacy and Terms pages, the second for `/screen/`. Give a file a new name whenever its picture changes, because LinkedIn caches by address |
| `robots.txt`, `sitemap.xml` | Search engine files |
| `lambda.js` | Backend source. Deploy it to Lambda as `index.mjs`. It does not need to be on the web server. |

## Deploying the site

Upload everything except `lambda.js` and this README to the web root. When `assets/app.js`, `assets/app.css` or `assets/files.js` change, bump the `?v=` number on their references in all five HTML pages (currently `?v=54`).

## Deploying the Lambda

- Runtime Node.js 20 or newer, handler `index.handler`, timeout 60 s, memory 256 MB.
- Function URL with CORS configured for `https://dibjobs.com`. Leave `SEND_CORS_HEADERS` unset (or `false`) so headers are not sent twice.
- Environment: `GEMINI_API_KEY` (required), `GEMINI_MODEL` (default `gemini-3.5-flash-lite`), optional `ALLOWED_ORIGINS`, `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_HOUR`, `GEMINI_TIMEOUT_MS`.
- Health check: open the Function URL in a browser. It returns `{ ok, service, version, model, ready }`.

## Privacy

Resume files are parsed in the browser. Text is sent to the Lambda only when the user tailors a resume or uses one of the tools around it. The Lambda does not log or store resumes, job descriptions, questions, or the answers a user gives to follow-up questions. Saved resumes, saved answers and the tracker (which keeps each job's tailored resume, source resume and answers) live in the browser's localStorage.

The page asks for the rewrite (`tailor_resume`) at the same moment as the fit analysis (`resume_match`), so every run makes two Gemini calls at once. Lambda 3.10.0 or later accepts a rewrite request with no analysis attached; with an older Lambda the page falls back to asking after the analysis. Find Jobs only builds links to LinkedIn, ClearanceJobs, Indeed and Google.


## About, Privacy and Terms

- `about/`, `privacy/` and `terms/` are plain pages that share `assets/app.css`. Upload the three folders next to `index.html`.
- The About page is written in Mark's name from the QuotaBird About page; edit it freely.
- The Privacy and Terms pages describe what this build actually does. If you change what is sent, stored or counted, update the Privacy page and its date. Have the Terms reviewed by a lawyer before relying on them.
- Contact address used on these pages: mark@quotabird.com (search the three files to change it).
