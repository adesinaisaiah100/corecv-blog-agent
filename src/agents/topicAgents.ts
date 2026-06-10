import { StateGraph, Annotation } from "@langchain/langgraph";
import { ChatGoogle } from "@langchain/google";
import { z } from "zod";
import { db } from "../db/index.js";
import { HumanMessage } from "@langchain/core/messages";
import { gte } from "drizzle-orm";

import { topics } from "../db/schema.js";

// 1. Define the Agent's Memory/State
const AgentState = Annotation.Root({
  settings: Annotation<any>(),
  playbook: Annotation<string>(),
  pastIdeas: Annotation<string>(),
  searchResults: Annotation<string>(), 
  rawIdeas: Annotation<any[]>(),
  finalTopics: Annotation<any[]>(),
});

// 2.5 Node: Fetch Past Ideas
async function fetchPastIdeas(state: typeof AgentState.State) {
  console.log("Fetching past ideas to prevent duplication...");
  
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const recentTopics = await db.query.topics.findMany({
      where: gte(topics.createdAt, sixMonthsAgo),
      columns: {
        title: true,
        description: true
      }
    });

    if (recentTopics.length === 0) {
      return { pastIdeas: "No recent topics found. You have a blank slate." };
    }

    const formattedIdeas = recentTopics
      .map(t => `- Title: ${t.title}\n  Core Argument: ${t.description}`)
      .join("\n\n");

    return { pastIdeas: formattedIdeas };
  } catch (error) {
    console.error("Failed to fetch past ideas:", error);
    return { pastIdeas: "Error fetching past topics. Try to be as original as possible." };
  }
}

// 3. Node: Search Web using Native Google Search Grounding
async function searchSignals(state: typeof AgentState.State) {
  console.log("Searching Google for real-world signals...");
  
  try {
    const prompt = `You are the research assistant for CoreCV's blog idea pipeline. Your job is to search for current, real-world signals that would make strong blog topics for a career platform targeting Gen Z job seekers globally.

Search the following categories and return what you find: career and job search trend reports from 2023 and 2026( yo can refrence old reports to do a comparison if needed) — particularly from Zety, LinkedIn Talent Solutions, Indeed Hiring Lab, and Glassdoor Economic Research. Search for recent survey data on how Gen Z is using social media for job searching — specifically TikTok, Instagram, and LinkedIn. Search for widespread pain points in job seeking communities — look at Reddit communities like r/jobs and r/cscareerquestions, and search for what people are currently complaining about or asking about. Search for emerging behaviours in hiring — things recruiters are doing differently, ATS trends, ghost rate data, and AI tool adoption among job seekers.

For each signal you find, record: what it is, where you found it, the year it is from, and why it is significant for someone who is job searching right now.

Return everything you found as a structured list of signals. You are not generating ideas yet. You are collecting raw material.`;

    // Create a specific LLM just for searching, natively bound to Google Search!
    const searchLlm = new ChatGoogle({
      model: state.settings.modelSelection || "gemini-2.5-flash-lite",
      temperature: 0.2,
    }).bindTools([{ googleSearch: {} }]);

    let allResults = "";
    // Loop based on researchDepth setting
    const depth = state.settings.researchDepth || 5;
    for (let i = 0; i < depth; i++) {
      const response = await searchLlm.invoke([
        new HumanMessage(prompt + `\n\nThis is search iteration ${i + 1} of ${depth}. Try to find different signals than before.`)
      ]);
      allResults += response.content.toString() + "\n\n";
    }
    
    return { searchResults: allResults };
  } catch (error) {
    console.error("Google Search failed:", error);
    return { searchResults: "Live search failed. Relying on baseline knowledge of 2025/2026 Gen Z career trends." };
  }
}

// 4. Node: Generate 12 Rich Ideas
async function generateIdeas(state: typeof AgentState.State) {
  console.log("Generating 12 rich ideas based on signals...");
  
  const IdeaSchema = z.object({
    ideas: z.array(z.object({
      title: z.string(),
      researchSignal: z.string(),
       coreCvConnection: z.string(),
      intendedReader: z.string(),
      coreArgument: z.string()
    })).length(12)
  });

  const creativeLlm = new ChatGoogle({
    model: state.settings.modelSelection || "gemini-2.5-flash-lite",
    temperature: state.settings.creativeTemperature || 0.7,
  });

  const structuredLlm = creativeLlm.withStructuredOutput(IdeaSchema);

  const prompt = `You are the CoreCV Idea Agent. You have two inputs: the CoreCV brand playbook, which defines who CoreCV is, what features it has, and what the blog is trying to accomplish — and a set of fresh research signals you just retrieved from real sources.

Your task is to generate exactly 12 blog topic ideas. Every idea must be grounded in at least one of the research signals you retrieved — not in what you already know from training data. If a research signal is too thin to support a full post, do not use it.

CRITICAL INSTRUCTION ON DUPLICATION:
Here are the topics we have covered in the last 6 months:
${state.pastIdeas}

You MUST NOT generate any idea that makes the exact same core argument or targets the exact same angle as these past ideas. You can discuss similar themes, but the core argument must be demonstrably new.

For every idea you generate, include five things. First, the proposed post title — specific, not generic, between 50 and 65 characters. Second, the research signal that prompted this idea — describe it briefly and name the source. Third, the specific CoreCV feature or value this topic connects to — name it explicitly from the feature map in the playbook. Do not describe the connection vaguely. Name the feature. Fourth, who this post is for — one sentence describing the specific reader. Fifth, the core argument the post would make — one or two sentences, not a summary of the topic but the actual claim the post would argue.

Before including any idea in your list, run the CoreCV connection test: can you name a specific CoreCV feature or value that connects genuinely to this topic? If the connection feels forced or vague, discard the idea and find another. A post that could appear on any career blog without mentioning CoreCV is not a CoreCV post.

Generate 12 ideas. Not 11 or 13. Apply the connection test to every one.

--- PLAYBOOK ---
${state.playbook}

--- RESEARCH SIGNALS ---
${state.searchResults}`;

  const response = await structuredLlm.invoke(prompt);
  return { rawIdeas: response.ideas };
}

