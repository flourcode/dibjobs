/**
 * DIB Jobs - Defense Industrial Base Job Matcher
 * Powered by Gemini Flash 2.0
 * v1.0 - Generic resume matching tool
 */
// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
    MAX_JD_LENGTH: 15000,
    MAX_RESUME_LENGTH: 20000,
    MIN_JD_LENGTH: 50,
    MIN_RESUME_LENGTH: 100,
    AI_TIMEOUT_MS: 55000,
    JINA_TIMEOUT_MS: 10000,
    AI_TEMPERATURE: 0.4,
    AI_MAX_TOKENS: 2500,
    AI_MAX_TOKENS_INTEL: 1500,
    RATE_LIMIT: {
        WINDOW_MS: 60 * 60 * 1000,
        MAX_REQUESTS_PER_WINDOW: 500,
        MAX_REQUESTS_PER_MINUTE: 30,
        CLEANUP_INTERVAL_MS: 5 * 60 * 1000
    }
};
// =============================================================================
// RATE LIMITING
// =============================================================================
const rateLimitStore = new Map();
let lastCleanup = Date.now();

const cleanupRateLimitStore = () => {
    const now = Date.now();
    if (now - lastCleanup < CONFIG.RATE_LIMIT.CLEANUP_INTERVAL_MS) return;
    lastCleanup = now;
    const windowStart = now - CONFIG.RATE_LIMIT.WINDOW_MS;
    for (const [ip, data] of rateLimitStore.entries()) {
        data.requests = data.requests.filter(timestamp => timestamp > windowStart);
        if (data.requests.length === 0) {
            rateLimitStore.delete(ip);
        }
    }
};

const checkRateLimit = (clientIP) => {
    cleanupRateLimitStore();
    const now = Date.now();
    const windowStart = now - CONFIG.RATE_LIMIT.WINDOW_MS;
    const minuteStart = now - 60 * 1000;
    if (!rateLimitStore.has(clientIP)) {
        rateLimitStore.set(clientIP, { requests: [] });
    }
    const data = rateLimitStore.get(clientIP);
    data.requests = data.requests.filter(timestamp => timestamp > windowStart);
    if (data.requests.length >= CONFIG.RATE_LIMIT.MAX_REQUESTS_PER_WINDOW) {
        const oldestRequest = Math.min(...data.requests);
        const retryAfter = Math.ceil((oldestRequest + CONFIG.RATE_LIMIT.WINDOW_MS - now) / 1000);
        return {
            allowed: false,
            retryAfter,
            reason: `Rate limit exceeded. Please try again in ${Math.ceil(retryAfter / 60)} minutes.`
        };
    }
    const recentRequests = data.requests.filter(timestamp => timestamp > minuteStart);
    if (recentRequests.length >= CONFIG.RATE_LIMIT.MAX_REQUESTS_PER_MINUTE) {
        return {
            allowed: false,
            retryAfter: 60,
            reason: 'Too many requests. Please wait a minute before trying again.'
        };
    }
    data.requests.push(now);
    return { allowed: true };
};

// =============================================================================
// HELPERS
// =============================================================================
const getCorsHeaders = () => ({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
});

const createResponse = (statusCode, body) => ({
    statusCode,
    headers: getCorsHeaders(),
    body: JSON.stringify(body)
});

