import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { db } from "./db/index.js";
import { blogs, topics, appSettings, knowledgeBase, agentLogs } from "./db/schema.js";
import { eq, desc, inArray } from "drizzle-orm";
import { triggerDrafter, triggerIdeaReviser, triggerIdeaGenerator } from "./orchestrator.js";
import { Resend } from "resend";

const app = new Hono();
const resend = new Resend(process.env.RESEND_API_KEY);

// A simple layout wrapper for our HTML pages
const Layout = (props: { children: any }) => (
  <html>
    <head>
      <title>CoreCV Agent Review</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50 text-gray-900 p-8 font-sans">
      <div class="max-w-3xl mx-auto bg-white p-8 rounded-lg shadow-sm border border-gray-200">
        {props.children}
      </div>
    </body>
  </html>
);

// --- MAGIC LINK: BATCH REVIEW DRAFTS ---
app.get("/review/drafts", async (c) => {
  const pendingDrafts = await db.query.blogs.findMany({
    where: eq(blogs.status, "pending_human"),
    orderBy: (blogs, { desc }) => [desc(blogs.createdAt)]
  });

  if (pendingDrafts.length === 0) {
    return c.html(<Layout><h1 class="text-2xl text-gray-500">No pending drafts to review right now!</h1></Layout>);
  }

  return c.html(
    <Layout>
      <h1 class="text-3xl font-bold mb-2">Weekly Draft Review</h1>
      <p class="text-sm text-gray-500 mb-6">Review your drafts. Leave feedback to revise, or leave blank to approve for publishing.</p>

      {/* ONE BIG FORM FOR ALL DRAFTS */}
      <form action="/review/drafts/submit" method="post" class="space-y-6" id="reviewDraftForm">
        {pendingDrafts.map((draft, index) => (
          <div class="bg-white p-6 rounded-lg border shadow-sm" id={`draft-card-${index}`}>
            <h2 class="text-xl font-bold text-gray-900 mb-2">Draft {index + 1}: {draft.title}</h2>
            
            {/* Scrollable container for the long draft content */}
            <div class="prose max-w-none mb-6 bg-gray-50 p-4 rounded border h-96 overflow-y-auto">
              <pre class="whitespace-pre-wrap font-sans text-sm">{draft.content}</pre>
            </div>
            
            <input type="hidden" name={`draftId_${index}`} value={draft.id} />
            <input type="hidden" name={`topicId_${index}`} value={draft.topicId || ""} />
            
            <div class="flex gap-3 mb-2">
               <button 
                 type="button" 
                 class="bg-gray-200 text-gray-800 px-4 py-2 rounded font-medium hover:bg-gray-300 transition revise-draft-toggle-btn" 
                 data-target={`draft-feedback-container-${index}`}
               >
                 Revise Draft
               </button>
            </div>

            <div id={`draft-feedback-container-${index}`} class="hidden mt-4">
              <label class="block text-sm font-medium text-gray-700 mb-1">What should the AI change?</label>
              <textarea 
                name="feedback_${index}" 
                rows={3}
                placeholder="e.g. This draft is too formal, make it punchier..." 
                class="w-full border border-gray-300 rounded px-3 py-2 focus:ring-blue-500 focus:border-blue-500 draft-feedback-input" 
              ></textarea>
            </div>
          </div>
        ))}

        <div class="pt-4 border-t border-gray-200 sticky bottom-4">
          <button type="submit" id="mainDraftSubmitBtn" class="w-full bg-green-600 text-white px-6 py-4 rounded-lg font-bold hover:bg-green-700 transition shadow-lg text-lg">
            Approve All Drafts
          </button>
        </div>
      </form>

      <script dangerouslySetInnerHTML={{ __html: `
        document.addEventListener('DOMContentLoaded', () => {
          const reviseButtons = document.querySelectorAll('.revise-draft-toggle-btn');
          const feedbackInputs = document.querySelectorAll('.draft-feedback-input');
          const mainSubmitBtn = document.getElementById('mainDraftSubmitBtn');

          function updateMainButton() {
            let needsRevision = false;
            
            feedbackInputs.forEach(input => {
              const container = input.closest('div[id^="draft-feedback-container-"]');
              if (!container.classList.contains('hidden') || input.value.trim() !== '') {
                needsRevision = true;
              }
            });

            if (needsRevision) {
              mainSubmitBtn.innerText = 'Submit Revisions & Approve Rest';
              mainSubmitBtn.classList.remove('bg-green-600', 'hover:bg-green-700');
              mainSubmitBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
            } else {
              mainSubmitBtn.innerText = 'Approve All Drafts';
              mainSubmitBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
              mainSubmitBtn.classList.add('bg-green-600', 'hover:bg-green-700');
            }
          }

          reviseButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
              const targetId = btn.getAttribute('data-target');
              const container = document.getElementById(targetId);
              
              container.classList.toggle('hidden');
              
              if (container.classList.contains('hidden')) {
                const input = container.querySelector('.draft-feedback-input');
                if (input) input.value = '';
                btn.innerText = 'Revise Draft';
                btn.classList.remove('bg-blue-100', 'text-blue-800');
                btn.classList.add('bg-gray-200', 'text-gray-800');
              } else {
                btn.innerText = 'Cancel Revision';
                btn.classList.remove('bg-gray-200', 'text-gray-800');
                btn.classList.add('bg-blue-100', 'text-blue-800');
              }
              
              updateMainButton();
            });
          });

          feedbackInputs.forEach(input => {
            input.addEventListener('input', updateMainButton);
          });
        });
      `}} />
    </Layout>
  );
});

