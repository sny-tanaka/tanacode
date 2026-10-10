<!-- 英語の README。日本語の README.md と同じ中身にそろえる（README.md を直したら、こちらも直す） -->
<!-- GitHub のスマホアプリは <picture> でのテーマの切り替えに対応していないので、どちらのテーマでも読める背景付きの 1 枚にする -->
<h1 align="center">
  <img src="design/logo-banner.png" width="520" alt="tanacode" />
</h1>

<h3 align="center">A macOS app that lets you see deep inside Claude Code</h3>

<p align="center">From the files Claude has read and what it remembers, to the tools its subagents called and the pages it checked in the browser.<br />Under the hood, it runs the same <code>claude</code> CLI you already use.</p>

<p align="center">
  <a href="https://github.com/sny-tanaka/tanacode/releases/latest"><img src="https://img.shields.io/github/v/release/sny-tanaka/tanacode?label=latest&color=2ea043" alt="Latest version" /></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-555555?logo=apple" alt="Supported macOS: 13 or later" />
  <a href="https://github.com/sny-tanaka/tanacode/actions/workflows/claude-code-check.yml"><img src="https://img.shields.io/badge/verified%20Claude%20Code-2.1.296-d4835c" alt="Verified Claude Code: 2.1.296" /></a>
  <img src="https://img.shields.io/badge/license-MIT-2f6fd6" alt="License: MIT" />
</p>

<p align="center">
  <a href="https://sny-tanaka.github.io/tanacode/"><b>Try the demo in your browser</b></a> ・
  <a href="#installation"><b>Installation</b></a> ・
  <a href="GUIDE.md"><b>User guide (Japanese)</b></a> ・
  <a href="README.md"><b>日本語</b></a>
</p>

A desktop app that brings Claude Code (the `claude` CLI) and an IDE together. While Claude works, it shows right next to the chat what Claude has read and remembers, what its subagents are doing, and what it checked on screen. Leave the coding to Claude; you just review and make small fixes.

The UI is available in English and Japanese. Switch it with **tanacode → Language** in the menu bar; by default it follows your Mac's language. The other documents ([GUIDE.md](GUIDE.md) and [CONTRIBUTING.md](CONTRIBUTING.md)) and the demo are in Japanese.

<sub>An unofficial tool made by an individual. It is not an official Anthropic product, and it is not endorsed or supported by Anthropic.</sub>

<p align="center">
  <img src="design/screenshot.png" width="100%" alt="The tanacode window (Japanese UI). In the Explorer, files Claude has read have a blue dot and files it wrote have an orange dot; the header shows the context meter; the chat shows why a type-check hook blocked an edit" />
</p>

## Try it in your browser first

