# RFI & Capture Analyzer (Adapted from DIB Jobs)

Welcome! If you are looking at the `index.html` file and wondering how it actually analyzes text, it's because the heavy lifting is completely decoupled from the frontend. 

This document explains how the current architecture works under the hood and provides the exact code snippets you need to transform this from a **Resume/Job Description Matcher** into a **Company Capabilities/RFI Analyzer**.

## 🏗️ System Architecture 


The application relies on a serverless, three-tier architecture:

1. **Frontend (Client-side):** A vanilla HTML/CSS/JS single-page application (`index.html`).
2. **Backend (Middleware):** An AWS Lambda function (`lambda.js`) exposed via AWS API Gateway.
3. **AI Engine:** Google's Gemini 2.0 Flash API hosted on Google Cloud.

### How a Request Flows
1. The user pastes text into the frontend and clicks "Analyze".
2. The frontend sends a `POST` request to the API Gateway endpoint (`API_ENDPOINT` in `index.html`).
3. API Gateway triggers the AWS Lambda function (`lambda.js`).
4. The Lambda function acts as a controller: it checks for rate limiting, scrapes URLs if provided using Jina.ai, injects the text into a highly specific **System Prompt**, and sends that payload to the **Google Gemini API**.
5. Gemini processes the text and returns a structured JSON response.
6. Lambda forwards that JSON back to the frontend, which parses it and populates the UI cards.

---

## 🛠️ Phase 1: The Backend (The "Brain" Transplant)

To switch the AI's brain from "Recruiter" to "Capture Manager," you need to swap out the prompt strings in the `lambda.js` file. 

**Important Note on JSON:** To make your deployment easier, these updated prompts keep the original JSON keys (like `interview_questions` and `salary_intel`) the exact same as the original code. This means you won't have to rewrite the complex parsing logic in the frontend—you just need to change the UI labels in Phase 2 so they make sense for RFIs!

### Replacement 1: The Core Matcher
Find the `prompt` variable inside the `generateResumeMatch` function in `lambda.js`. Replace it entirely with this:

\`\`\`javascript
const prompt = \`You are an expert Federal Capture Manager and Proposal Strategist. Your job is to analyze a government Request for Information (RFI) or Solicitation against a company's capability matrix and past performance.

COMPANY CAPABILITIES / PAST PERFORMANCE:
\${resumeText}

RFI / SOLICITATION TO ANALYZE:
\${jobDescription}

YOUR TASKS:

1. **Assess Probability of Win (PWin) Score (0-100):**
   SCORING RUBRIC:
   90-100: Company meets 90%+ of requirements with stellar past performance.
   75-89: Company meets core requirements, minor teaming needed.
   60-74: Company is missing key certifications or past performance; heavy teaming required.
   Below 60: Major compliance risks or complete misalignment. (No Bid recommendation).

2. **Identify Top 5 Capability Matches:**
   List the company's strongest alignments with the RFI requirements, citing specific past performance evidence.

3. **Identify Top 3 Compliance Gaps & Risks:**
   List the most critical gaps in priority order (e.g., missing facility clearance, lack of ISO/CMMI certs, missing technical capabilities).

4. **Draft a Win Theme / Executive Summary:**
   Write a 1-paragraph executive summary framing the company as the ideal prime contractor or highly valuable subcontractor for this specific bid. 

5. **Extract Solicitation Metadata:**
   Identify: Solicitation Number, Agency/Department, and a 1-sentence project summary.

6. **Generate 5 Questions for the Contracting Officer (CO):**
   Draft strategic clarification questions to submit during the Q&A period that highlight the company's strengths or expose competitor weaknesses.

7. **Determine Teaming Strategy:**
   For each identified gap, suggest the type of teaming partner needed to make the bid compliant.

8. **Compliance Checklist:**
   Extract 10-15 critical requirements/keywords from the RFI. Indicate if the company currently meets them (true/false) and their importance.

OUTPUT VALID JSON ONLY (no markdown, no backticks):
{
    "job_title": "string (Solicitation Number)",
    "company": "string (Agency/Department)",
    "job_summary": "string (1 sentence)",
    "score": number (0-100),
    "verdict": "string (e.g., 'Strong Prime Bid', 'Teaming Required', 'No Bid')",
    "analysis": [
        "Match: [capability] → [evidence]",
        "Gap: [missing requirement] → [risk level]"
    ],
    "tailored_summary": "string (the drafted executive summary)",
    "interview_questions": [
        {
            "question": "string (Question for the CO)",
            "suggested_answer": "string (Strategic reason for asking this)"
        }
    ],
    "gap_strategies": [
        {
            "gap": "string",
            "strategy": "string (Teaming or mitigation strategy)",
            "talking_points": "string"
        }
    ],
    "keywords": [
        {
            "term": "string (compliance requirement)",
            "in_resume": boolean,
            "importance": "critical or nice-to-have"
        }
    ]
}\`;
\`\`\`

### Replacement 2: Agency & Competitor Intel
Find the `prompt` inside the `generateMarketIntel` function in `lambda.js`. Replace it to analyze the agency and competitive landscape:

\`\`\`javascript
const prompt = \`You are a federal market intelligence analyst providing insights on a government solicitation.

SOLICITATION DETAILS:
- Solicitation Number: \${jobTitle || 'Not specified'}
- Agency: \${company || 'Not specified'}

FULL RFI/SOLICITATION:
\${jobDescription}

PROVIDE THE FOLLOWING INTELLIGENCE:

1. **Budget/Value Intelligence:**
   - Estimate the realistic contract value (in thousands) based on the scope of work.
   - Provide low/mid/high in thousands (e.g., 15000 for $15M).

2. **Competitive Landscape:**
   - "Low" = Highly restricted set-aside or niche requirements.
   - "Moderate" = Standard competition, requires strong past performance.
   - "High" = Multiple award IDIQ/GWAC or highly commoditized services.
   - Provide brief reasoning on likely incumbent advantage or competitor types.

3. **Agency Intelligence:**
   - Agency buying habits, typical procurement vehicles used, and reputation for innovation vs. risk aversion.

4. **Procurement Timeline:**
   - Estimate the timeline from RFI to final award.

OUTPUT VALID JSON ONLY:
{
    "salary_intel": {
        "low": number,
        "mid": number,
        "high": number,
        "notes": "string (Budget reasoning)"
    },
    "competition": {
        "level": "Low" | "Moderate" | "High",
        "reasoning": "string"
    },
    "company_intel": {
        "known": boolean,
        "type": "string (Agency type)",
        "size": "string",
        "reputation": "string (Agency buying habits)",
        "recent_news": "string",
        "culture_notes": "string"
    },
    "timeline": {
        "screen_weeks": "string (RFP Release Est.)",
        "interview_weeks": "string (Proposal Due Est.)",
        "offer_weeks": "string (Award Est.)",
        "notes": "string"
    }
}\`;
\`\`\`

### Replacement 3: "Ask the Expert"
Change the persona in the `askExpert` function in `lambda.js` from a Recruiter to a Capture Manager:

\`\`\`javascript
const prompt = \`You are a Senior Federal Capture Manager and BD Executive with 25+ years of experience winning complex government contracts.

YOUR APPROACH:
- Direct, strategic, and focused on PWin (Probability of Win).
- Deep expertise in the FAR, teaming agreements, pricing strategies, and proposal writing.
- Give tactical, actionable advice on whether to bid, how to team, and how to price.

COMPANY CAPABILITIES:
\${resumeText}

SOLICITATION BEING DISCUSSED:
\${jobDescription}

ANALYSIS RESULTS:
- PWin Score: \${analysisData.score}%
- Agency: \${analysisData.company}
- Key Strengths: \${analysisData.analysis.filter(a => a.startsWith('Match:')).slice(0, 3).join('; ')}
- Key Risks: \${analysisData.analysis.filter(a => a.startsWith('Gap:')).join('; ')}

USER'S QUESTION:
\${question}

RESPOND AS THE EXPERT:
- Be specific to the company's capabilities and the solicitation's constraints.
- If asked about teaming, suggest specific types of partners (e.g., 8(a), SDVOSB, or a large prime).
- Keep responses concise but highly strategic (2-4 paragraphs).

YOUR RESPONSE:\`;
\`\`\`

---

## 🎨 Phase 2: The Frontend (The "Face" Lift)

Now that the AI is spitting out RFI data, you need to update `index.html` so the UI reflects the new terminology.

### Configuration Changes (Top of the script block)
1. **API Endpoint:** Around line 640, update `API_ENDPOINT` to point to your new AWS API Gateway URL once you deploy your modified Lambda function.
2. **Local Storage:** Around line 643, change `RESUME_STORAGE_KEY` from `'dib_jobs_resumes'` to `'rfi_company_profiles'`.

### UI Text Changes (HTML Body)
Search the HTML for these text strings and replace them to fit the capture context:

* **Inputs:**
  * Find `<span class="card-title">Paste Resume</span>` ➔ Change to "Paste Capabilities Matrix"
  * Find `<span class="card-title">Paste Job Description</span>` ➔ Change to "Paste RFI/Solicitation"
* **Hero Score:**
  * Find `<div class="score-label">Job Fit Score</div>` ➔ Change to "Estimated PWin Score"
* **Stats Row:**
  * Find `<div class="stat-lbl">Salary Est.</div>` ➔ Change to "Est. Contract Value"
* **Intel Panels:**
  * Find `<div class="panel-title">Salary Estimate</div>` ➔ Change to "Budget Estimate"
  * Find `<div class="panel-sub">Based on role level & market</div>` ➔ Change to "Based on scope and agency history"
* **Kits & Collapsibles:**
  * Find `<span class="card-title">Interview Kit</span>` ➔ Change to "Capture Strategy Kit"
  * Find `<h4 class="kit-section-title">Likely Interview Questions</h4>` ➔ Change to "Strategic Q&A for the CO"
  * Find `<h4 class="kit-section-title">Tailored Executive Summary</h4>` ➔ Change to "Draft Win Theme / Exec Summary"

---

## 🚀 Execution Strategy

1. **Deploy Your Lambda:** Create a new Lambda function in AWS, paste your modified `lambda.js` code, and set your `GEMINI_API_KEY` in the environment variables. Hook it up to an API Gateway (HTTP API is easiest).
2. **Update index.html:** Paste your new API Gateway URL into the `API_ENDPOINT` variable and make your UI text tweaks.
3. **Test:** Paste a real SAM.gov RFI and your company's capabilities to verify the AI outputs capture-focused JSON.