const sanitizeInput = (text) => {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/```/g, '')
        .replace(/\x00/g, '')
        .trim();
};

const getClientIP = (event) => {
    return event.requestContext?.http?.sourceIp || 
           event.requestContext?.identity?.sourceIp || 
           event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
           'unknown';
};

// =============================================================================
// URL CONTENT FETCHER (using Jina.ai)
// =============================================================================
const fetchUrlContent = async (url) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.JINA_TIMEOUT_MS);
    try {
        const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
        const response = await fetch(jinaUrl, {
            method: 'GET',
            headers: { 'Accept': 'text/plain', 'X-Timeout': '8' },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) return null;
        return await response.text();
    } catch (error) {
        clearTimeout(timeoutId);
        return null;
    }
};

// =============================================================================
// CALL 1: RESUME FIT ANALYSIS
// =============================================================================
const generateResumeMatch = async (jobDescription, resumeText) => {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        throw new Error('AI service configuration missing');
    }
    const prompt = `You are a federal/defense job market expert analyzing a job description against a candidate's resume.

CANDIDATE'S RESUME:
${resumeText}

JOB DESCRIPTION TO ANALYZE:
${jobDescription}

YOUR TASKS:

1. **Federal Terminology Translation:**
   Treat these as equivalent matches:
   - "TS/SCI" = "Top Secret/Sensitive Compartmented Information"
   - "Full Scope Poly" = "Full Scope Polygraph" = "FSP" = "Lifestyle Polygraph"
   - "CI Poly" = "Counterintelligence Polygraph"
   - "IC" = "Intelligence Community"
   - "DoD" = "Department of Defense"
   - "BD" = "Business Development" = "Capture"
   - "IDIQ" = "Indefinite Delivery/Indefinite Quantity"
   - "GWAC" = "Government-Wide Acquisition Contract"

2. **Assess Match Quality (0-100 score):**
   SCORING RUBRIC:
   90-100: Candidate meets 90%+ of requirements including all must-haves
   75-89: Candidate meets 75-89% of requirements, minor gaps only
   60-74: Candidate meets 60-74% of requirements, 1-2 notable gaps
   40-59: Candidate meets under 60% OR missing a critical requirement
   Below 40: Major misalignment (wrong clearance, wrong domain, wrong seniority)
   
   CLEARANCE LOGIC:
   - Higher clearance satisfies lower requirements (TS/SCI covers Secret)
   - Full Scope Poly covers CI Poly requirements
   - Note clearance gaps but don't auto-fail if clearance is obtainable
   
   Be REALISTIC. A 70 is a good score. 85+ should be rare.

3. **Identify Top 5 Matches:**
   List the candidate's strongest alignments with evidence from their resume.

4. **Identify Top 3 Gaps:**
   List the most critical gaps in priority order:
   - Priority 1: Hard gates (clearance, required degrees, mandatory certs)
   - Priority 2: Experience gaps (years, specific domain knowledge)
   - Priority 3: Technical skills (tools, platforms, methodologies)
   - Priority 4: Nice-to-haves

5. **Rewrite Executive Summary:**
   Write a tailored executive summary for the candidate's resume that:
   - Uses third-person resume voice
   - Incorporates keywords from the job description
   - Highlights relevant experience for this specific role

6. **Extract Job Metadata:**
   Identify: Job Title, Company Name (if available), 1-sentence summary

7. **Generate 5 Interview Questions:**
   Create realistic questions the hiring manager would ask based on JD requirements.
   For each, provide a suggested answer using the candidate's actual experience.

8. **Create Gap Mitigation Strategies:**
   For each identified gap, provide:
   - A specific strategy to address it
   - Talking points the candidate can use

9. **Keywords Analysis:**
   Extract 10-15 important keywords from the JD.
   For each, indicate if it appears in the candidate's resume (true/false).
   Mark importance as "critical", "important", or "nice-to-have".

OUTPUT VALID JSON ONLY (no markdown, no backticks):
{
    "job_title": "string",
    "company": "string or 'Not Specified'",
    "job_summary": "string (1 sentence)",
    "score": number (0-100),
    "verdict": "string (e.g., 'Strong Fit', 'Good Match with Gaps', 'Stretch Opportunity')",
    "analysis": [
        "Match: [strength] → [evidence]",
        "Match: [strength] → [evidence]",
        "Match: [strength] → [evidence]",
        "Match: [strength] → [evidence]",
        "Match: [strength] → [evidence]",
        "Gap: [gap] → [risk]",
        "Gap: [gap] → [risk]",
        "Gap: [gap] → [risk]"
    ],
    "tailored_summary": "string (the rewritten executive summary)",
    "interview_questions": [
        {
            "question": "string",
            "suggested_answer": "string (2-3 sentences using candidate's experience)"
        }
    ],
    "gap_strategies": [
        {
            "gap": "string",
            "strategy": "string",
            "talking_points": "string"
        }
    ],
    "keywords": [
        {
            "term": "string",
            "in_resume": boolean,
            "importance": "string"
        }
    ]
}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.AI_TIMEOUT_MS);
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        maxOutputTokens: CONFIG.AI_MAX_TOKENS,
                        temperature: CONFIG.AI_TEMPERATURE
                    }
                }),
                signal: controller.signal
            }
        );
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error('AI service temporarily unavailable');
        }
        const result = await response.json();
        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) {
            throw new Error('AI returned empty response');
        }
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('AI response format error');
        }
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.score !== 'number' || !parsed.tailored_summary) {
            throw new Error('AI response missing required fields');
        }
        return parsed;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('AI request timed out. Please try again.');
        }
        throw error;
    }
};

