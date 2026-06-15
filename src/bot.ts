import {
  ActionRowBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  TextChannel,
  ThreadChannel
} from "discord.js";
import crypto from "node:crypto";
import { config } from "./config.js";
import { ModelRouter } from "./models.js";
import { Store } from "./store.js";
import type { Job } from "./types.js";
import { Worker } from "./worker.js";

export async function startBot(): Promise<void> {
  const store = new Store();
  await store.load();
  const models = new ModelRouter();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
  });

  const worker = new Worker(store, models, async (id) => {
    const channel = await client.channels.fetch(id);
    if (!channel || !("send" in channel)) throw new Error(`Cannot send to channel ${id}`);
    return channel as TextChannel | ThreadChannel;
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`Logged in as ${ready.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      console.log(
        `interaction ${interaction.type} command=${interaction.isChatInputCommand() ? interaction.commandName : "n/a"} user=${interaction.user.id} channel=${interaction.channelId}`
      );
      if (interaction.isChatInputCommand()) await handleSlash(interaction, store);
      if (interaction.isButton()) await handleButton(interaction, store, worker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (interaction.isRepliable()) {
        await interaction.reply({ content: `오류: ${message}`, ephemeral: true }).catch(() => undefined);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return;
      console.log(
        `message guild=${message.guildId ?? "dm"} channel=${message.channelId} author=${message.author.id} mentioned=${client.user?.id ? message.mentions.users.has(client.user.id) : false} length=${message.content.length}`
      );
      if (!shouldRespond(message, client.user?.id)) return;
      const sessionKey = makeSessionKey(message);
      const session = store.getSession(sessionKey);
      const content = cleanMention(message.content, client.user?.id).trim();
      if (!content) return;
      await store.appendMessage(sessionKey, { role: "user", text: content });
      const memoryContext = store.buildMemoryContext(sessionKey);
      if (!session.repo && (looksLikeCodingRequest(content) || looksLikeRepoReadRequest(content))) {
        await message.reply("먼저 `/repo owner/name`으로 작업할 GitHub repo를 설정하세요.");
        return;
      }
      if ((looksLikeCodingRequest(content) || looksLikeRepoReadRequest(content)) && session.repo) {
        const kind = looksLikeCodingRequest(content) ? "change" : "analysis";
        const now = new Date().toISOString();
        const job: Job = {
          id: crypto.randomBytes(4).toString("hex"),
          sessionKey,
          channelId: message.channelId,
          threadId: message.channel.isThread() ? message.channel.id : undefined,
          userId: message.author.id,
          repo: session.repo,
          prompt: content,
          kind,
          memoryContext,
          model: session.model,
          agent: session.agent,
          status: "queued",
          createdAt: now,
          updatedAt: now
        };
        await message.reply(`작업을 큐에 넣었습니다. kind=${kind}, job=${job.id}`);
        await worker.enqueue(job);
        return;
      }

      const pending = await message.reply("생각 중...");
      const typing = startTyping(message);
      try {
        const reply = await models.complete({
          model: session.model,
          system: "You are a concise Korean assistant inside Discord. Use session memory to preserve context. Keep replies practical.",
          prompt: `${memoryContext}\n\nCurrent user message:\n${content}`
        });
        await pending.edit(reply.text.slice(0, 1900) || "응답이 비어 있습니다.");
        await store.appendMessage(sessionKey, { role: "assistant", text: reply.text.slice(0, 4000) });
      } finally {
        clearInterval(typing);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await message.reply(`처리 중 오류: ${text.slice(0, 1500)}`).catch(() => undefined);
    }
  });

  await client.login(config.discordToken);
}

async function handleSlash(interaction: ChatInputCommandInteraction, store: Store): Promise<void> {
  const key = makeInteractionSessionKey(interaction);
  const command = interaction.commandName;
  if (command === "repo") {
    const repo = interaction.options.getString("name", true);
    await store.updateSession(key, { repo });
    await interaction.reply({ content: `현재 세션 repo: \`${repo}\``, ephemeral: true });
    return;
  }
  if (command === "model") {
    const model = interaction.options.getString("name", true);
    await store.updateSession(key, { model });
    await interaction.reply({ content: `현재 세션 모델: \`${model}\``, ephemeral: true });
    return;
  }
  if (command === "agent") {
    const agent = interaction.options.getString("name", true);
    await store.updateSession(key, { agent });
    await interaction.reply({ content: `현재 세션 에이전트: \`${agent}\``, ephemeral: true });
    return;
  }
  if (command === "status") {
    const session = store.getSession(key);
    await interaction.reply({
      content: [
        `repo=${session.repo ?? "unset"}`,
        `model=${session.model}`,
        `agent=${session.agent}`,
        `memory_messages=${session.messages?.length ?? 0}`,
        `summary_chars=${session.summary.length}`
      ].join("\n"),
      ephemeral: true
    });
  }
  if (command === "memory") {
    const memory = store.buildMemoryContext(key).slice(0, 1900);
    await interaction.reply({ content: `\`\`\`text\n${memory}\n\`\`\``, ephemeral: true });
  }
}

