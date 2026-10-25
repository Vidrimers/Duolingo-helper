import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const required = ["TG_BOT_TOKEN", "ADMIN_TG_ID", "JWT_ENCRYPT_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[config] Missing ${key} in .env`);
    process.exit(1);
  }
}

export const config = {
  tgBotToken: process.env.TG_BOT_TOKEN,
  adminTgId: Number(process.env.ADMIN_TG_ID),
  httpPort: Number(process.env.BOT_HTTP_PORT) || 3777,
  jwtEncryptKey: process.env.JWT_ENCRYPT_KEY || "",
};