// =============================================================================
// CALL 2: MARKET INTEL ANALYSIS
// =============================================================================
const generateMarketIntel = async (jobDescription, jobTitle, company) => {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        throw new Error('AI service configuration missing');
    }
    const prompt = `You are a federal hiring market expert providing intelligence on a job opportunity.

JOB DETAILS:
- Title: ${jobTitle || 'Not specified'}
- Company: ${company || 'Not specified'}

FULL JOB DESCRIPTION:
${jobDescription}

PROVIDE THE FOLLOWING MARKET INTELLIGENCE:

1. **Salary Intelligence:**
   - Estimate realistic salary range for this specific role
   - Consider: job title seniority, company type, clearance premium, location
   - Provide low/mid/high in thousands (e.g., 180 for $180K)
   - Federal defense director roles: typically $180K-$280K
   - VP/C-level: typically $250K-$400K+
   - Add 10-20% clearance premium for TS/SCI Poly roles
   - Tech companies pay 20-40% above traditional contractors

2. **Competitive Landscape:**
   - "Low" = Candidate pool is small due to clearance/niche requirements
   - "Moderate" = Competitive but qualified candidates stand out
   - "High" = Many qualified candidates likely
   - Provide brief reasoning

3. **Company Intelligence (if company is known):**
   - Company type (Large Defense Prime, Mid-tier, CSP, Startup, etc.)
   - Approximate size
   - Federal market reputation
   - Recent notable news if known
   - Culture notes if known
   - If company unknown, set known=false

4. **Hiring Timeline:**
   - Estimate realistic timeline for this type of role
   - Federal contractor with existing clearance: 4-8 weeks
   - Commercial tech: 2-4 weeks
   - New clearance needed: 3-12+ months

OUTPUT VALID JSON ONLY:
{
    "salary_intel": {
        "low": number,
        "mid": number,
        "high": number,
        "notes": "string"
    },
    "competition": {
        "level": "Low" | "Moderate" | "High",
        "reasoning": "string"
    },
    "company_intel": {
        "known": boolean,
        "type": "string",
        "size": "string",
        "reputation": "string",
        "recent_news": "string",
        "culture_notes": "string"
    },
    "timeline": {
        "screen_weeks": "string",
        "interview_weeks": "string",
        "offer_weeks": "string",
        "notes": "string"
    }
}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.AI_TIMEOUT_MS);
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        maxOutputTokens: CONFIG.AI_MAX_TOKENS_INTEL,
                        temperature: CONFIG.AI_TEMPERATURE
                    }
                }),
                signal: controller.signal
            }
        );
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error('Market intel service temporarily unavailable');
        }
        const result = await response.json();
        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) {
            throw new Error('Market intel returned empty response');
        }
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Market intel response format error');
        }
        return JSON.parse(jsonMatch[0]);
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Market intel request timed out');
        }
        throw error;
    }
};

// =============================================================================
// GENERATE INTRO EMAIL
// =============================================================================
const generateIntroEmail = async (jobDescription, resumeText, analysisData) => {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        throw new Error('AI service configuration missing');
    }
    const prompt = `Write an intro email to a recruiter or hiring manager for a job applicant.

CANDIDATE'S RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

ANALYSIS RESULTS:
- Match Score: ${analysisData.score}%
- Top Matches: ${analysisData.analysis.filter(a => a.startsWith('Match:')).join('; ')}
- Gaps: ${analysisData.analysis.filter(a => a.startsWith('Gap:')).join('; ')}