async function handleButton(interaction: ButtonInteraction, store: Store, worker: Worker): Promise<void> {
  const [action, jobId] = interaction.customId.split(":");
  const job = store.getJob(jobId);
  if (!job) {
    await interaction.reply({ content: "알 수 없는 job입니다.", ephemeral: true });
    return;
  }
  if (interaction.user.id !== job.userId) {
    await interaction.reply({ content: "이 작업을 만든 사용자만 승인할 수 있습니다.", ephemeral: true });
    return;
  }
  if (action === "reject") {
    await store.updateJob(jobId, { status: "failed", error: "Rejected by user" });
    await interaction.update({ content: `job=${jobId} 거절됨`, components: [] });
    return;
  }
  await interaction.update({
    content: `job=${jobId} 승인됨. patch 적용, 테스트, push, PR 생성을 진행합니다.`,
    components: []
  });
  const result = await worker.approve(jobId);
  await interaction.followUp(result.prUrl ? `PR 생성 완료: ${result.prUrl}` : `job=${jobId} 완료`);
}

function shouldRespond(message: Message, botId?: string): boolean {
  if (!botId) return false;
  if (message.mentions.users.has(botId)) return true;
  if (message.channel.isThread()) return true;
  return config.autoReplyChannels.includes(message.channelId);
}

function cleanMention(content: string, botId?: string): string {
  return botId ? content.replace(new RegExp(`<@!?${botId}>`, "g"), "") : content;
}

function looksLikeCodingRequest(content: string): boolean {
  return /(고쳐|수정|구현|추가|삭제|변경|패치|만들|만드|전환|변환|붙여|연동|배포|올려|링크|웹\s*버전|web\s*버전|웹으로|compose\s*multiplatform|multiplatform|테스트\s*돌|빌드\s*돌|PR|버그\s*고|fix|implement|create|make|add|change|convert|migrate|deploy|publish|link|patch|build|test)/i.test(content);
}

function looksLikeRepoReadRequest(content: string): boolean {
  return /(레포|repo|깃헙|github|프로젝트|코드).*(분석|알려|설명|요약|뭐|무슨|구조|파악|review|analy|explain|summar)/i.test(content);
}

function makeSessionKey(message: Message): string {
  const thread = message.channel.isThread() ? message.channel.id : message.channelId;
  return `${message.guildId ?? "dm"}:${thread}:${message.author.id}`;
}

function makeInteractionSessionKey(interaction: ChatInputCommandInteraction): string {
  return `${interaction.guildId ?? "dm"}:${interaction.channelId}:${interaction.user.id}`;
}

function startTyping(message: Message): NodeJS.Timeout {
  if ("sendTyping" in message.channel) {
    void message.channel.sendTyping().catch(() => undefined);
  }
  return setInterval(() => {
    if ("sendTyping" in message.channel) {
      void message.channel.sendTyping().catch(() => undefined);
    }
  }, 8_000);
}
