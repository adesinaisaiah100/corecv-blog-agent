import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { ChatGoogle } from "@langchain/google";
import { z } from "zod";
import { db } from "../db/index.js";
import { topics } from "../db/schema.js";
import { eq } from "drizzle-orm";

// 1. Define State
const ReviseState = Annotation.Root({
  settings: Annotation<any>(),
  topicId: Annotation<string>(),
  originalBrief: Annotation<any>(),
  feedback: Annotation<string>(),
  playbook: Annotation<string>(),
  revisedBrief: Annotation<any>(),
});

// 3. Node: Fetch Feedback and Topic
async function fetchTopicForRevision(state: typeof ReviseState.State) {
  console.log(`[ReviseIdeaAgent] Fetching topic ${state.topicId} for revision...`);

  const topicRecord = await db.query.topics.findFirst({
    where: eq(topics.id, state.topicId)
  });

  if (!topicRecord) {
    throw new Error(`Topic ${state.topicId} not found.`);
  }

  // Build the original brief to pass to the LLM
  const originalBrief = {
    title: topicRecord.title,
    postType: topicRecord.postType,
    primaryKeyword: topicRecord.primaryKeyword,
    secondaryKeyword: topicRecord.secondaryKeyword,
    researchSignal: topicRecord.researchSignal,
    coreCvConnection: topicRecord.coreCvConnection,
    coreArgument: topicRecord.coreArgument,
    intendedReader: topicRecord.intendedReader,
    supportingDataPoints: topicRecord.supportingDataPoints,
    toneNotes: topicRecord.toneNotes,
    scoreBreakdown: topicRecord.scoreBreakdown
  };

  return {
    originalBrief,
    feedback: topicRecord.feedback || "No specific feedback provided, please just try another angle."
  };
}

// 4. Node: Revise the Idea
async function reviseIdea(state: typeof ReviseState.State) {
  console.log(`[ReviseIdeaAgent] Revising idea based on feedback: "${state.feedback}"`);

  const SingleBriefSchema = z.object({
    title: z.string(),
    postType: z.enum(["Data-Led Explainer", "How-To Guide", "Contrarian Take", "Trend Report", "Comparison Post", "Personal Brand Playbook"]),
    primaryKeyword: z.string(),
    secondaryKeyword: z.string(),
    researchSignal: z.string(),
    coreCvConnection: z.string(),
    coreArgument: z.string(),
    intendedReader: z.string(),
    supportingDataPoints: z.array(z.string()).min(2),
    toneNotes: z.string(),
    scoreBreakdown: z.object({
      trendMomentum: z.number(),
      searchIntentMatch: z.number(),
      competitionGap: z.number(),
      coreCvAngleStrength: z.number(),
      conversionPotential: z.number()
    })
  });

  const analyticalLlm = new ChatGoogle({
    model: state.settings.modelSelection || "gemini-2.5-flash-lite",
    temperature: 0.3,
  });

  const structuredLlm = analyticalLlm.withStructuredOutput(SingleBriefSchema);

  const prompt = `You are the CoreCV Idea Agent. A human editor rejected your previous blog topic idea and left specific feedback.
Your task is to rewrite the idea entirely to address their feedback, while still strictly adhering to the CoreCV Playbook.

--- PLAYBOOK ---
${state.playbook}

--- ORIGINAL IDEA BRIEF ---
${JSON.stringify(state.originalBrief, null, 2)}

--- EDITOR'S FEEDBACK ---
"${state.feedback}"

INSTRUCTIONS:
1. Read the Editor's feedback carefully. If they asked for a different angle, a different post type, or a different core connection, make those changes.
2. Ensure the revised idea still connects strongly to a specific CoreCV feature.
3. Rescore the revised idea using the standard 5-dimension rubric.

Provide the newly revised brief now.`;

  const revisedIdea = await structuredLlm.invoke(prompt);

  return { revisedBrief: revisedIdea };
}

// 5. Node: Save Back to Database
async function saveRevisedIdea(state: typeof ReviseState.State) {
  console.log(`[ReviseIdeaAgent] Saving revised topic to database...`);
  
  const b = state.revisedBrief;
  
  // Calculate weighted score
  const weightedTotal = 
      (b.scoreBreakdown.trendMomentum * 0.15) +
      (b.scoreBreakdown.searchIntentMatch * 0.15) +
      (b.scoreBreakdown.competitionGap * 0.20) +
      (b.scoreBreakdown.coreCvAngleStrength * 0.30) +
      (b.scoreBreakdown.conversionPotential * 0.20);
      
  b.scoreBreakdown.weightedTotal = Number(weightedTotal.toFixed(2));

  await db.update(topics).set({
    title: b.title,
    description: b.coreArgument,
    status: "pending_review", // Push back to the human for review!
    feedback: null, // Clear the feedback since we addressed it
    postType: b.postType,
    primaryKeyword: b.primaryKeyword,
    secondaryKeyword: b.secondaryKeyword,
    researchSignal: b.researchSignal,
    coreCvConnection: b.coreCvConnection,
    coreArgument: b.coreArgument,
    intendedReader: b.intendedReader,
    supportingDataPoints: b.supportingDataPoints,
    toneNotes: b.toneNotes,
    scoreBreakdown: b.scoreBreakdown
  }).where(eq(topics.id, state.topicId));

  console.log(`[ReviseIdeaAgent] Topic ${state.topicId} revised successfully! Status is now pending_review.`);
  return {};
}

// 6. Build the LangGraph Workflow
const workflow = new StateGraph(ReviseState)
  .addNode("fetchTopicForRevision", fetchTopicForRevision)
  .addNode("reviseIdea", reviseIdea)
  .addNode("saveRevisedIdea", saveRevisedIdea)
  .addEdge("__start__", "fetchTopicForRevision")
  .addEdge("fetchTopicForRevision", "reviseIdea")
  .addEdge("reviseIdea", "saveRevisedIdea")
  .addEdge("saveRevisedIdea", END);

export const reviseIdeaAgent = workflow.compile();
