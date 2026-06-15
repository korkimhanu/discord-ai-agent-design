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
      if (!shouldRespond(message, client.user?.id)) return;
      const sessionKey = makeSessionKey(message);
      const session = store.getSession(sessionKey);
      const content = cleanMention(message.content, client.user?.id).trim();
      if (!content) return;
      if (!session.repo && looksLikeCodingRequest(content)) {
        await message.reply("먼저 `/repo owner/name`으로 작업할 GitHub repo를 설정하세요.");
        return;
      }
      if (looksLikeCodingRequest(content) && session.repo) {
        const now = new Date().toISOString();
        const job: Job = {
          id: crypto.randomBytes(4).toString("hex"),
          sessionKey,
          channelId: message.channelId,
          threadId: message.channel.isThread() ? message.channel.id : undefined,
          userId: message.author.id,
          repo: session.repo,
          prompt: content,
          model: session.model,
          agent: session.agent,
          status: "queued",
          createdAt: now,
          updatedAt: now
        };
        await message.reply(`작업을 큐에 넣었습니다. job=${job.id}`);
        await worker.enqueue(job);
        return;
      }

      const reply = await models.complete({
        model: session.model,
        system: "You are a concise Korean assistant inside Discord. Keep replies practical.",
        prompt: `Session summary:\n${session.summary}\n\nUser:\n${content}`
      });
      await message.reply(reply.text.slice(0, 1900));
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
      content: [`repo=${session.repo ?? "unset"}`, `model=${session.model}`, `agent=${session.agent}`].join("\n"),
      ephemeral: true
    });
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
  return /(고쳐|수정|구현|추가|테스트|빌드|PR|repo|레포|버그|fix|implement|build|test)/i.test(content);
}

function makeSessionKey(message: Message): string {
  const thread = message.channel.isThread() ? message.channel.id : message.channelId;
  return `${message.guildId ?? "dm"}:${thread}:${message.author.id}`;
}

function makeInteractionSessionKey(interaction: ChatInputCommandInteraction): string {
  return `${interaction.guildId ?? "dm"}:${interaction.channelId}:${interaction.user.id}`;
}