// 5. Node: Score and Pick Top 3
async function pickTopThree(state: typeof AgentState.State) {
  console.log("Applying rubric and picking top 3...");
  
  const BriefSchema = z.object({
    top3: z.array(z.object({
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
    })).length(3)
  });

  const analyticalLlm = new ChatGoogle({
    model: state.settings.modelSelection || "gemini-2.5-flash-lite",
    temperature: 0.2, // always analytical for scoring
  });

  const structuredLlm = analyticalLlm.withStructuredOutput(BriefSchema);

  const prompt = `You are the CoreCV Idea Agent. You have generated 12 blog topic ideas. Your task now is to score each one using the five-dimension rubric below and select the top three.

Apply this rubric to every idea. Score each dimension from 1 to 5 using the guidance provided.

Trend Momentum — weight 15%. Score a 5 if the research signal is from 2024 or 2025, the behaviour is accelerating, and multiple sources confirm it. Score lower if the data is older, the trend is slowing, or only one source supports it.

Search Intent Match — weight 15%. Score a 5 if the topic clearly matches what a specific job seeker would type into a search engine right now. The topic should be specific enough to attract the right reader but broad enough that real people are actually searching for it. Score lower if the topic is too vague to rank for anything or too niche for meaningful search volume.

Competition Gap — weight 20%. Score a 5 if existing content on this specific angle is thin, outdated (written before 2024), generic, or only covers the surface. CoreCV should be able to write the most useful and specific post on this topic that currently exists. Score lower if major career publications have already covered this thoroughly and recently.

CoreCV Angle Strength — weight 30%. This is the most important dimension. Score a 5 if a specific CoreCV feature or value connects directly and genuinely to this topic — where the connection adds real value to the reader, not just a product mention at the end. The post should feel incomplete without the CoreCV connection. Score lower if the connection is vague, forced, or could be removed without the post losing meaning.

Conversion Potential — weight 20%. Score a 5 if a reader who finishes this post has a clear and logical reason to try CoreCV immediately. The post should create problem awareness and position CoreCV as the natural solution. Score lower if the post is informative but leaves the reader with no particular reason to act.

Apply this rule before finalising your selection: any idea that scores below 2 on CoreCV Angle Strength must be discarded regardless of its score.

From the ideas that pass the filter, select the three with the highest scoring potential based on the rubric.

For each of the three selected topics, produce a complete brief containing: the title, the post type, the primary keyword, the secondary keyword, the research signal with source name and year, the specific CoreCV feature connection named explicitly, the core argument in two sentences, the intendedReader in one sentence, at least two supporting data points with sources, tone notes for the Drafting Agent, and the full score breakdown showing each dimension. Do NOT calculate the weighted total; the system will calculate that.

--- PLAYBOOK ---
${state.playbook}

--- 12 IDEAS TO SCORE ---
${JSON.stringify(state.rawIdeas, null, 2)}`;

  const response = await structuredLlm.invoke(prompt);

  const finalWithScores = response.top3.map(topic => {
    const scores = topic.scoreBreakdown;
    const weightedTotal = 
      (scores.trendMomentum * 0.15) +
      (scores.searchIntentMatch * 0.15) +
      (scores.competitionGap * 0.20) +
      (scores.coreCvAngleStrength * 0.30) +
      (scores.conversionPotential * 0.20);
    
    return {
      ...topic,
      scoreBreakdown: {
        ...scores,
        weightedTotal: Number(weightedTotal.toFixed(2))
      }
    };
  });

  return { finalTopics: finalWithScores };
}

// 6. Node: Save to Neon Database
async function saveToDatabase(state: typeof AgentState.State) {
  console.log("Saving full briefs to database...");
  
  try {
    const insertData = state.finalTopics.map(t => ({
      title: t.title,
      description: t.coreArgument,
      status: "pending_review",
      postType: t.postType,
      primaryKeyword: t.primaryKeyword,
      secondaryKeyword: t.secondaryKeyword,
      researchSignal: t.researchSignal,
      coreCvConnection: t.coreCvConnection,
      coreArgument: t.coreArgument,
      intendedReader: t.intendedReader,
      supportingDataPoints: t.supportingDataPoints,
      toneNotes: t.toneNotes,
      scoreBreakdown: t.scoreBreakdown
    }));

    await db.insert(topics).values(insertData);
    console.log("Successfully saved 3 fully researched briefs to Neon!");
  } catch (error) {
    console.error("Database save failed:", error);
    throw new Error("Failed to save the briefs to the Neon database.");
  }
  
  return {};
}

// 7. Build the LangGraph Workflow
const workflow = new StateGraph(AgentState)
  .addNode("fetchPastIdeas", fetchPastIdeas)
  .addNode("searchSignals", searchSignals)
  .addNode("generateIdeas", generateIdeas)
  .addNode("pickTopThree", pickTopThree)
  .addNode("saveToDatabase", saveToDatabase)
  .addEdge("__start__", "fetchPastIdeas")
  .addEdge("fetchPastIdeas", "searchSignals")
  .addEdge("searchSignals", "generateIdeas")
  .addEdge("generateIdeas", "pickTopThree")
  .addEdge("pickTopThree", "saveToDatabase")
  .addEdge("saveToDatabase", "__end__");

export const topicAgent = workflow.compile();
