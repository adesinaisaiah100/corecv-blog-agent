import { db } from "./db/index.js";
import { topics, blogs, knowledgeBase, agentLogs } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { draftingAgent } from "./agents/draftingAgent.js";
import { reviseIdeaAgent } from "./agents/reviseIdeaAgent.js";

/**
 * Helper to fetch the CoreCV Playbook from the database
 */
async function getPlaybook() {
  const corecv = await db.query.knowledgeBase.findFirst({
    where: eq(knowledgeBase.type, "corecv_playbook")
  });
  const media = await db.query.knowledgeBase.findFirst({
    where: eq(knowledgeBase.type, "media_playbook")
  });

  const coreText = corecv ? corecv.content : "No corecv playbook found.";
  const mediaText = media ? media.content : "No media playbook found.";

  return `--- CORECV BRAND IDENTITY ---
${coreText}

--- BLOG MEDIA PLAYBOOK ---
${mediaText}`;
}

/**
 * Helper to log Agent events to the database
 */
export async function logAgentEvent(agentName: string, status: string, message: string, topicId?: string, metadata?: any) {
  try {
    await db.insert(agentLogs).values({
      agentName,
      status,
      message,
      topicId: topicId || null,
      metadata: metadata || null
    });
  } catch (err) {
    console.error(`[System Log Failed] ${agentName}: ${message}`, err);
  }
}

/**
 * Helper to fetch Settings from the database
 */
async function getSettings() {
  const settings = await db.query.appSettings.findFirst();
  if (!settings) {
    throw new Error("No appSettings found. Please visit /admin/settings first.");
  }
  return settings;
}

/**
 * TRIGGER DRAFTER
 * Spoons up the Drafter Agent. 
 * If there is NO draft, it writes a new one.
 * If there IS a draft (and feedback), it revises the existing one.
 */
export async function triggerDrafter(topicId: string) {
  // 1. Fetch the necessary data
  const topic = await db.query.topics.findFirst({
    where: eq(topics.id, topicId)
  });
  
  if (!topic) throw new Error(`Topic ${topicId} not found`);

  // Check if a draft already exists (meaning this is a human revision request)
  const existingDraft = await db.query.blogs.findFirst({
    where: eq(blogs.topicId, topicId)
  });

  const playbook = await getPlaybook();
  const settings = await getSettings();

  // Create the stringified brief expected by the Drafter
  const brief = JSON.stringify({
    title: topic.title,
    postType: topic.postType,
    primaryKeyword: topic.primaryKeyword,
    secondaryKeyword: topic.secondaryKeyword,
    researchSignal: topic.researchSignal,
    coreCvConnection: topic.coreCvConnection,
    coreArgument: topic.coreArgument,
    intendedReader: topic.intendedReader,
    supportingDataPoints: topic.supportingDataPoints,
    toneNotes: topic.toneNotes
  });

  // Build the initial state for the LangGraph
  const initialState: any = {
    settings: settings,
    topicId: topic.id,
    title: topic.title,
    brief: brief,
    playbook: playbook,
    revisionCount: 0,
    isApproved: false
  };

  // If this is a human revision, we pass in the existing draft and the human's feedback
  if (existingDraft && existingDraft.feedback) {
    initialState.currentDraft = existingDraft.content;
    initialState.feedback = existingDraft.feedback;
  }

  /* 
   * PARALLEL ARCHITECTURE EXPLANATION:
   * Notice how the function we exported returns a Promise? 
   * When index.tsx calls this function, it DOES NOT use the 'await' keyword.
   * This sends the draftingAgent into the Node.js Event Loop. 
   * The server instantly continues its business while this runs completely independently 
   * in the background. It's like sending a robot to a separate desk!
   */
  await logAgentEvent("Drafter", "started", "Began drafting topic based on approved idea.", topicId, {
    action: "generateDraft",
    model: settings.modelSelection
  });

  const startTime = Date.now();

  draftingAgent.invoke(initialState)
    .then(async () => {
      const durationMs = Date.now() - startTime;
      console.log(`[Orchestrator] Finished drafting for topic ${topicId}!`);
      await logAgentEvent("Drafter", "success", "Successfully generated and saved draft.", topicId, {
        durationMs,
        model: settings.modelSelection
      });
      // Optional future feature: await sendEmail("Your draft is ready!");
    })
    .catch(async (err: any) => {
      const durationMs = Date.now() - startTime;
      console.error(`[Orchestrator] Error drafting topic ${topicId}:`, err);
      await logAgentEvent("Drafter", "error", `Drafting failed: ${err.message}`, topicId, {
        durationMs,
        stackTrace: err.stack,
        model: settings.modelSelection
      });
    });
}


