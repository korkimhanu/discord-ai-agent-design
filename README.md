# Discord AI Coding Agent

Discord에서 일반 AI처럼 대화하고, GitHub repo 작업은 승인 기반으로 branch/PR까지 처리하는 코딩 봇입니다.

`index.html`은 설계 문서이고, `src/`는 실제 실행 가능한 봇 구현입니다.

## 기능

- Discord 자연어 메시지 응답
- `/repo`, `/model`, `/agent`, `/status` slash command
- GitHub repo clone
- AI가 unified diff 생성
- Discord 버튼으로 변경 승인
- 승인 후 patch 적용, 테스트/빌드, commit, push, PR 생성
- NAS 부하를 피하기 위한 `LOCAL_CHECKS=none/light/full`
- PR 생성 후 GitHub Actions check와 artifact 링크 Discord 알림
- API 없이 로그인된 Codex CLI / Claude Code CLI 사용
- 선택적으로 OpenAI / Claude API 모델 라우팅
- Synology NAS Docker 실행 지원

## 빠른 시작

```powershell
npm install
Copy-Item .env.example .env
```

`.env`를 채웁니다.

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=

GITHUB_TOKEN=

DEFAULT_MODEL=auto
DEFAULT_AGENT=auto
CLAUDE_CODE_COMMAND=claude
CODEX_COMMAND=codex
LOCAL_CHECKS=none
CI_POLL_SECONDS=180
```

OpenAI/Anthropic API를 쓸 때만 아래를 추가로 채웁니다.

```env
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

slash command 등록:

```powershell
npm run register
```

개발 실행:

```powershell
npm run dev
```

운영 빌드:

```powershell
npm run build
npm start
```

## Discord 설정

Discord Developer Portal에서 bot을 만들고 아래 권한을 켭니다.

- Message Content Intent
- Send Messages
- Read Message History
- Use Slash Commands

봇 초대 URL scope:

```text
bot applications.commands
```

권한은 최소한 아래가 필요합니다.

```text
Send Messages
Read Message History
Use Slash Commands
```

## GitHub 설정

MVP에서는 `GITHUB_TOKEN`을 쓰는 방식이 가장 빠릅니다.

권장 token 권한:

- repo
- workflow, Actions workflow 파일을 수정하거나 workflow 상태까지 다룰 경우

더 안전한 운영은 GitHub App입니다. 이 경우 `.env`에 아래 값을 넣습니다.

```env
GITHUB_APP_ID=
GITHUB_INSTALLATION_ID=
GITHUB_PRIVATE_KEY_BASE64=
```

`GITHUB_TOKEN`이 있으면 token을 우선 사용하고, 없으면 GitHub App credentials를 사용합니다.

## 사용법

Discord에서 먼저 repo를 지정합니다.

```text
/repo owner/repo
/model auto
/agent auto
```

그 다음 봇을 멘션하거나, thread 안에서 자연어로 요청합니다.

```text
@bot 로그인 테스트 깨지는 원인 찾아서 고쳐줘
```

봇은 diff를 만들고 버튼을 보여줍니다.

```text
Apply and PR
Reject
```

`Apply and PR`을 누르면:

1. patch 적용
2. `LOCAL_CHECKS` 설정에 따라 NAS에서 로컬 체크 실행 또는 생략
3. commit
4. branch push
5. PR 생성
6. GitHub Actions 상태와 artifact 링크를 Discord에 알림

## 빌드, 테스트, 스크린샷

NAS CPU가 약하면 앱 전체 빌드나 emulator 테스트를 NAS에서 돌리지 않는 편이 맞습니다.

권장값:

```env
LOCAL_CHECKS=none
```

모드:

```text
none  NAS에서 빌드/테스트 생략. GitHub Actions에 맡김.
light npm ci, lint, typecheck까지만 실행.
full  npm test, npm run build까지 NAS에서 실행.
```

권장 운영:

```text
NAS Worker:
- repo clone
- AI diff 생성
- patch 적용
- branch push
- PR 생성

GitHub Actions:
- full install
- full test
- full build
- emulator/browser smoke test
- screenshot/APK artifact 업로드

Discord Bot:
- PR 링크 전송
- Actions check 상태 전송
- artifact/APK/screenshot 링크 전송
```

