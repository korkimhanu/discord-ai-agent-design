import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "./config.js";

const commands = [
  new SlashCommandBuilder()
    .setName("repo")
    .setDescription("현재 Discord 세션에 GitHub repo를 연결합니다.")
    .addStringOption((option) => option.setName("name").setDescription("owner/repo").setRequired(true)),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("현재 Discord 세션의 모델을 선택합니다.")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("auto, strong, balanced, cheap 또는 직접 모델명")
        .setRequired(true)
        .addChoices(
          { name: "auto", value: "auto" },
          { name: "strong", value: "strong" },
          { name: "balanced", value: "balanced" },
          { name: "cheap", value: "cheap" },
          { name: "codex", value: "codex" },
          { name: "claude-code", value: "claude-code" }
        )
    ),
  new SlashCommandBuilder()
    .setName("agent")
    .setDescription("현재 Discord 세션의 코딩 실행기를 선택합니다.")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("api, claude-code, codex, auto")
        .setRequired(true)
        .addChoices(
          { name: "api", value: "api" },
          { name: "claude-code", value: "claude-code" },
          { name: "codex", value: "codex" },
          { name: "auto", value: "auto" }
        )
    ),
  new SlashCommandBuilder().setName("status").setDescription("현재 세션 설정을 확인합니다."),
  new SlashCommandBuilder().setName("memory").setDescription("현재 세션의 요약 메모리와 최근 대화를 확인합니다.")
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(config.discordToken);

if (config.discordGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: commands });
  console.log(`Registered guild commands for ${config.discordGuildId}`);
} else {
  await rest.put(Routes.applicationCommands(config.discordClientId), { body: commands });
  console.log("Registered global commands");
}