WRITE A SHORT INTRO EMAIL:

FORMAT:
Subject: [Compelling subject line referencing the specific role]

[Email body - 3 short paragraphs max]

[Candidate Name]
[Phone if available from resume]
[Email if available from resume]

RULES:
- NO placeholder text like [Company Name] or [Role]
- NO generic phrases like "keen interest" or "eager to leverage"
- Write DIRECT, CONFIDENT statements about capabilities
- Use SPECIFIC numbers and results from the resume
- Keep it SHORT - this is an email, not an essay
- Professional but conversational tone

OUTPUT THE COMPLETE EMAIL:`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.AI_TIMEOUT_MS);
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        maxOutputTokens: 800,
                        temperature: 0.6
                    }
                }),
                signal: controller.signal
            }
        );
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error('AI service temporarily unavailable');
        }
        const result = await response.json();
        const emailText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!emailText) {
            throw new Error('Email generation failed');
        }
        return emailText.trim();
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.');
        }
        throw error;
    }
};

// =============================================================================
// ASK AN EXPERT
// =============================================================================
const askExpert = async (question, jobDescription, resumeText, analysisData, chatHistory = []) => {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        throw new Error('AI service configuration missing');
    }
    const conversationContext = chatHistory.length > 0 
        ? `\nPREVIOUS CONVERSATION:\n${chatHistory.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n')}\n`
        : '';
    const prompt = `You are a senior federal recruiting expert with 25+ years placing executives in IC, DoD, and defense contractor roles.

YOUR APPROACH:
- Direct, professional communicator
- Deep expertise in federal sales, capture, and executive recruiting
- You know clearance processes, federal hiring timelines, and what matters
- Give tactical, actionable advice
- Be honest about gaps while remaining constructive

CANDIDATE'S RESUME:
${resumeText}

JOB BEING DISCUSSED:
${jobDescription}

ANALYSIS RESULTS:
- Match Score: ${analysisData.score}%
- Job: ${analysisData.job_title} at ${analysisData.company}
- Key Matches: ${analysisData.analysis.filter(a => a.startsWith('Match:')).slice(0, 3).join('; ')}
- Key Gaps: ${analysisData.analysis.filter(a => a.startsWith('Gap:')).join('; ')}
${analysisData.salary_intel ? `
MARKET INTEL:
- Salary Range: $${analysisData.salary_intel.low}K - $${analysisData.salary_intel.high}K (target: $${analysisData.salary_intel.mid}K)
- Reasoning: ${analysisData.salary_intel.notes}` : ''}
${analysisData.competition ? `
- Competition Level: ${analysisData.competition.level} - ${analysisData.competition.reasoning}` : ''}
${analysisData.company_intel?.known ? `
COMPANY INTEL:
- Type: ${analysisData.company_intel.type}
- Size: ${analysisData.company_intel.size}
- Reputation: ${analysisData.company_intel.reputation}` : ''}
${conversationContext}
USER'S QUESTION:
${question}

RESPOND AS THE EXPERT:
- Be direct and specific to the candidate's situation
- Reference the actual job and their actual experience
- If asked about salary, use the market intel above if available
- If asked about gaps, be honest but constructive
- Keep responses concise but substantive (2-4 paragraphs)
- Address the user directly with "you"

YOUR RESPONSE:`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.AI_TIMEOUT_MS);
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        maxOutputTokens: 1000,
                        temperature: 0.7
                    }
                }),
                signal: controller.signal
            }
        );
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error('AI service temporarily unavailable');
        }
        const result = await response.json();
        const expertResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!expertResponse) {
            throw new Error('Expert response generation failed');
        }
        return expertResponse.trim();
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.');
        }
        throw error;
    }
};