Without installing anything, you can use the real UI in the [demo](https://sny-tanaka.github.io/tanacode/): an 8-chapter tour that follows one session from start to finish. If you only watch one chapter, try [What Claude knows](https://sny-tanaka.github.io/tanacode/#knowledge).

1. [Start a session](https://sny-tanaka.github.io/tanacode/#start)
2. [Give instructions and delegate](https://sny-tanaka.github.io/tanacode/#delegate)
3. [What Claude knows](https://sny-tanaka.github.io/tanacode/#knowledge)
4. [Check it in the browser](https://sny-tanaka.github.io/tanacode/#browser)
5. [Review and fix](https://sny-tanaka.github.io/tanacode/#review)
6. [Work in parallel](https://sny-tanaka.github.io/tanacode/#parallel)
7. [Wrap up and look back](https://sny-tanaka.github.io/tanacode/#wrapup)
8. [Around the app](https://sny-tanaka.github.io/tanacode/#app)

<sub>The demo runs on made-up data and does not connect to the real Claude. Its text is in Japanese.</sub>

## See what's going on inside

### What Claude has read and what it remembers

In the Explorer, files Claude has read in the current conversation get a blue dot, and files it wrote get an orange dot. Files that compaction replaced with a summary get a hollow dot. The header shows how much of the context is in use. The context is listed by kind (files read, tool results, subagent results, and so on), each with a bar showing its approximate size. You can also choose what to keep and what to drop when you compact. Hook output and the reasons hooks blocked something appear under the edit card.

[See it in the demo →](https://sny-tanaka.github.io/tanacode/#knowledge)

### What subagents and workflows are doing

Subagents, workflows, and background Bash commands line up above the input box while they run, and you can stop them from there. Open one to see each agent's conversation, down to every tool call. Workflows are drawn as a diagram of phases and agents, so you can follow what each agent did, one by one.

[See it in the demo →](https://sny-tanaka.github.io/tanacode/#parallel)

### What Claude looked at and checked on screen

Preview the page you're developing inside the app. Click an element to attach its selector, HTML, and a cropped image straight to your prompt. Console errors go to the input box with one click. After a fix, Claude opens the page in the same browser and checks it itself with screenshots, the console, and clicks. Elements get an orange outline before Claude clicks them, so you can see what it's doing (via MCP, with nothing extra to install; it can only open development hosts such as localhost). For things Claude can't do, like logging in, it asks you in the middle of its work. When you're done, press a button and Claude picks up where it left off.

[See it in the demo →](https://sny-tanaka.github.io/tanacode/#browser)

## Still the Claude Code you know

- It runs the `claude` CLI you've already installed. Your skills, CLAUDE.md, hooks, and MCP settings **all keep working**
- **Claude Code keeps running** after you close the app. You can continue from your phone with Remote Control
- It **never writes** to your Claude Code settings (such as `~/.claude/settings.json`). tanacode itself has no way of sending your data anywhere
- It's **checked automatically every day** against the latest Claude Code. If your Claude Code differs from the verified version, a mark in the status bar tells you
- Conversations you started in the terminal **can be imported**
- Instead of the chat, you can also **use Claude Code's own terminal screen**. The MCP servers tanacode adds, the side panel, and the editor all keep working

## And more

- **While Claude works**: tool calls collapse into a single line. Answer questions and permission prompts with buttons in the chat ([demo](https://sny-tanaka.github.io/tanacode/#delegate))
- **Review before you push**: see the changes since the branch point (including committed ones) in a pull-request-like list. Comments you leave on diff lines go to Claude with your next prompt ([demo](https://sny-tanaka.github.io/tanacode/#review))
- **Work in parallel**: marks in the session list tell sessions apart by state (working, waiting for background tasks, waiting for an answer, new response), and macOS notifications tell you when a session you're not looking at finishes or needs you. Each session can get its own folder and branch with `claude --worktree`, and tanacode takes care of setting up `node_modules`. Claude in a parent session can also split work across child sessions ([demo](https://sny-tanaka.github.io/tanacode/#parallel))
- **Checklists shared with Claude**: named lists per session, such as to-dos, conditions to meet, things for you to do, or points to confirm. They live outside the conversation, so compaction doesn't erase them. For multi-step work, Claude adds items through MCP without being asked and checks off what it has verified. Replies to a card become a thread, and you can notify Claude. You can also copy cards to another session
- **Walkthroughs**: like a code review over screen share, Claude opens code in the editor and explains the intent of a change while showing it. You move on with Next at your own pace and ask about any lines right there. The explanation can also be posted to a GitHub PR as a single comment with the code embedded
- **Scheduled messages**: send a prompt you've written at a set time (like Slack's scheduled messages). When the time comes, tanacode waits until Claude Code is free and then sends it
- **Wrap up and look back**: export the session as a single HTML file that looks just like the chat ([demo](https://sny-tanaka.github.io/tanacode/#wrapup)). With the Japanese UI, you can also translate Claude's thinking and responses into Japanese with one button (on your Mac with macOS's built-in translation; nothing is sent out; macOS 15 or later)
- **English and Japanese**: the UI is available in English and Japanese. Switch it with **tanacode → Language** in the menu bar. By default it follows your Mac: Japanese if Japanese is among your preferred languages, otherwise English. The new language takes effect when tanacode restarts
- **Account, usage limits, and the app itself**: always shows your plan, how much of the 5-hour and weekly limits you've used and when they reset, and this Mac's CPU and memory usage. You can keep separate Claude Code accounts (profiles), such as work and personal, and switch between them in one window. A mark in the title bar tells you when a new version of tanacode is out ([demo](https://sny-tanaka.github.io/tanacode/#app))

There's more, such as restarting just Claude Code while keeping the conversation, the Monaco editor, a terminal, and git operations. See [GUIDE.md](GUIDE.md) (Japanese) for details.

## Requirements

- macOS 13 or later (Apple Silicon or Intel)
- [Claude Code](https://code.claude.com/docs) (the `claude` CLI)
  - Run `claude` in a terminal once and finish the first-time setup (choosing a theme and logging in)
  - The version verified with tanacode is 2.1.296. If yours is different, the version in the status bar gets a warning mark (hover over it to see why)
  - Compatibility with the latest Claude Code is checked automatically every day. Even so, a Claude Code update may break some of the display or controls

## Installation

### Homebrew (recommended)

```bash
brew install --cask sny-tanaka/tanacode/tanacode
```

If you install with [Homebrew](https://brew.sh/), the app can install new versions by itself (see "Updating" below). It installs the zip from [Releases](https://github.com/sny-tanaka/tanacode/releases) that matches your Mac (Apple Silicon or Intel). macOS shows no warning even though the app isn't signed by Apple, because the cask in the tap ([sny-tanaka/homebrew-tanacode](https://github.com/sny-tanaka/homebrew-tanacode)) removes the download mark (the quarantine attribute) from tanacode.app only, every time it installs or updates. Homebrew does the same thing as the `xattr` step in the zip instructions below for you.

### Prebuilt app (Releases)

Download the one that matches your Mac from [Releases](https://github.com/sny-tanaka/tanacode/releases).

| Mac | File |
| --- | --- |
| Apple Silicon (M1 or later) | `tanacode-<version>-mac-arm64.pkg` (or `.zip`) |
| Intel | `tanacode-<version>-mac-x64.pkg` (or `.zip`) |

> **About signing**
>
> Because this is an individual project, the app isn't signed or notarized by Apple (it's signed with a self-signed certificate). macOS shows a warning the first time only; allow it with the steps below.
>
> Every version is signed with the same certificate, so updates are treated as the same app. Permissions you've already granted, such as folder access and notifications, are kept.

<details>
<summary>Installing with the installer (pkg)</summary>

1. Open the pkg. It isn't signed or notarized by Apple, so the first time you'll see a message such as "cannot be opened" or "Apple could not verify". Close it with "Done"
2. In System Settings → Privacy & Security, scroll down and click "Open Anyway" for tanacode
3. Follow the installer (you'll enter your Mac's password along the way). The app goes into the Applications folder

Apps installed with the installer don't get the download mark, so you can launch it right away.

</details>

<details>
<summary>Installing from the zip</summary>

1. Open the zip and move `tanacode.app` to the Applications folder
2. It isn't signed or notarized by Apple, so as it is, macOS says it "is damaged and can't be opened" and won't launch it. Run the following command in a terminal once to remove the download mark

   ```bash
   xattr -dr com.apple.quarantine /Applications/tanacode.app
   ```

   This command removes, from tanacode.app only, the mark (the quarantine attribute) that macOS puts on downloaded apps so they're checked before they run. Don't use it on files you got from anywhere other than Releases.

</details>

### Build from source

Apps you build yourself don't get the download mark, so macOS shows no warning even without Apple's signature.

Requirements: Node.js 24, git, and the Xcode Command Line Tools (for `swiftc`, used by the chat translation; you can build without it, and the translation button just won't appear)

```bash
git clone https://github.com/sny-tanaka/tanacode.git
cd tanacode
npm install
npm run install-app
```

This builds the app and installs it to `/Applications/tanacode.app`, for whichever Mac you're on (Apple Silicon or Intel).

### Updating

When a new version is out, a blue download mark appears to the right of the version in the title bar (tanacode checks GitHub Releases every hour). You can also get notified with Watch → Custom → Releases on the repository.

- **If you installed with Homebrew**: updates are automatic. When tanacode finds a new version, it runs `brew update` and `brew fetch` in the background to download it, then shows "Restart to Update" in the title bar.
  - Clicking "Restart to Update" quits tanacode, replaces it with Homebrew, and starts it again. If some sessions have Claude Code running, you can choose to update and keep them running, or stop them and update. If you keep them running, new Claude tools added in the new version become available after you restart each session with "Restart" in the chat header
  - Even if you don't click it, the update is installed when you quit normally (the next launch is the new version). To turn this off, uncheck **tanacode → Install Updates on Quit (Homebrew)** in the menu bar
  - The replacement happens after tanacode has quit; the running app is never replaced. Homebrew's confirmation (y/n) is skipped
  - If the update fails, tanacode tells you why on the next launch. If macOS blocked it, allow tanacode in System Settings → Privacy & Security → App Management
  - To update manually, quit with **File → Stop Claude Code and Quit** in the menu bar, then run

    ```bash
    brew update && brew upgrade --cask tanacode
    ```

    `brew update` refreshes your local copy of the tap. The cask in the tap is updated a few minutes after a new version is published. Homebrew updates itself automatically once every 24 hours (if you've turned that off with `HOMEBREW_NO_AUTO_UPDATE`, nothing changes until you run `brew update`), so right after a release, `brew upgrade` alone may say you're already up to date

- **If you installed a prebuilt app**: before installing the new version, quit with **File → Stop Claude Code and Quit** in the menu bar, so that replacing the app doesn't cut off a running Claude Code

- **If you installed from source**: run the following, then quit tanacode, choose "Quit and Keep Running" in the quit dialog, and start it again. The running Claude Code isn't stopped, and the new version takes it over as is

  ```bash
  git pull
  npm install
  npm run install-app
  ```

### Uninstalling

Quit with **File → Stop Claude Code and Quit** in the menu bar, then delete the following.

- `/Applications/tanacode.app`
- `~/Library/Application Support/tanacode/`

If you installed with Homebrew, quit and run `brew uninstall --cask --zap tanacode` to remove both.

Claude Code's conversation logs (`~/.claude/`) belong to Claude Code, so they stay.

## Documentation

| Document | Contents |
| --- | --- |
| [GUIDE.md](GUIDE.md) (Japanese) | Getting started, the layout of the window, how to use each feature, shortcuts, how your data is handled, limitations, troubleshooting |
| [CONTRIBUTING.md](CONTRIBUTING.md) (Japanese) | Building from source, how to contribute, how it works, how the source is organized |

Report bugs and request features in [Issues](https://github.com/sny-tanaka/tanacode/issues). English is welcome.

## License

[MIT](LICENSE)

For the licenses of bundled dependencies, see `Contents/Resources/THIRD_PARTY_NOTICES.txt` inside the app.

<sub>"Claude" and "Claude Code" are trademarks of Anthropic, PBC.</sub>
