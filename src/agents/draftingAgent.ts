import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { ChatGoogle } from "@langchain/google";
import { createResilientLlm } from "../utils/resilientLlm.js";
import { z } from "zod";
import { db } from "../db/index.js";
import { blogs, topics } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { HumanMessage } from "@langchain/core/messages";

// 1. Define the Agent's Memory/State
const DraftingState = Annotation.Root({
  settings: Annotation<any>(),
  topicId: Annotation<string>(),       
  title: Annotation<string>(),         
  brief: Annotation<string>(),         // Stringified version of the topic record
  playbook: Annotation<string>(),      // The CoreCV brand guidelines
  currentDraft: Annotation<string>(),  // The working draft
  feedback: Annotation<string>({       // Feedback from the Reviewer Agent
    reducer: (x, y) => y ? y : x,
    default: () => ""
  }),      
  revisionCount: Annotation<number>({  // Counter to prevent infinite loops
    reducer: (x, y) => x + y,
    default: () => 0
  }),
  isApproved: Annotation<boolean>(),   
});

// 3. Node: Drafter Agent
async function generateDraft(state: typeof DraftingState.State) {
  console.log(`[Drafter] Writing draft (Revision: ${state.revisionCount})...`);

  // Parse the JSON brief into a human-readable format
  const briefObj = JSON.parse(state.brief);
  const humanReadableBrief = `
TITLE: ${briefObj.title}
POST TYPE: ${briefObj.postType}
PRIMARY KEYWORD: ${briefObj.primaryKeyword}
SECONDARY KEYWORD: ${briefObj.secondaryKeyword}
RESEARCH SIGNAL: ${briefObj.researchSignal}
CORECV CONNECTION: ${briefObj.coreCvConnection}
INTENDED READER: ${briefObj.intendedReader}
CORE ARGUMENT: ${briefObj.coreArgument}
SUPPORTING DATA POINTS:
${briefObj.supportingDataPoints ? briefObj.supportingDataPoints.map((d: string) => `- ${d}`).join('\n') : "None"}
TONE NOTES: ${briefObj.toneNotes}
`;

  const targetLength = state.settings.draftTargetLength || 1500;

  let prompt = `You are the CoreCV Lead Writer. Your job is to draft a comprehensive, highly engaging blog post for a Gen Z job seeker.
Your target word count for this draft is exactly ${targetLength} words.

--- THE HUMAN-READABLE BRIEF ---
${humanReadableBrief}

--- CORECV PLAYBOOK ---
${state.playbook}

--- STRICT WRITING RULES ---

1. OPENING RULES (ENFORCED):
You MUST NEVER open with a question, an affirmation, clichés like "In today's competitive job market," "In this post I will," or definitions.
You MUST open using one of these four permitted openers:
- A surprising statistic with immediate unpacking.
- A named contradiction.
- A direct contrarian statement with the reason immediately following.
- A specific recognisable scenario from the reader's life.

2. STRUCTURE & CTA PLACEMENT:
You must follow the structural template and CTA placement for the specific POST TYPE (${briefObj.postType}):
- Data-Led Explainer: Open with a surprising stat/data point. Unpack what it means and what to do differently. CTA: Place in the final third after the what-to-do section. (1000-1400 words)
- How-To Guide: Open with the problem. Establish credibility. Numbered framework with specific actionable steps. Common mistakes. CTA: Place exactly at the step where CoreCV does the heavy lifting (NOT at the end). Closing. (1200-1800 words)
- Contrarian Take: Open by stating the conventional belief. Explain why people believe it. Provide counter-evidence. Present the CoreCV alternative. How to act on it. CTA: Place at the end after the full argument. Closing. (800-1200 words)
- Trend Report: Open with a named shift in behaviour. Report what's happening (with named sources). Explain the underlying cause. What it means for the reader. CTA: Natural connection indicating CoreCV was built for this shift. (1000-1400 words)
- Comparison Post: Open with the decision the reader is making. Evaluate options across dimensions. Take a clear position for CoreCV and defend it. (1000-1400 words)
- Personal Brand Playbook: Open with the specific desired outcome. Provide a step-by-step framework with real examples. CTA: CoreCV powers the content generation step. (1400-2000 words)

3. SEO & VOICE RULES:
- Point of View: Write in the SECOND PERSON ("you"). Never refer to "job seekers" or "candidates" in the third person.
- Paragraph Length: No paragraph may exceed 4 sentences.
- Keyword Placement: The primary keyword ("${briefObj.primaryKeyword}") MUST appear in the title, in the first 100 words, in at least two subheadings, and in the closing paragraph.
- Subheadings: Must be highly descriptive and specific (e.g., NOT "Step 3", but "Step 3: Match Keywords to JD").
- Links: Every external statistic must be linked to its source. Include at least two internal links to other CoreCV pages/product pages.

4. OUTPUT FORMAT:
Your output MUST start with a YAML frontmatter block containing the Meta Description (exactly 150-160 characters, containing the primary keyword).
Example:
---
metaDescription: "..."
---
# [Post Title]
[Body content...]

As you write, use your Google Search tool to find AT LEAST TWO real, recent statistics or facts to back up the claims. Do not hallucinate data.`;

  if (state.feedback) {
    prompt += `\n\n--- REVIEWER FEEDBACK ---
Your previous draft was rejected by the Editor. Please rewrite the draft, specifically addressing this exact feedback:
${state.feedback}`;
  }

  if (state.currentDraft) {
    prompt += `\n\n--- YOUR PREVIOUS DRAFT ---
Here was your previous draft:

${state.currentDraft}

Please provide the completely revised draft now.`;
  } else {
    prompt += `\n\nPlease write the first draft now.`;
  }

  const drafterLlm = createResilientLlm({
    model: state.settings.modelSelection,
    temperature: state.settings.creativeTemperature || 0.6,
    tools: [{ googleSearch: {} }]
  });

  const response = await drafterLlm.invoke([new HumanMessage(prompt)]);

  return { 
    currentDraft: response.content.toString(),
    revisionCount: 1 
  };
}

