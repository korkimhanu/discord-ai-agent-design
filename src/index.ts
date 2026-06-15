import { startBot } from "./bot.js";

startBot().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
