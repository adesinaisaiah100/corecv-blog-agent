import { pgTable, text, timestamp, uuid, jsonb, boolean, integer, real } from "drizzle-orm/pg-core";

// --- TOPICS TABLE ---
// Status: "pending_review", "approved", "dropped"
export const topics = pgTable("topics", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending_review"),
  feedback: text("feedback"),
  postType: text("post_type"),
  primaryKeyword: text("primary_keyword"),
  secondaryKeyword: text("secondary_keyword"),
  researchSignal: text("research_signal"),
  coreCvConnection: text("corecv_connection"),
  coreArgument: text("core_argument"),
  intendedReader: text("intended_reader"),
  supportingDataPoints: jsonb("supporting_data_points"),
  toneNotes: text("tone_notes"),
  scoreBreakdown: jsonb("score_breakdown"),
  createdAt: timestamp("created_at").defaultNow(),
});

// --- BLOGS (DRAFTS) TABLE ---
// Status: "pending_human", "approved_for_publishing", "published"
export const blogs = pgTable("blogs", {
  id: uuid("id").primaryKey().defaultRandom(),
  topicId: uuid("topic_id").references(() => topics.id),
  title: text("title").notNull(),
  content: text("content").notNull(), // The full markdown/html content
  status: text("status").notNull().default("pending_human"),
  feedback: text("feedback"),
  createdAt: timestamp("created_at").defaultNow(),
});

// --- KNOWLEDGE BASE TABLE ---
// Type: e.g. "media_playbook", "style_guide"
export const knowledgeBase = pgTable("knowledge_base", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull().unique(),
  content: text("content").notNull(), // The large set of rules for the AI
  updatedAt: timestamp("updated_at").defaultNow(),
});

// --- GLOBAL SETTINGS TABLE ---
// A single-row table to hold global config state
export const appSettings = pgTable("app_settings", {
  id: uuid("id").primaryKey().defaultRandom(), // We'll just ensure only one row exists
  autoApproveIdeas: boolean("auto_approve_ideas").notNull().default(false),
  autoPublishDrafts: boolean("auto_publish_drafts").notNull().default(false),
  targetBuffer: integer("target_buffer").notNull().default(6),
  ideasPerGeneration: integer("ideas_per_generation").notNull().default(3),
  modelSelection: text("model_selection").notNull().default("gemini-2.5-flash"),
  creativeTemperature: real("creative_temperature").notNull().default(0.7),
  draftTargetLength: integer("draft_target_length").notNull().default(1500),
  researchDepth: integer("research_depth").notNull().default(5),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// --- AGENT SYSTEM LOGS TABLE ---
// Observability: tracking agent start, success, and errors
export const agentLogs = pgTable("agent_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  topicId: uuid("topic_id"), // Optional: which topic was it working on?
  agentName: text("agent_name").notNull(), // e.g. "Drafter", "IdeaGenerator"
  status: text("status").notNull(), // "started", "success", "error", "info"
  message: text("message").notNull(),
  metadata: jsonb("metadata"), // Flexible JSON for metrics, errors, models
  createdAt: timestamp("created_at").defaultNow(),
});