// --- MAGIC LINK: BATCH REVIEW TOPICS ---
app.get("/review/topics", async (c) => {
  const pendingTopics = await db.query.topics.findMany({
    where: eq(topics.status, "pending_review"),
    orderBy: (topics, { desc }) => [desc(topics.createdAt)]
  });

  if (pendingTopics.length === 0) {
    return c.html(<Layout><h1 class="text-2xl text-gray-500">No pending topics to review right now!</h1></Layout>);
  }

  return c.html(
    <Layout>
      <h1 class="text-3xl font-bold mb-2">Weekly Topic Review</h1>
      <p class="text-sm text-gray-500 mb-6">Review your 3 ideas for the week. Leave feedback to regenerate, or leave blank to approve.</p>

      {/* ONE BIG FORM FOR ALL TOPICS */}
      <form action="/review/topics/submit" method="post" class="space-y-6" id="reviewForm">
        {pendingTopics.map((topic, index) => (
          <div class="bg-gray-50 p-6 rounded border" id={`topic-card-${index}`}>
            <h2 class="text-xl font-bold text-gray-900 mb-2">Idea {index + 1}: {topic.title}</h2>
            {topic.description && <p class="text-gray-600 mb-4">{topic.description}</p>}
            
            <input type="hidden" name={`topicId_${index}`} value={topic.id} />
            
            <div class="flex gap-3 mb-2">
               <button 
                 type="button" 
                 class="bg-gray-200 text-gray-800 px-4 py-2 rounded font-medium hover:bg-gray-300 transition revise-toggle-btn" 
                 data-target={`feedback-container-${index}`}
               >
                 Revise Idea
               </button>
            </div>

            <div id={`feedback-container-${index}`} class="hidden mt-4">
              <label class="block text-sm font-medium text-gray-700 mb-1">What should the AI change?</label>
              <input 
                type="text" 
                name={`feedback_${index}`} 
                placeholder="e.g. Make this more about AI..." 
                class="w-full border border-gray-300 rounded px-3 py-2 focus:ring-blue-500 focus:border-blue-500 feedback-input" 
              />
            </div>
          </div>
        ))}

        <div class="pt-4 border-t border-gray-200">
          <button type="submit" id="mainSubmitBtn" class="w-full bg-green-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-green-700 transition shadow-sm">
            Approve All Ideas
          </button>
        </div>
      </form>

      <script dangerouslySetInnerHTML={{ __html: `
        document.addEventListener('DOMContentLoaded', () => {
          const reviseButtons = document.querySelectorAll('.revise-toggle-btn');
          const feedbackInputs = document.querySelectorAll('.feedback-input');
          const mainSubmitBtn = document.getElementById('mainSubmitBtn');

          function updateMainButton() {
            let needsRevision = false;
            
            // Check if any feedback input is visible OR has text
            feedbackInputs.forEach(input => {
              const container = input.closest('div[id^="feedback-container-"]');
              if (!container.classList.contains('hidden') || input.value.trim() !== '') {
                needsRevision = true;
              }
            });

            if (needsRevision) {
              mainSubmitBtn.innerText = 'Submit Revisions & Approve Rest';
              mainSubmitBtn.classList.remove('bg-green-600', 'hover:bg-green-700');
              mainSubmitBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
            } else {
              mainSubmitBtn.innerText = 'Approve All Ideas';
              mainSubmitBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
              mainSubmitBtn.classList.add('bg-green-600', 'hover:bg-green-700');
            }
          }

          reviseButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
              const targetId = btn.getAttribute('data-target');
              const container = document.getElementById(targetId);
              
              // Toggle visibility
              container.classList.toggle('hidden');
              
              // If we are hiding it, clear the input so it doesn't accidentally submit hidden feedback
              if (container.classList.contains('hidden')) {
                const input = container.querySelector('.feedback-input');
                if (input) input.value = '';
                btn.innerText = 'Revise Idea';
                btn.classList.remove('bg-blue-100', 'text-blue-800');
                btn.classList.add('bg-gray-200', 'text-gray-800');
              } else {
                btn.innerText = 'Cancel Revision';
                btn.classList.remove('bg-gray-200', 'text-gray-800');
                btn.classList.add('bg-blue-100', 'text-blue-800');
              }
              
              updateMainButton();
            });
          });

          // Also update on typing
          feedbackInputs.forEach(input => {
            input.addEventListener('input', updateMainButton);
          });
        });
      `}} />
    </Layout>
  );
});

