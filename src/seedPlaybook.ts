import { db } from "./db/index.js";
import { knowledgeBase } from "./db/schema.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("Reading playbook.md...");
  
  // Read the markdown file from the root of the project
  const playbookPath = path.resolve(__dirname, "../playbook.md");
  
  if (!fs.existsSync(playbookPath)) {
    console.error("❌ playbook.md not found in the root directory!");
    process.exit(1);
  }

  const playbookContent = fs.readFileSync(playbookPath, "utf-8");

  console.log("Saving to Neon Database...");

  try {
    // We use an upsert so you can run this script again whenever you update the playbook
    await db.insert(knowledgeBase)
      .values({
        type: "corecv_playbook",
        content: playbookContent,
      })
      .onConflictDoUpdate({
        target: knowledgeBase.type,
        set: { content: playbookContent, updatedAt: new Date() }
      });

    console.log("✅ Playbook successfully saved to the database!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to save playbook:", error);
    process.exit(1);
  }
}

main();