// =============================================================================
// MAIN HANDLER
// =============================================================================
export const handler = async (event) => {
    if (event.requestContext?.http?.method === 'OPTIONS' || event.httpMethod === 'OPTIONS') {
        return createResponse(204, null);
    }
    const startTime = Date.now();
    try {
        const clientIP = getClientIP(event);
        const rateLimitResult = checkRateLimit(clientIP);
        if (!rateLimitResult.allowed) {
            return {
                statusCode: 429,
                headers: {
                    ...getCorsHeaders(),
                    'Retry-After': String(rateLimitResult.retryAfter || 60)
                },
                body: JSON.stringify({ 
                    error: rateLimitResult.reason,
                    retryAfter: rateLimitResult.retryAfter
                })
            };
        }
        
        const body = JSON.parse(event.body || '{}');
        const requestType = body.request_type || 'resume_match';
        
        // Handle intro email generation
        if (requestType === "generate_intro_email") {
            const { job_description, resume_text, analysis_data } = body;
            if (!job_description || !resume_text || !analysis_data) {
                return createResponse(400, { error: "Job description, resume, and analysis data required" });
            }
            const email = await generateIntroEmail(job_description, resume_text, analysis_data);
            return createResponse(200, { intro_email: email });
        }
        
        // Handle Ask Expert
        if (requestType === "ask_expert") {
            const { question, job_description, resume_text, analysis_data, chat_history } = body;
            if (!question) {
                return createResponse(400, { error: "Question is required" });
            }
            if (!job_description || !resume_text || !analysis_data) {
                return createResponse(400, { error: "Please analyze a job first before asking questions" });
            }
            const expertResponse = await askExpert(question, job_description, resume_text, analysis_data, chat_history || []);
            return createResponse(200, { response: expertResponse });
        }
        
        // Handle Market Intel
        if (requestType === "market_intel") {
            const { job_description, job_title, company } = body;
            if (!job_description) {
                return createResponse(400, { error: "Job description is required" });
            }
            const marketIntel = await generateMarketIntel(job_description, job_title, company);
            return createResponse(200, marketIntel);
        }
        
        // Handle Resume Match (main analysis)
        if (requestType !== 'resume_match') {
            return createResponse(400, { error: 'Unknown request type' });
        }
        
        let jobDescription = body.job_description || body.situation || body.prompt;
        const resumeText = body.resume_text;
        
        // Validate inputs
        if (!jobDescription || typeof jobDescription !== 'string') {
            return createResponse(400, { error: 'Job description is required' });
        }
        if (!resumeText || typeof resumeText !== 'string') {
            return createResponse(400, { error: 'Resume is required' });
        }
        
        jobDescription = sanitizeInput(jobDescription).substring(0, CONFIG.MAX_JD_LENGTH);
        const cleanResume = sanitizeInput(resumeText).substring(0, CONFIG.MAX_RESUME_LENGTH);
        
        // Handle URL input for job description
        const isUrl = jobDescription.startsWith('http://') || jobDescription.startsWith('https://');
        if (isUrl) {
            const fetchedText = await fetchUrlContent(jobDescription);
            if (!fetchedText || fetchedText.length < CONFIG.MIN_JD_LENGTH) {
                return createResponse(400, { 
                    error: 'Could not read that URL. Please copy/paste the job description text directly.' 
                });
            }
            jobDescription = sanitizeInput(fetchedText).substring(0, CONFIG.MAX_JD_LENGTH);
        } else {
            if (jobDescription.length < CONFIG.MIN_JD_LENGTH) {
                return createResponse(400, { error: 'Job description is too short.' });
            }
        }
        
        if (cleanResume.length < CONFIG.MIN_RESUME_LENGTH) {
            return createResponse(400, { error: 'Resume is too short. Please provide more details.' });
        }
        
        const matchData = await generateResumeMatch(jobDescription, cleanResume);
        const elapsed = Date.now() - startTime;
        console.log(`[HANDLER] Complete in ${elapsed}ms`);
        return createResponse(200, matchData);
        
    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.error(`[HANDLER] Error after ${elapsed}ms:`, error.message);
        const userMessage = error.message.includes('timed out') 
            ? 'Request timed out. Please try again.'
            : error.message.includes('API') || error.message.includes('AI')
                ? error.message
                : 'Something went wrong. Please try again.';
        return createResponse(500, { error: userMessage });
    }
};