// --- MAGIC LINK: HANDLE BATCH TOPIC SUBMISSION ---
app.post("/review/topics/submit", async (c) => {
  const formData = await c.req.parseBody();

  // The formData will look like: 
  // { topicId_0: "uuid", feedback_0: "bad idea", topicId_1: "uuid", feedback_1: "" }
  
  // We need to parse it (assuming a max of 10 topics for safety)
  for (let i = 0; i < 10; i++) {
    const topicId = formData[`topicId_${i}`] as string;
    const feedback = formData[`feedback_${i}`] as string;

    if (!topicId) continue; // Skip if it doesn't exist

    if (feedback && feedback.trim() !== "") {
      // User left feedback! Change status to "regenerate" and save the feedback text
      await db.update(topics).set({ status: "regenerate", feedback: feedback }).where(eq(topics.id, topicId));
      
      // Fire and forget the reviser!
      triggerIdeaReviser(topicId);
    } else {
      // Blank feedback! Approve it.
      await db.update(topics).set({ status: "approved" }).where(eq(topics.id, topicId));
      
      // Fire and forget the drafter!
      triggerDrafter(topicId);
    }
  }

  return c.html(
    <Layout>
      <h1 class="text-2xl font-bold text-green-600">Review Submitted!</h1>
      <p>Your approved topics will be drafted on Friday. The AI will immediately begin regenerating the others based on your feedback.</p>
    </Layout>
  );
});


// --- MAGIC LINK: HANDLE BATCH DRAFT SUBMISSION ---
app.post("/review/drafts/submit", async (c) => {
  const formData = await c.req.parseBody();

  // Similar to topics, we loop through max 10 drafts
  for (let i = 0; i < 10; i++) {
    const draftId = formData[`draftId_${i}`] as string;
    const topicId = formData[`topicId_${i}`] as string;
    const feedback = formData[`feedback_${i}`] as string;

    if (!draftId) continue; 

    if (feedback && feedback.trim() !== "") {
      // Human left feedback -> Regenerate
      await db.update(blogs).set({ status: "regenerate_draft", feedback: feedback }).where(eq(blogs.id, draftId));
      
      // Fire and forget the draft reviser in the background!
      if (topicId) {
        triggerDrafter(topicId);
      }
    } else {
      // Blank feedback -> Approve
      await db.update(blogs).set({ status: "approved_for_publishing" }).where(eq(blogs.id, draftId));
    }
  }

  return c.html(
    <Layout>
      <h1 class="text-2xl font-bold text-green-600">Draft Review Submitted!</h1>
      <p>Approved drafts have been queued for publishing. The Drafter Agent is now rewriting the others in the background based on your feedback.</p>
    </Layout>
  );
});