// 4. Node: Reviewer Agent
async function reviewDraft(state: typeof DraftingState.State) {
  console.log(`[Reviewer] Evaluating draft...`);

  // Parse brief for reviewer context
  const briefObj = JSON.parse(state.brief);

  const ReviewSchema = z.object({
    checks: z.object({
      noBannedOpeners: z.boolean().describe("Passes if it DOES NOT open with a question, affirmation, or cliché."),
      usesPermittedOpener: z.boolean().describe("Passes if it uses one of the 4 permitted openers (stat, contradiction, contrarian statement, or scenario)."),
      correctPostTypeStructure: z.boolean().describe("Passes if it strictly follows the structural template for this specific Post Type."),
      ctaCorrectlyPlaced: z.boolean().describe("Passes if the CoreCV Connection CTA is in the correct structural position for the Post Type (e.g. at the heavy-lifting step for a How-To)."),
      primaryKeywordPlaced: z.boolean().describe("Passes if primary keyword is in title, first 100 words, 2 subheadings, and closing."),
      metaDescriptionIncluded: z.boolean().describe("Passes if a 150-160 character meta description is in the YAML frontmatter."),
      descriptiveSubheadings: z.boolean().describe("Passes if subheadings are specific and descriptive."),
      statsLinked: z.boolean().describe("Passes if external statistics are linked."),
      internalLinks: z.boolean().describe("Passes if there are at least two internal CoreCV links."),
      paragraphLength: z.boolean().describe("Passes if NO paragraph exceeds 4 sentences."),
      secondPersonVoice: z.boolean().describe("Passes if written strictly in second person ('you')."),
      playbookTone: z.boolean().describe("Passes if tone matches the Gen Z CoreCV Playbook."),
      competitorTest: z.boolean().describe("FINAL TEST: Passes ONLY if this post could NOT appear on a competitor's blog without changing a word. CoreCV perspective must be deeply embedded.")
    }),
    approved: z.boolean().describe("True ONLY if ALL 13 checks pass."),
    feedback: z.string().describe("Actionable feedback naming the EXACT checklist items that failed and how to fix them. Empty if approved.")
  });

  const structuredReviewer = createResilientLlm({
    model: state.settings.modelSelection,
    temperature: 0.1, // always analytical for reviewing
    structuredOutputSchema: ReviewSchema
  });

  const prompt = `You are the CoreCV Editor-in-Chief. Evaluate the following blog post draft against the strict 13-point checklist.

--- BRIEF CONTEXT ---
Title: ${briefObj.title}
Post Type: ${briefObj.postType}
Primary Keyword: ${briefObj.primaryKeyword}
CoreCV Connection: ${briefObj.coreCvConnection}

--- CORECV PLAYBOOK ---
${state.playbook}

--- THE DRAFT ---
${state.currentDraft}

EVALUATION:
Check all 13 criteria strictly. If ANY check fails, 'approved' must be false, and your 'feedback' must specifically name the failed checks.`;

  const response = await structuredReviewer.invoke(prompt);

  console.log(`[Reviewer] Decision: ${response.approved ? "APPROVED" : "REJECTED"}`);
  if (!response.approved) console.log(`[Reviewer] Feedback: ${response.feedback}`);

  return {
    isApproved: response.approved,
    feedback: response.feedback
  };
}

// 5. Conditional Edge Logic
function shouldRevise(state: typeof DraftingState.State) {
  if (state.isApproved) {
    return "saveDraft";
  }
  // Prevent infinite loops: max 3 revisions
  if (state.revisionCount >= 3) {
    console.log("[System] Max revisions reached. Pushing draft through anyway.");
    return "saveDraft";
  }
  return "generateDraft"; // Send back to the Drafter
}

// 6. Node: Save to Database
async function saveDraft(state: typeof DraftingState.State) {
  console.log(`[Database] Saving draft to Neon...`);
  
  try {
    await db.insert(blogs).values({
      topicId: state.topicId,
      title: state.title,
      content: state.currentDraft,
      status: "pending_human", // Ready for Magic Link review
    });
    
    // Optional: Update the topic status so we know it has been drafted
    await db.update(topics)
      .set({ status: "drafted" })
      .where(eq(topics.id, state.topicId));

    console.log(`[Database] Draft saved successfully!`);
  } catch (error) {
    console.error("Failed to save draft:", error);
    throw new Error("Database insertion failed");
  }

  return {};
}

// 7. Build the LangGraph Workflow
const workflow = new StateGraph(DraftingState)
  .addNode("generateDraft", generateDraft)
  .addNode("reviewDraft", reviewDraft)
  .addNode("saveDraft", saveDraft)
  .addEdge("__start__", "generateDraft")
  .addEdge("generateDraft", "reviewDraft")
  .addConditionalEdges("reviewDraft", shouldRevise)
  .addEdge("saveDraft", END);

export const draftingAgent = workflow.compile();