/**
 * TRIGGER IDEA REVISER
 * Spoons up the Revise Idea Agent to generate a completely new topic angle based on human feedback.
 */
export async function triggerIdeaReviser(topicId: string) {
  // 1. Fetch the topic and playbook
  const topic = await db.query.topics.findFirst({
    where: eq(topics.id, topicId)
  });

  if (!topic) throw new Error(`Topic ${topicId} not found`);
  
  const playbook = await getPlaybook();
  const settings = await getSettings();

  const initialState = {
    settings: settings,
    topicId: topic.id,
    playbook: playbook,
    feedback: topic.feedback || "", // The feedback you typed in the Magic Link
    originalBrief: topic, // Just passing the whole row
    revisedBrief: {}
  };

  /* 
   * PARALLEL ARCHITECTURE EXPLANATION:
   * Again, this is fired asynchronously. If you requested revisions on 3 ideas,
   * index.tsx calls this 3 times instantly without waiting.
   * 3 separate network requests are made to Gemini at the exact same time.
   */
  await logAgentEvent("ReviseIdeaAgent", "started", "Began revising idea based on human feedback.", topicId, {
    feedback: topic.feedback,
    model: settings.modelSelection
  });

  const startTime = Date.now();

  reviseIdeaAgent.invoke(initialState)
    .then(async () => {
      const durationMs = Date.now() - startTime;
      console.log(`[Orchestrator] Finished revising idea ${topicId}!`);
      await logAgentEvent("ReviseIdeaAgent", "success", "Successfully revised idea and submitted for re-review.", topicId, {
        durationMs
      });
      // Optional future feature: await sendEmail("Your revised idea is ready!");
    })
    .catch(async (err: any) => {
      const durationMs = Date.now() - startTime;
      console.error(`[Orchestrator] Error revising topic ${topicId}:`, err);
      await logAgentEvent("ReviseIdeaAgent", "error", `Revision failed: ${err.message}`, topicId, {
        durationMs,
        stackTrace: err.stack
      });
    });
}

import { topicAgent } from "./agents/topicAgents.js";

/**
 * TRIGGER IDEA GENERATOR
 * Spoons up the Idea Agent to generate 3 brand new topics (usually called by a weekly cron job).
 */
export async function triggerIdeaGenerator() {
  console.log(`[Orchestrator] Triggering weekly Idea Generation...`);
  const playbook = await getPlaybook();
  const settings = await getSettings();

  const initialState = {
    settings: settings,
    playbook: playbook,
    pastIdeas: "",
    searchResults: "",
    rawIdeas: [],
    finalTopics: []
  };

  await logAgentEvent("IdeaGenerator", "started", "Began weekly generation of 3 new topics.", undefined, {
    targetGenerationCount: settings.ideasPerGeneration,
    model: settings.modelSelection
  });

  const startTime = Date.now();

  topicAgent.invoke(initialState)
    .then(async () => {
      const durationMs = Date.now() - startTime;
      console.log(`[Orchestrator] Successfully generated new topics!`);
      await logAgentEvent("IdeaGenerator", "success", "Successfully generated and saved new topics.", undefined, {
        durationMs
      });
      // Optional future feature: await sendEmail("3 new topics are ready for your review!");
    })
    .catch(async (err: any) => {
      const durationMs = Date.now() - startTime;
      console.error(`[Orchestrator] Error generating topics:`, err);
      await logAgentEvent("IdeaGenerator", "error", `Topic generation failed: ${err.message}`, undefined, {
        durationMs,
        stackTrace: err.stack
      });
    });
}