// --- ADMIN SETTINGS DASHBOARD ---
app.get("/admin/settings", async (c) => {
  // Fetch existing settings (or use defaults if none exist)
  let settings = await db.query.appSettings.findFirst();
  if (!settings) {
    // create default row
    const inserted = await db.insert(appSettings).values({}).returning();
    settings = inserted[0];
  }

  // Fetch playbook
  let playbook = await db.query.knowledgeBase.findFirst({
    where: eq(knowledgeBase.type, "media_playbook")
  });
  if (!playbook) {
    const inserted = await db.insert(knowledgeBase).values({ type: "media_playbook", content: "Write blog posts here..." }).returning();
    playbook = inserted[0];
  }

  // Fetch top 20 recent agent logs
  const logs = await db.query.agentLogs.findMany({
    orderBy: [desc(agentLogs.createdAt)],
    limit: 20
  });

  return c.html(
    <Layout>
      <h1 class="text-3xl font-bold mb-2">System Configuration</h1>
      <p class="text-sm text-gray-500 mb-8">Manage Auto-Pilot modes, Buffer sizes, and the AI Playbook.</p>

      <form action="/admin/settings" method="post" class="space-y-8 bg-white p-6 rounded-lg border shadow-sm">
        
        {/* Toggle Settings */}
        <div>
          <h2 class="text-xl font-bold mb-4">Auto-Pilot Modes</h2>
          <div class="flex items-center mb-4">
            <input type="checkbox" id="autoApproveIdeas" name="autoApproveIdeas" checked={settings.autoApproveIdeas} class="w-5 h-5 text-blue-600 rounded" />
            <label for="autoApproveIdeas" class="ml-3 text-gray-700 font-medium">Auto-Approve Ideas (Skip Review)</label>
          </div>
          <div class="flex items-center">
            <input type="checkbox" id="autoPublishDrafts" name="autoPublishDrafts" checked={settings.autoPublishDrafts} class="w-5 h-5 text-blue-600 rounded" />
            <label for="autoPublishDrafts" class="ml-3 text-gray-700 font-medium">Auto-Publish Drafts (Skip Review)</label>
          </div>
        </div>

        <hr />

        {/* Variables */}
        <div>
          <h2 class="text-xl font-bold mb-4">Generation Variables</h2>
          <div class="grid grid-cols-2 gap-6">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Target Buffer Size (Drafts)</label>
              <input type="number" name="targetBuffer" value={settings.targetBuffer} class="w-full border border-gray-300 rounded px-3 py-2" />
              <p class="text-xs text-gray-500 mt-1">We publish 3x a week. Buffer of 6 = 2 weeks.</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Ideas Per Generation</label>
              <input type="number" name="ideasPerGeneration" value={settings.ideasPerGeneration} class="w-full border border-gray-300 rounded px-3 py-2" />
              <p class="text-xs text-gray-500 mt-1">Number of ideas to generate when buffer is low.</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Draft Target Length (Words)</label>
              <input type="number" name="draftTargetLength" value={settings.draftTargetLength} class="w-full border border-gray-300 rounded px-3 py-2" />
              <p class="text-xs text-gray-500 mt-1">The rough word count for final blog drafts.</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Research Depth</label>
              <input type="number" name="researchDepth" value={settings.researchDepth} class="w-full border border-gray-300 rounded px-3 py-2" />
              <p class="text-xs text-gray-500 mt-1">How many Google queries the AI performs.</p>
            </div>
          </div>
        </div>

        <hr />

        {/* AI Agent Tuning */}
        <div>
          <h2 class="text-xl font-bold mb-4">AI Agent Tuning</h2>
          <div class="grid grid-cols-2 gap-6">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Google AI Model</label>
              <select name="modelSelection" class="w-full border border-gray-300 rounded px-3 py-2 bg-white">
                <option value="gemini-2.5-flash" selected={settings.modelSelection === "gemini-2.5-flash"}>gemini-2.5-flash (Fast & Cheap)</option>
                <option value="gemini-2.5-pro" selected={settings.modelSelection === "gemini-2.5-pro"}>gemini-2.5-pro (Slow & Smart)</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Creative Temperature (0.0 - 1.0)</label>
              <input type="number" step="0.1" min="0" max="1" name="creativeTemperature" value={settings.creativeTemperature} class="w-full border border-gray-300 rounded px-3 py-2" />
              <p class="text-xs text-gray-500 mt-1">Higher is more chaotic/creative. Lower is more analytical.</p>
            </div>
          </div>
        </div>

        <hr />

        {/* Knowledge Base */}
        <div>
          <h2 class="text-xl font-bold mb-4">Media Playbook (Blog-Specific Rules)</h2>
          <label class="block text-sm font-medium text-gray-700 mb-1">Paste your dynamic blog-specific rules here (this will be combined with the permanent CoreCV Brand Playbook automatically):</label>
          <textarea 
            name="playbookContent" 
            rows={15}
            class="w-full border border-gray-300 rounded px-3 py-2 font-mono text-sm"
          >{playbook.content}</textarea>
        </div>

        <button type="submit" class="w-full bg-blue-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-blue-700 transition">
          Save Configuration
        </button>
      </form>

      {/* Observability: Live Agent Feed */}
      <div class="mt-12 bg-white p-6 rounded-lg border shadow-sm">
        <h2 class="text-xl font-bold mb-4">Live Agent Feed</h2>
        <div class="space-y-4 max-h-96 overflow-y-auto">
          {logs.map(log => {
            let statusColor = "text-gray-600 bg-gray-100";
            if (log.status === "success") statusColor = "text-green-600 bg-green-100";
            if (log.status === "error") statusColor = "text-red-600 bg-red-100";
            if (log.status === "started") statusColor = "text-blue-600 bg-blue-100";

            return (
              <div class="flex items-start p-3 border rounded-lg">
                <div class={`px-2 py-1 text-xs font-bold rounded ${statusColor} mr-4`}>
                  {log.status.toUpperCase()}
                </div>
                <div class="w-full">
                  <p class="font-semibold text-sm text-gray-800">{log.agentName} <span class="font-normal text-gray-500 text-xs ml-2">{log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}</span></p>
                  <p class="text-sm text-gray-600 mt-1">{log.message}</p>
                  {log.metadata && (
                    <pre class="mt-2 bg-gray-50 p-2 rounded text-xs text-gray-700 overflow-x-auto border border-gray-200">
                      {JSON.stringify(log.metadata, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            );
          })}
          {logs.length === 0 && <p class="text-sm text-gray-500">No agent activity recorded yet.</p>}
        </div>
      </div>
    </Layout>
  );
});

app.post("/admin/settings", async (c) => {
  const formData = await c.req.parseBody();
  
  const autoApproveIdeas = formData["autoApproveIdeas"] === "on";
  const autoPublishDrafts = formData["autoPublishDrafts"] === "on";
  const targetBuffer = parseInt(formData["targetBuffer"] as string, 10) || 6;
  const ideasPerGeneration = parseInt(formData["ideasPerGeneration"] as string, 10) || 3;
  const draftTargetLength = parseInt(formData["draftTargetLength"] as string, 10) || 1500;
  const researchDepth = parseInt(formData["researchDepth"] as string, 10) || 5;
  const creativeTemperature = parseFloat(formData["creativeTemperature"] as string) || 0.7;
  const modelSelection = formData["modelSelection"] as string || "gemini-2.5-flash";
  const playbookContent = formData["playbookContent"] as string;

  // 1. Update settings
  const currentSettings = await db.query.appSettings.findFirst();
  if (currentSettings) {
    await db.update(appSettings)
      .set({ 
        autoApproveIdeas, 
        autoPublishDrafts, 
        targetBuffer, 
        ideasPerGeneration,
        draftTargetLength,
        researchDepth,
        creativeTemperature,
        modelSelection
      })
      .where(eq(appSettings.id, currentSettings.id));
  }

  // 2. Update Playbook
  await db.update(knowledgeBase)
    .set({ content: playbookContent })
    .where(eq(knowledgeBase.type, "media_playbook"));

  return c.redirect("/admin/settings");
});

// --- CRON JOBS (PHASE 3) ---
function verifyCronSecret(c: any) {
  const auth = c.req.header("Authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return auth === `Bearer ${secret}`;
}

app.post("/api/cron/generate", async (c) => {
  if (!verifyCronSecret(c)) return c.json({ error: "Unauthorized" }, 401);

  const settings = await db.query.appSettings.findFirst();
  if (!settings) return c.json({ error: "Settings not found" }, 500);

  // Buffer Math: Count unpublished topics
  const unpublishedTopics = await db.query.topics.findMany({
    where: inArray(topics.status, ["drafted", "pending_review", "pending_human", "approved"])
  });
  const unpublishedCount = unpublishedTopics.length;

  if (unpublishedCount < settings.targetBuffer) {
    console.log(`[Cron] Buffer low (${unpublishedCount}/${settings.targetBuffer}). Triggering Idea Generator.`);
    triggerIdeaGenerator();
    return c.json({ message: "Buffer low. Idea generation triggered.", currentBuffer: unpublishedCount, targetBuffer: settings.targetBuffer });
  } else {
    console.log(`[Cron] Buffer full (${unpublishedCount}/${settings.targetBuffer}). Skipping Idea Generator.`);
    return c.json({ message: "Buffer full. No generation needed.", currentBuffer: unpublishedCount, targetBuffer: settings.targetBuffer });
  }
});

app.post("/api/cron/publish", async (c) => {
  if (!verifyCronSecret(c)) return c.json({ error: "Unauthorized" }, 401);

  const settings = await db.query.appSettings.findFirst();
  
  // Find a draft that is approved, or pending_human if autoPublishDrafts is ON
  const validStatuses = settings?.autoPublishDrafts ? ["approved", "pending_human"] : ["approved"];
  const publishableDrafts = await db.query.blogs.findMany({
    where: inArray(blogs.status, validStatuses as any),
    orderBy: (blogs, { asc }) => [asc(blogs.createdAt)],
    limit: 1
  });

  if (publishableDrafts.length === 0) {
    return c.json({ message: "No publishable drafts found." });
  }

  const draftToPublish = publishableDrafts[0];

  console.log(`[Cron] Publishing draft: ${draftToPublish.title}...`);
  // TODO: Send to Main App API here!
  console.log("-> Sent to Main App API");

  // Update DB
  await db.update(blogs).set({ status: "published" }).where(eq(blogs.id, draftToPublish.id));
  await db.update(topics).set({ status: "published" }).where(eq(topics.id, draftToPublish.topicId!));

  return c.json({ message: "Draft published successfully.", draftId: draftToPublish.id });
});

app.post("/api/cron/notify", async (c) => {
  if (!verifyCronSecret(c)) return c.json({ error: "Unauthorized" }, 401);

  // Check for pending ideas
  const pendingIdeas = await db.query.topics.findMany({
    where: eq(topics.status, "pending_review")
  });

  // Check for pending drafts
  const pendingDrafts = await db.query.blogs.findMany({
    where: eq(blogs.status, "pending_human")
  });

  const ideasCount = pendingIdeas.length;
  const draftsCount = pendingDrafts.length;

  if (ideasCount === 0 && draftsCount === 0) {
    console.log("[Cron] No pending tasks. Skipping email digest.");
    return c.json({ message: "No pending tasks. No email sent." });
  }

  const fromEmail = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const toEmail = process.env.EMAIL_TO;

  if (!toEmail) {
    console.error("[Cron] EMAIL_TO is not set. Cannot send digest.");
    return c.json({ error: "EMAIL_TO not configured" }, 500);
  }

  // Format the email
  const subject = `CoreCV AI Digest: ${draftsCount} Drafts & ${ideasCount} Ideas Waiting`;
  const htmlContent = `
    <h2>CoreCV AI Agent Digest</h2>
    <p>Your agents have completed background tasks and are waiting for your review.</p>
    <ul>
      <li><strong>Drafts awaiting review:</strong> ${draftsCount}</li>
      <li><strong>Ideas awaiting review:</strong> ${ideasCount}</li>
    </ul>
    <p>Please log in to your CoreCV Agent Dashboard to approve or revise them.</p>
  `;

  console.log(`[Cron] Sending digest email to ${toEmail}...`);

  const { data, error } = await resend.emails.send({
    from: fromEmail,
    to: toEmail,
    subject: subject,
    html: htmlContent,
  });

  if (error) {
    console.error("[Cron] Failed to send email digest:", error);
    return c.json({ error: "Failed to send email" }, 500);
  }

  console.log("[Cron] Digest email sent successfully:", data);
  return c.json({ message: "Digest email sent.", data });
});


const port = 3000;
console.log(`Server is running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port
});