이 repo에는 기본 `.github/workflows/ci.yml`이 들어 있습니다. 실제 앱 repo에도 비슷한 workflow가 있어야 봇이 PR 생성 후 CI와 artifact를 볼 수 있습니다.

웹앱은 Playwright를 추가해서 screenshot을 artifact로 올리는 식이 좋습니다.

```yaml
- run: npx playwright install --with-deps
- run: npx playwright test
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: screenshots
    path: test-results
```

Android 앱은 GitHub Actions에서 APK와 emulator screenshot을 artifact로 올립니다.

```yaml
- run: ./gradlew assembleDebug
- uses: actions/upload-artifact@v4
  with:
    name: app-debug-apk
    path: app/build/outputs/apk/debug/*.apk
```

Discord에는 APK 파일 자체를 직접 보내기보다 artifact 링크를 보내는 구조입니다.

## 모델과 에이전트

`/model`은 답변/판단 모델입니다.

```text
auto
strong
balanced
cheap
codex
claude-code
직접 모델명
```

`/agent`는 코드를 실제로 고치는 실행기입니다.

```text
api
claude-code
codex
auto
```

`auto`는 실행 환경에 따라 자동 선택합니다. `claude-code`는 `claude -p`, `codex`는 `codex exec`를 호출합니다.

## API 없이 로그인으로 쓰기

ChatGPT/Claude 웹 로그인을 봇이 직접 가져다 쓰는 방식은 아닙니다. 대신 터미널용 도구에 로그인해두고, 봇이 그 CLI를 호출합니다.

Codex 사용:

```powershell
codex --version
codex login
```

`.env`:

```env
DEFAULT_MODEL=auto
DEFAULT_AGENT=auto
CODEX_COMMAND=codex
```

Discord:

```text
/model codex
/agent codex
```

Claude Code 사용:

```powershell
claude --version
claude login
```

`.env`:

```env
DEFAULT_MODEL=claude-code
DEFAULT_AGENT=claude-code
CLAUDE_CODE_COMMAND=claude
```

Discord:

```text
/model claude-code
/agent claude-code
```

둘 다 설치되어 있으면 대화마다 바꿀 수 있습니다.

```text
/model codex
/agent claude-code
```

이 경우 일반 답변은 Codex CLI, repo 수정 diff 생성은 Claude Code CLI가 담당합니다.

`/model auto`와 `/agent auto`의 선택 순서:

```text
model auto:
1. codex CLI
2. claude CLI
3. OpenAI API
4. Anthropic API

agent auto:
1. codex CLI
2. claude CLI
3. api agent
```

## Synology NAS Docker

NAS Container Manager에서 이 repo를 배포하거나, SSH에서 실행합니다.

```bash
docker compose up -d --build
```

볼륨:

```text
./workspaces -> 작업 repo clone 위치
./.data      -> 세션/job 상태 저장
```

NAS를 외부에 직접 노출하지 않아도 됩니다. Discord와 GitHub로 outbound 연결만 필요합니다.

## 보안 정책

- 파일 읽기와 diff 생성은 자동
- 파일 수정, commit, push, PR 생성은 Discord 버튼 승인 후 실행
- main/master 직접 push는 하지 않고 `ai-agent/<job-id>` branch를 사용
- 작업 repo는 `workspaces/<job-id>`에 clone
- `.env`, `.data`, `workspaces`, `node_modules`, `dist`는 git에 올리지 않음

## 제한

- 모델이 올바른 unified diff를 반환해야 patch가 적용됩니다.
- repo별 test command는 현재 npm 프로젝트를 우선 지원합니다.
- Python/Gradle/Maven 등은 `worker.ts`의 `runProjectChecks`에 추가하면 됩니다.
- Claude Code/Codex CLI 모드는 NAS 또는 실행 환경에 별도로 설치/로그인되어 있어야 합니다.
- Docker 컨테이너 안에서 CLI 로그인 세션을 쓰려면 해당 CLI와 인증 파일을 컨테이너에 넣어야 합니다. NAS에서는 보통 host에 직접 Node로 실행하는 편이 먼저 쉽습니다.
