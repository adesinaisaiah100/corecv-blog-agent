# CoreCV Blog Agent Architecture

This diagram illustrates the complete, updated architecture we designed. It highlights the GitHub Actions scheduling, the Railway/Hono backend, the Neon database, the LangGraph + Gemini agent interactions, and the Magic Link human review process.

```mermaid
graph TD
    %% Styling
    classDef trigger fill:#3C3489,stroke:#AFA9EC,color:#fff
    classDef server fill:#444441,stroke:#B4B2A9,color:#fff
    classDef db fill:#712B13,stroke:#F0997B,color:#fff
    classDef agent fill:#085041,stroke:#5DCAA5,color:#fff
    classDef external fill:#0C447C,stroke:#85B7EB,color:#fff
    classDef user fill:#633806,stroke:#EF9F27,color:#fff

    %% Components
    subgraph Scheduling
        Cron["GitHub Actions<br/>(Cron Triggers)"]:::trigger
    end

    subgraph Hosting [Railway Container - Node.js]
        Hono["Hono API Server"]:::server
        Agent["LangGraph + Gemini<br/>(AI Agents)"]:::agent
    end

    subgraph Storage
        DB[("Neon PostgreSQL<br/>(via Drizzle ORM)")]:::db
    end

    subgraph External Services
        Resend["Resend<br/>(Email API)"]:::external
        Tavily["Tavily<br/>(Search API)"]:::external
        CoreCV["CoreCV Website<br/>(Vercel / Next.js)"]:::external
    end

    subgraph Human Review
        Inbox["User Email Inbox"]:::user
        Browser["Magic Link Webpage<br/>(Served by Hono)"]:::user
    end

    %% Flows
    %% 1. Topic Generation
    Cron -- "1. POST /generate-topics" --> Hono
    Hono -- "2. Triggers" --> Agent
    Agent -- "3. Read Global Rules" --> DB
    Agent -- "4. Save Topics" --> DB
    Agent -- "5. Send Email with URL" --> Resend
    Resend -- "6. Delivers Email" --> Inbox

    %% 2. Magic Link Review
    Inbox -- "7. Clicks Magic Link" --> Browser
    Browser -- "8. GET /review/..." --> Hono
    Hono -. "Fetches Content" .-> DB
    Hono -- "9. Returns HTML Page" --> Browser
    Browser -- "10. Clicks [Approve]" --> Hono
    Hono -- "11. UPDATE status = 'approved'" --> DB

    %% 3. Draft Generation
    Cron -- "12. POST /generate-drafts" --> Hono
    Hono -- "13. Triggers" --> Agent
    Agent -- "14. Research" --> Tavily
    Agent -- "15. Writes & Saves Draft" --> DB
    Agent -- "16. Send Magic Link" --> Resend

    %% 4. Publishing Queue
    Cron -- "17. POST /publish" --> Hono
    Hono -- "18. Fetch oldest 'approved_for_publishing'" --> DB
    Hono -- "19. POST New Blog" --> CoreCV
    Hono -- "20. UPDATE status = 'published'" --> DB
```
