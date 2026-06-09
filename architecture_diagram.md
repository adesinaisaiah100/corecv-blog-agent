# CoreCV Blog Agent Architecture (Final)

Below is the complete, high-level Mermaid flowchart depicting the entire autonomous system we built across Phases 1, 2, and 3.

```mermaid
graph TD
    %% Define Styles
    classDef human fill:#ffccd5,stroke:#ff4d6d,stroke-width:2px,color:#000
    classDef cron fill:#caf0f8,stroke:#0077b6,stroke-width:2px,color:#000
    classDef server fill:#d8f3dc,stroke:#2d6a4f,stroke-width:2px,color:#000
    classDef db fill:#fcf6bd,stroke:#d4a373,stroke-width:2px,color:#000
    classDef ai fill:#e0c3fc,stroke:#7b2cbf,stroke-width:2px,color:#000
    classDef external fill:#ffd6a5,stroke:#fd974f,stroke-width:2px,color:#000

    %% Actors & Triggers
    Human((Human Reviewer)):::human
    GitHubActions[GitHub Actions / CRON]:::cron

    %% Server / Orchestrator
    subgraph Core Server [Hono / TypeScript Server]
        Auth[Verify Bearer Token]:::server
        Admin[Admin Dashboard UI]:::server
        API_Gen[/api/cron/generate]:::server
        API_Pub[/api/cron/publish]:::server
        API_Not[/api/cron/notify]:::server
        Orchestrator{Task Orchestrator}:::server
    end

    %% Database Layer
    subgraph NeonDB [PostgreSQL Database]
        DB_Settings[(app_settings)]:::db
        DB_Topics[(topics)]:::db
        DB_Blogs[(blogs)]:::db
        DB_Logs[(agent_logs)]:::db
        DB_KB[(knowledge_base)]:::db
    end

    %% Agents Layer
    subgraph AI Agents [LangGraph + Gemini 2.5]
        Agent_Idea[Idea Generator Agent]:::ai
        Agent_Revise[Idea Reviser Agent]:::ai
        Agent_Draft[Drafting Agent]:::ai
    end

    %% External APIs
    Resend[Resend API]:::external
    LangSmith[LangSmith Tracing]:::external
    MainAppAPI[Main App API / CMS]:::external

    %% --- CONNECTIONS ---

    %% 1. Notification Flow (Daily)
    GitHubActions -- "cron-notify.yml (9AM, 5PM)" --> Auth
    Auth --> API_Not
    API_Not -- "Count pending drafts & ideas" --> NeonDB
    API_Not -- "Send HTML Digest" --> Resend
    Resend -- "Email Alert" --> Human

    %% 2. Generation Flow (Friday)
    GitHubActions -- "cron-generate.yml (Fri 12PM)" --> Auth
    Auth --> API_Gen
    API_Gen -- "Buffer Math < Target" --> DB_Topics
    API_Gen --> Orchestrator
    Orchestrator -- "Trigger" --> Agent_Idea
    Agent_Idea -- "Read Playbooks & Settings" --> NeonDB
    Agent_Idea -- "Write new Ideas" --> DB_Topics

    %% 3. Human Review Flow
    Human -- "Clicks Admin Dashboard URL" --> Admin
    Admin -- "Updates LLM Settings" --> DB_Settings
    Admin -- "Approves Idea" --> Orchestrator
    Admin -- "Rejects Idea + Feedback" --> Orchestrator
    
    Orchestrator -- "Trigger Draft" --> Agent_Draft
    Orchestrator -- "Trigger Revision" --> Agent_Revise
    
    Agent_Draft -- "Writes Full Blog" --> DB_Blogs
    Agent_Revise -- "Updates Idea" --> DB_Topics

    %% 4. Publishing Flow (MWF)
    GitHubActions -- "cron-publish.yml (Mon/Wed/Fri 9AM)" --> Auth
    Auth --> API_Pub
    API_Pub -- "Fetch Approved Drafts" --> DB_Blogs
    API_Pub -- "POST Draft" --> MainAppAPI

    %% 5. Global Logging
    AI Agents -. "Automatic Telemetry" .-> LangSmith
    Orchestrator -- "Write execution logs" --> DB_Logs
```
